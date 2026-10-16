const mainHost = 'panel.rex-custom.invalid';
const prefix = 'rxp-';
const suffix = '.rex-custom.invalid';
const sampleBytes = 1024 * 1024;
const encoder = new TextEncoder();
function ipNum(ip) { return ip.split('.').reduce((n,p)=>n*256+Number(p),0); }
function ipText(n) { return [24,16,8,0].map(bits=>Math.floor(n/2**bits)%256).join('.'); }
export function candidatesFromInput(input, validate, maxCandidates = 64) {
  if(typeof input!=='string'||input.length>12000)throw Error('请输入 IPv4 地址或 CIDR 网段（最多 12000 字）。');
  for(const m of input.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}:(\d+)/g))if(Number(m[1])!==443)throw Error('面板正式入口只支持 443 端口；请移除其它端口，未将其冒充 443 测试。');
  input=input.replace(/(\b(?:\d{1,3}\.){3}\d{1,3}):443\b/g,'$1');
  const tokens=input.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?/g)||[];
  const rows=new Map();
  for(const token of tokens){
    const [ip,rawBits]=token.split('/');
    if(!validate(ip))throw Error('输入包含非 Cloudflare 官方 IPv4：'+ip);
    const bits=rawBits===undefined?32:Number(rawBits);
    if(bits<12||bits>32)throw Error('CIDR 前缀只支持 /12 至 /32。');
    const size=2**(32-bits),base=Math.floor(ipNum(ip)/size)*size;
    const offsets=size===1?[0]:[1,Math.floor(size/4),Math.floor(size/2),Math.floor(size*3/4)];
    for(const offset of new Set(offsets)){const value=ipText(base+offset);if(validate(value))rows.set(value,{ip:value,...(bits<32?{sampledFrom:ipText(base)+'/'+bits}: {})});}
  }
  if(!rows.size)throw Error('未找到 Cloudflare 官方 IPv4；当前入口测速不支持 IPv6 或第三方 CNAME。');
  if(rows.size>maxCandidates)throw Error(maxCandidates===12?'本批最多准备 12 个地址；请刷新面板以使用自动分批。':'一次最多接受 '+maxCandidates+' 个候选；每个 CIDR 抽样 4 个。');
  return [...rows.values()];
}
function probeHost(ip, session){return prefix+ip.replaceAll('.','-')+(session?'-'+session:'')+suffix;}
async function key(env,usage){return crypto.subtle.importKey('raw',encoder.encode('rex-entry-probe-v1:'+env.ADMIN_TOKEN),{name:'HMAC',hash:'SHA-256'},false,[usage]);}
async function sign(host,expires,env){const bytes=await crypto.subtle.sign('HMAC',await key(env,'sign'),encoder.encode(host+'|'+expires));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function validSignature(host, expires, signature, env) {
 if(!/^[a-f0-9]{64}$/.test(signature||''))return false;
 return crypto.subtle.verify('HMAC',await key(env,'verify'),Uint8Array.from(signature.match(/../g).map(v=>parseInt(v,16))),encoder.encode(host+'|'+expires));
}
const leaseComment = (session, expires) => 'Rex temporary probe v2; session='+session+'; expires='+expires;
async function dnsApi(env, query, body) {
 if(!env.CF_DNS_API_TOKEN||env.CF_DOMAIN!==mainHost||!/^[a-f0-9]{32}$/.test(env.CF_ZONE_ID||''))throw Error('测速 DNS 权限尚未配置。');
 const r=await fetch('https://api.cloudflare.com/client/v4/zones/'+env.CF_ZONE_ID+'/dns_records'+query,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.CF_DNS_API_TOKEN,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!r.ok||!j.success)throw Error('测速 DNS 操作失败（'+(j.errors||[]).map(e=>e.code).join(',')+'），未确认的清理会由过期任务重试。');return j;
}
async function probeRecords(env) {
 const rows=[];for(let page=1;page<=20;page++){const j=await dnsApi(env,'?name.startswith=rxp-&per_page=100&page='+page);rows.push(...j.result);if(page>=(j.result_info?.total_pages||1))return rows;}
 throw Error('辅助记录分页超限，停止操作。');
}
function ownedLease(record) {
 const match=/^Rex temporary probe v2; session=([a-f0-9]{12}); expires=(\d{10})$/.exec(record.comment||'');
 return match&&record.type==='A'&&record.proxied===false&&record.name===probeHost(record.content,match[1])?{session:match[1],expires:Number(match[2])}:null;
}
async function removeRecords(env, rows) {
 for(let i=0;i<rows.length;i+=100)await dnsApi(env,'/batch',{deletes:rows.slice(i,i+100).map(r=>({id:r.id}))});
 return rows.length;
}
const probeReadyUntil=new Map();
const stableComment='Rex temporary browser probe v3; shared lease managed';
function ownedStable(r){return r.type==='A'&&r.proxied===false&&r.comment===stableComment&&r.name===probeHost(r.content);}
async function sessionTable(env){await env.DB.exec('CREATE TABLE IF NOT EXISTS rex_probe_sessions (session TEXT PRIMARY KEY, expires INTEGER NOT NULL, ips TEXT NOT NULL)');}
async function acquireProbeLock(env){
 await env.DB.exec('CREATE TABLE IF NOT EXISTS rex_probe_dns_lock (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, expires INTEGER NOT NULL)');const holder=crypto.randomUUID();
 for(let attempt=0;attempt<20;attempt++){const now=Date.now();const row=await env.DB.prepare('INSERT INTO rex_probe_dns_lock (id,holder,expires) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE rex_probe_dns_lock.expires <= ? RETURNING holder').bind(holder,now+90000,now).first();if(row?.holder===holder)return async()=>{await env.DB.prepare('DELETE FROM rex_probe_dns_lock WHERE holder = ?').bind(holder).run();};await new Promise(resolve=>setTimeout(resolve,250));}
 throw Error('另一个测速任务正在准备或清理解析，请稍后重试。');
}
async function activeProbeIps(env,now=Math.floor(Date.now()/1000)){
 await sessionTable(env);const {results}=await env.DB.prepare('SELECT ips FROM rex_probe_sessions WHERE expires > ?').bind(now).all();
 return new Set(results.flatMap(r=>{try{return JSON.parse(r.ips);}catch{return [];}}));
}
export async function sweepEntryProbes(env,now=Math.floor(Date.now()/1000)){
 const unlock=await acquireProbeLock(env);try{await sessionTable(env);await env.DB.prepare('DELETE FROM rex_probe_sessions WHERE expires <= ?').bind(now).run();const active=await activeProbeIps(env,now);
 return await removeRecords(env,(await probeRecords(env)).filter(r=>ownedStable(r)?!active.has(r.content):(ownedLease(r)?.expires<=now)));}finally{await unlock();}
}
export async function cleanupEntryProbes(request,env){
 try{
  const {session,expires,signature}=await request.json();
  if(!/^[a-f0-9]{12}$/.test(session||'')||!/^\d{10}$/.test(String(expires))||!await validSignature('lease-'+session,String(expires),signature,env))return Response.json({success:false,error:'无效的临时解析清理凭据。'},{status:403});
  const unlock=await acquireProbeLock(env);try{await sessionTable(env);await env.DB.prepare('DELETE FROM rex_probe_sessions WHERE session = ?').bind(session).run();const active=await activeProbeIps(env);
  const removable=r=>{const lease=ownedLease(r);return ownedStable(r)?!active.has(r.content):lease&&lease.session===session&&lease.expires===Number(expires);};
  const removed=await removeRecords(env,(await probeRecords(env)).filter(removable));const remaining=(await probeRecords(env)).filter(removable).length;
  if(remaining)throw Error('临时解析未全部清理，过期任务将重试。');return Response.json({success:true,removed,remaining},{headers:{'Cache-Control':'no-store'}});}finally{await unlock();}
 }catch(error){return Response.json({success:false,error:error.message},{headers:{'Cache-Control':'no-store'}});}
}
export async function waitProbeDns(host,ip){
 const checks=[];
 for(const [resolver,endpoint]of [['cloudflare','https://cloudflare-dns.com/dns-query?name='],['google','https://dns.google/resolve?name=']]){
  try{const r=await fetch(endpoint+encodeURIComponent(host)+'&type=A',{headers:{Accept:'application/dns-json','Cache-Control':'no-cache'},signal:AbortSignal.timeout(1500)});const j=await r.json();const ready=r.ok&&j.Status===0&&!!j.Answer?.some(a=>a.type===1&&a.data===ip);checks.push({resolver,http:r.status,rcode:j.Status,ready});if(ready)return{ready:true,source:resolver,checks};}
  catch{checks.push({resolver,ready:false,reason:'resolver-request-failed'});}
 }
 return{ready:false,checks,reason:checks.every(c=>c.rcode===3)?'nxdomain':checks.some(c=>c.reason)?'resolver-timeout':'no-matching-address'};
}
async function diagnoseProbeEdge(host){
 try{
  const r=await fetch('https://'+host+'/cdn-cgi/trace',{redirect:'manual',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(2500)});
  const reader=r.body?.getReader();let text='',bytes=0;if(reader){try{while(bytes<4096){const {value,done}=await reader.read();if(done)break;bytes+=value.length;text+=new TextDecoder().decode(value.subarray(0,4096));}}finally{await reader.cancel().catch(()=>{});}}
  return{scope:'cloud-edge-check-not-client-speed',status:r.status,code:/error code:\s*(1\d{3})/i.exec(text)?.[1]||null};
 }catch{return{scope:'cloud-edge-check-not-client-speed',status:0,reason:'cloud-check-unavailable'};}
}
export async function prepareEntryProbes(request,env,validate){
 try{
  const body=await request.json();
  const rows=body.planOnly===true&&Array.isArray(body.inputs)
   ? [...new Map(body.inputs.slice(0,512).flatMap(value=>{try{return candidatesFromInput(String(value),validate);}catch(error){return [{ip:String(value).slice(0,100),error:String(value).startsWith('[')?'IPv6 不支持；已跳过':error.message+'；已跳过'}];}}).map(row=>[row.ip,row])).values()].slice(0,512)
   : candidatesFromInput(body.input,validate,body.planOnly===true?512:12);
  if(body.planOnly===true)return Response.json({success:true,candidates:rows,batchSize:12,bytes:sampleBytes},{headers:{'Cache-Control':'no-store'}});
  if(body.checkLease){
   const lease=body.checkLease;
   if(!/^[a-f0-9]{12}$/.test(lease.session||'')||!await validSignature('lease-'+lease.session,String(lease.expires),lease.signature,env))return Response.json({success:false,error:'无效的测速会话。'},{status:403});
   const readiness=await Promise.all(rows.map(async row=>{const host=probeHost(row.ip,lease.style==='stable'?undefined:lease.session);const dns=await waitProbeDns(host,row.ip);return {...dns,...(body.diagnose?{edge:await diagnoseProbeEdge(host)}:{})};}));
   return Response.json({success:true,probes:rows.map((row,i)=>({...row,dnsReady:readiness[i].ready,dnsState:readiness[i],edge:readiness[i].edge}))},{headers:{'Cache-Control':'no-store'}});
  }
  const unlock=await acquireProbeLock(env);let locked=true;try{
  const records=await probeRecords(env);
  if(records.filter(r=>ownedStable(r)||ownedLease(r)).length+rows.length>128)throw Error('同时进行的测速过多，请稍后重试。');
  const session=crypto.randomUUID().replaceAll('-','').slice(0,12),expires=String(Math.floor(Date.now()/1000)+600);
  const fresh=body.freshHost===true;const hostFor=ip=>probeHost(ip,fresh?session:undefined);
  const lease={session,expires,signature:await sign('lease-'+session,expires,env),style:fresh?'session':'stable'};
  const posts=[];
  for(const row of rows){const existing=records.filter(r=>r.name===hostFor(row.ip));if(existing.length&&!existing.every(r=>r.type==='A'&&r.content===row.ip&&!r.proxied))throw Error('测速域名已有不同配置，未覆盖。');if(!existing.length)posts.push({type:'A',name:hostFor(row.ip),content:row.ip,ttl:60,proxied:false,comment:fresh?leaseComment(session,expires):stableComment});}
  await sessionTable(env);await env.DB.prepare('INSERT INTO rex_probe_sessions (session,expires,ips) VALUES (?,?,?)').bind(session,Number(expires),JSON.stringify(rows.map(r=>r.ip))).run();
  const warmIps=new Set(!fresh&&Array.isArray(body.warmIps)?body.warmIps.filter(ip=>rows.some(r=>r.ip===ip)):[]);
  try{
  if(posts.length)await dnsApi(env,'/batch',{posts});await unlock();locked=false;
  const settleMs=Math.max(0,...rows.map(row=>{if(!fresh&&(warmIps.has(row.ip)||probeReadyUntil.get(row.ip)>Date.now()))return 0;if(posts.some(r=>r.content===row.ip))return 3000;const existing=records.find(r=>r.name===hostFor(row.ip));const created=Date.parse(existing?.created_on||'');return Number.isFinite(created)?Math.max(0,3000-(Date.now()-created)):0;}));if(settleMs>0)await new Promise(resolve=>setTimeout(resolve,settleMs));
  const readiness=await Promise.all(rows.map(row=>warmIps.has(row.ip)?{ready:true,source:'recent-success-in-this-browser'}:waitProbeDns(hostFor(row.ip),row.ip)));
  for(const [ip,until]of probeReadyUntil)if(until<=Date.now())probeReadyUntil.delete(ip);for(const [i,row]of rows.entries())if(readiness[i].ready){if(probeReadyUntil.size>=256)probeReadyUntil.delete(probeReadyUntil.keys().next().value);probeReadyUntil.set(row.ip,Date.now()+45000);}
  const result=[];for(const [i,row] of rows.entries()){const host=hostFor(row.ip);result.push({...row,dnsReady:readiness[i].ready,dnsState:readiness[i],url:'https://'+host+'/__rex_probe/'+expires+'/'+await sign(host,expires,env)+'?session='+session});}
  return Response.json({success:true,bytes:sampleBytes,lease,probes:result},{headers:{'Cache-Control':'no-store'}});
  }catch(error){if(locked){await unlock();locked=false;}await cleanupEntryProbes(new Request('https://'+mainHost+'/api/cleanup-entry-probes',{method:'POST',body:JSON.stringify(lease)}),env);throw error;}
  }finally{if(locked)await unlock();}
 }catch(error){return Response.json({success:false,error:error.message},{headers:{'Cache-Control':'no-store'}});}
}
export function probePayload(request,extraHeaders={}) {
 const raw=new URL(request.url).searchParams.get('bytes');
 const size=raw===null?sampleBytes:Number(raw);
 if(![2048,sampleBytes,4194304,8388608].includes(size))return new Response('Invalid sample size',{status:400,headers:extraHeaders});
 const bytes=new Uint8Array(size);for(let offset=0;offset<bytes.length;offset+=65536)crypto.getRandomValues(bytes.subarray(offset,Math.min(bytes.length,offset+65536)));
 return new Response(bytes,{headers:{...extraHeaders,'Content-Type':'application/octet-stream','Content-Length':String(size),'Cache-Control':'no-store, no-transform','Timing-Allow-Origin':'https://'+mainHost,'X-Content-Type-Options':'nosniff'}});
}

export async function serveEntryProbe(request,env,validate){
 const url=new URL(request.url),match=/^rxp-((?:\d{1,3}-){3}\d{1,3})(?:-[a-f0-9]{12})?\.rex-custom\.invalid$/.exec(url.hostname),path=/^\/__rex_probe\/(\d+)\/([a-f0-9]{64})$/.exec(url.pathname);
 const ip=match?.[1].replaceAll('-','.');
 const headers={'Access-Control-Allow-Origin':'https://'+mainHost,'Access-Control-Expose-Headers':'X-Rex-Probe-IP, Content-Length','Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff'};
 if(request.method!=='GET'||!match||!path||!validate(ip)||!env.ADMIN_TOKEN)return new Response('Not found',{status:404,headers});
 const now=Math.floor(Date.now()/1000),expires=Number(path[1]);
 if(expires<now||expires>now+660)return new Response('Expired',{status:403,headers});
 const signature=Uint8Array.from(path[2].match(/../g).map(v=>parseInt(v,16)));
 const valid=await crypto.subtle.verify('HMAC',await key(env,'verify'),signature,encoder.encode(url.hostname+'|'+path[1]));
 if(!valid)return new Response('Forbidden',{status:403,headers});
 return probePayload(request,{...headers,'X-Rex-Probe-IP':ip});
}

export const currentComparisonMarkup = '<tr id="rexCurrentCompare" style="background:rgba(0,160,255,.09)"><td style="text-align:center"><input type="checkbox" disabled aria-label="当前入口对比，不参与 DNS 提交"></td><td><strong>panel.rex-custom.invalid</strong><div style="color:#38bdf8;margin-top:5px">当前入口对比</div></td><td id="rexCompareLatency">待测</td><td id="rexCompareSpeed">等待测速…</td><td><div id="rexCompareDns">读取当前解析…</div><small id="rexDnsAction" style="display:block;margin-top:6px;color:#94a3b8">DNS 缓存可能影响当前连接。</small></td><td><button type="button" id="rexCompareButton" class="btn-small">重测当前入口</button></td></tr>';


// All entry points use one bounded queue. No raw-IP HTTPS or fabricated timing.
export const probeClientSource = String.raw`let probeSequence=0,probeCancelled=false;const probeControllers=new Set();
function checkProbeCancelled(){if(probeCancelled){const error=Error('测速已停止');error.name='AbortError';throw error;}}
const pauseProbe=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function probeSample(item,bytes,timeout=12000,onProgress){
 checkProbeCancelled();
 const url=item.url+(item.url.includes('?')?'&':'?')+'bytes='+bytes+'&sample='+(++probeSequence);
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeout),start=performance.now();
 probeControllers.add(c);
 try{
  const response=await fetch(url,{mode:'cors',credentials:item.control?'same-origin':'omit',cache:'no-store',signal:c.signal});
  const headersAt=performance.now();
  if(!response.ok)throw Error('HTTP '+response.status+'；未通过入口验证');
  if(!item.control&&response.headers.get('X-Rex-Probe-IP')!==item.ip)throw Error('响应未到达本 Worker');
  let received=0,lastProgress=headersAt;
  if(response.body?.getReader){const reader=response.body.getReader();while(true){const chunk=await reader.read();if(chunk.done)break;received+=chunk.value.byteLength;if(onProgress&&performance.now()-lastProgress>=125){lastProgress=performance.now();const elapsed=lastProgress-headersAt;onProgress(received,{total:bytes,percent:received/bytes*100,Mbps:elapsed>0?received*8/(elapsed*1000):0});}}}
  else received=(await response.arrayBuffer()).byteLength;
  const end=performance.now();if(received!==bytes)throw Error('数据不完整（'+received+'/'+bytes+' 字节）');
  // TAO exposes network timestamps; fallback still excludes DNS, TLS and TTFB from transfer time.
  const entry=performance.getEntriesByName?.(url).at(-1);
  const timed=entry&&entry.responseStart>0&&entry.responseEnd>entry.responseStart&&entry.encodedBodySize===bytes;
  const bodyMs=timed?entry.responseEnd-entry.responseStart:end-headersAt;
  const rtt=timed&&entry.requestStart>0?entry.responseStart-entry.requestStart:headersAt-start;
  if(bodyMs<=0&&bytes>2048)throw Error('测速时间不足，请重测');
  return {rtt,bodyMs,totalMs:end-start,bytes,Mbps:bodyMs>0?bytes*8/(bodyMs*1000):0,timing:timed?'resource-timing':'fetch-body'};
 }finally{clearTimeout(timer);probeControllers.delete(c);}
}
async function warmConnection(item,stage=()=>{}){
 stage('建立连接（不计入延迟/速度）…');
 let connected=false;
 for(let attempt=0;attempt<2;attempt++){
  try{await probeSample(item,2048,3000);connected=true;break;}
  catch(error){if(probeCancelled)throw error;if(!(error instanceof TypeError)&&error.name!=='AbortError')throw error;if(attempt===1)throw error;stage(error.name==='AbortError'?'HTTPS 请求超时，重试 1/1…':'浏览器未取得 HTTPS 响应，重试 1/1…');await pauseProbe(500);}
 }
 if(!connected)throw Error('连接未完成');
 stage('测量热连接响应…');const rtts=[];
 for(let i=0;i<3;i++)rtts.push((await probeSample(item,2048,5000)).rtt);
 rtts.sort((a,b)=>a-b);
 return Math.round(rtts[1]);
}
async function measureConnection(item,stage=()=>{}){
 const latencyMs=Number.isFinite(item.warmLatencyMs)?item.warmLatencyMs:await warmConnection(item,stage);item.warmLatencyMs=latencyMs;if(item.onLatency)item.onLatency(latencyMs);
 stage('独立下载 4 MiB…');let transfer=await probeSample(item,4194304,15000,(n,p)=>stage('正在下载 '+(n/1048576).toFixed(2)+' / 4 MiB · '+p.percent.toFixed(0)+'% · '+(p.Mbps/8).toFixed(2)+' MB/s（'+p.Mbps.toFixed(2)+' Mbps）',p));
 if(transfer.bodyMs<80){stage('链路较快，追加 8 MiB 采样…');transfer=await probeSample(item,8388608,15000,(n,p)=>stage('正在下载 '+(n/1048576).toFixed(2)+' / 8 MiB · '+p.percent.toFixed(0)+'% · '+(p.Mbps/8).toFixed(2)+' MB/s（'+p.Mbps.toFixed(2)+' Mbps）',p));}
 return {...transfer,latencyMs};
}
`;


export const panelControlsMarkup = `<style>
#rexPanelProbe{border:1px solid #16566c;border-radius:14px;padding:18px;margin:14px 0;background:rgba(0,170,220,.045)}
#rexPanelProbe .rex-probe-grid{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:14px;margin-top:14px}
#rexPanelProbe label{display:block;font-size:13px;color:#94a3b8}#rexPanelProbe input,#rexPanelProbe select{box-sizing:border-box;display:block;width:100%;padding:10px;margin-top:6px;background:#0c1a29;color:#e2e8f0;border:1px solid #275369;border-radius:8px;font:inherit}
#rexPanelProbe button,#rexPanelProbe .rex-file-button{display:inline-block;border:1px solid #138da5;border-radius:8px;padding:9px 14px;background:#0d3041;color:#c6f5ff;font:inherit;cursor:pointer}
#rexPanelProbe button:disabled{opacity:.5;cursor:default}#rexPanelProbe .rex-probe-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
#rexPanelProbe .rex-file-button input{display:none}.rex-download-progress{display:block;width:100%;max-width:300px;height:7px;margin-top:8px;accent-color:#00d2e3}
@media(max-width:800px){#rexPanelProbe .rex-probe-grid{grid-template-columns:repeat(2,minmax(110px,1fr))}}
</style><div id="rexPanelProbe"><strong>面板节点测速</strong><div class="rex-probe-grid">
<label>测试预设<select id="rexProbePreset"><option value="quick">快速 · 10 个 / 1 MB/s / 1000 ms</option><option value="standard">标准 · 20 个 / 2 MB/s / 500 ms</option><option value="quality">高质量 · 50 个 / 5 MB/s / 200 ms</option><option value="custom">自定义</option></select></label>
<label>测试数量<input id="rexProbeCount" type="number" min="1" max="100" value="10"></label>
<label>速度下限 · MB/s<input id="rexProbeMinSpeed" type="number" min="0" max="10000" step="0.1" value="1"></label>
<label>热连接响应上限 · ms<input id="rexProbeMaxLatency" type="number" min="1" max="10000" value="1000"></label>
<label>结果排序<select id="rexProbeSort"><option value="speed">下载速度优先</option><option value="latency">热连接响应优先</option></select></label>
</div><div class="rex-probe-actions"><button type="button" id="rexProbeStop" disabled>停止测速</button><label class="rex-file-button">导入候选文件<input id="rexProbeFile" type="file" accept=".txt,.csv,text/plain"></label><span style="font-size:12px;color:#94a3b8">1 MB/s = 8 Mbps；无需下载程序或切换页面。</span></div>
<details id="rexEmbySubscription" open style="margin-top:14px;border:1px solid #138da5;border-radius:10px;padding:16px"><summary>Emby 专用优选订阅 · Surge</summary>
<p>① 填优选入口和 ProxyIP → ② 保存到订阅 → ③ 在 Surge 添加下面的策略组和 Emby 分流规则。Rex/Emby 继续使用现有反代地址。</p>
<label style="display:block">订阅更新地址（保密；用于 Surge 策略组 policy-path）<input id="rexSubUrl" readonly autocomplete="off" placeholder="正在读取订阅地址…" style="width:100%;box-sizing:border-box;color:inherit;background:#0b1725;padding:10px"></label>
<p id="rexSubConnection" role="status" style="color:#94a3b8">正在读取独立订阅服务；仅保存配置不会自动启用本机 Surge 分流。</p>
<pre id="rexSubPath" style="white-space:pre-wrap;font-size:12px"></pre>
<label>yx · 优选订阅入口（每行 IP/域名:TLS端口）<textarea id="rexSubList" style="width:100%;min-height:80px;color:inherit;background:#0b1725"></textarea></label>
<label>p · ProxyIP 使用方式<select id="rexSubMode"><option value="matched">绑定所选入口同一 IP:端口（不回落）</option><option value="relay">使用单独的固定中转（不回落）</option></select></label>
<label>p · 固定 ProxyIP（仅固定中转模式使用）<input id="rexSubRelay" placeholder="IP:TLS端口" style="width:100%"></label>
<p style="font-size:12px;color:#94a3b8">绑定同一地址不保证目标观察到的实际出口 IP 相同。普通 CF 优选入口不一定具备出站中转能力；不通时断开，不自动换其它地址。</p>
<div class="rex-probe-actions"><button id="rexSubLoad" type="button">读取订阅配置</button><button id="rexSubSelected" type="button">填入选中结果</button><button id="rexSubSave" type="button">保存到订阅</button><button id="rexSubCopy" type="button">复制订阅地址</button><button id="rexSubCopyRules" type="button">复制 Surge 接入规则</button></div>
<details><summary>Cloudflare 变量 p / yx 与面板配置</summary><p>独立订阅 Worker 支持 p / yx 初始变量。面板保存到 D1 后优先使用面板配置，修改变量不会覆盖已保存列表。下面按钮可切换回 Workers 变量；不修改正式 DNS。</p><pre id="rexSubEnvironment" style="white-space:pre-wrap;font-size:12px"></pre><button id="rexSubUseEnvironment" type="button">使用 Workers 的 p / yx 变量</button></details>
<pre id="rexSubStatus" style="white-space:pre-wrap;font-size:12px"></pre></details></div>`;
const panelControlsClient=String.raw`
 const preset=document.getElementById('rexProbePreset');
 if(preset){
  const profiles={quick:[10,1,1000],standard:[20,2,500],quality:[50,5,200]};
  const settingIds=['rexProbeCount','rexProbeMinSpeed','rexProbeMaxLatency'];
  preset.onchange=()=>{if(profiles[preset.value])settingIds.forEach((id,i)=>document.getElementById(id).value=profiles[preset.value][i]);};
  settingIds.forEach(id=>document.getElementById(id).oninput=()=>{preset.value='custom';});
  document.getElementById('rexProbeSort').onchange=groupResults;
  document.getElementById('rexProbeStop').onclick=()=>{if(!busy&&!currentPromise)return;probeCancelled=true;for(const controller of probeControllers)controller.abort();show('正在停止测速并清理临时解析；已完整测完的结果会保留。');};
  document.getElementById('rexProbeFile').onchange=async event=>{try{if(busy)throw Error('请先停止当前测速');const file=event.target.files[0];if(!file)return;if(file.size>12000)throw Error('文件最多 12000 字节，请分批导入');let text=await file.text();if(/\.csv$/i.test(file.name))text=text.split(/\r?\n/).filter(Boolean).map((line,i)=>{const parts=line.split(',').map(v=>v.trim().replace(/^"|"$/g,''));if(i===0&&/ip|地址/i.test(parts[0])&&!/^\d+\./.test(parts[0]))return '';return /^\d+$/.test(parts[1]||'')?parts[0]+':'+parts[1]:parts[0];}).filter(Boolean).join('\n');document.getElementById('customIps').value=text;notify('候选已导入，点击“测试粘贴的节点”开始。');}catch(e){notify(e.message);}finally{event.target.value='';}};
 }
`;

export const panelProbeScript = String.raw`<script data-rex-entry-check="measurement-v15-probe-readiness">
(function(){
 ${probeClientSource}
 let probeQueue=Promise.resolve();
 async function queuedMeasurement(item,stage){const previous=probeQueue;let unlock;probeQueue=new Promise(resolve=>unlock=resolve);await previous;try{return await measureConnection(item,stage);}finally{unlock();}}
 function probeSettings(){
  const number=(id,fallback)=>{const field=document.getElementById(id);return field?Number(field.value):fallback;};
  const settings={count:number('rexProbeCount',64),minSpeed:number('rexProbeMinSpeed',0),maxLatency:number('rexProbeMaxLatency',10000)};
  if(!Number.isInteger(settings.count)||settings.count<1||settings.count>100||!Number.isFinite(settings.minSpeed)||settings.minSpeed<0||settings.minSpeed>10000||!Number.isFinite(settings.maxLatency)||settings.maxLatency<1||settings.maxLatency>10000)throw Error('请检查数量（1–100）、速度下限和响应上限。');return settings;
 }
 function setProbeBusy(value){for(const el of document.querySelectorAll?.('.rex-probe-retest')||[])el.disabled=value||el.dataset.inputValid==='false';for(const id of ['rexProbePreset','rexProbeCount','rexProbeMinSpeed','rexProbeMaxLatency','rexProbeFile']){const el=document.getElementById(id);if(el)el.disabled=value;}for(const id of ['btnTop3Dns','btnSelectedDns']){const el=document.getElementById(id);if(el)el.disabled=value;}const stop=document.getElementById('rexProbeStop');if(stop)stop.disabled=!value;}
 function transferProgress(cell,text,progress){cell.textContent=text;if(progress){cell.dataset.progressUpdates=String(Number(cell.dataset.progressUpdates||0)+1);if(progress.percent<100)cell.dataset.partialUpdates=String(Number(cell.dataset.partialUpdates||0)+1);const bar=document.createElement('progress');bar.className='rex-download-progress';bar.max=progress.total;bar.value=progress.total*progress.percent/100;bar.setAttribute('aria-label','已下载 '+progress.percent.toFixed(0)+'%');cell.appendChild(bar);}}
 function speedLabel(result){return (result.Mbps/8).toFixed(2)+' MB/s（'+result.Mbps.toFixed(2)+' Mbps） · '+(result.bytes/1048576)+' MiB 完整下载';}
 let busy=false;const verified=new Set(),leases=new Map(),recentlyConnected=new Map();
 async function release(lease){if(!lease)return;await json('/api/cleanup-entry-probes',lease);leases.delete(lease.session);}
 addEventListener('pagehide',()=>{for(const lease of leases.values())fetch('/api/cleanup-entry-probes',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(lease)}).catch(()=>{});});
 const ids=['btnTestCustom','btnFetchRemote','btnFetchCustomApi'];
 const show=m=>{document.getElementById('statusText').textContent=m;};
 const notify=m=>{show(m);showToast(m);};
 async function json(url,body){const c=new AbortController(),t=setTimeout(()=>c.abort(),20000);try{const r=await fetch(url,{signal:c.signal,cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(r.status===401?'登录已过期，请重新登录面板':'接口返回 HTTP '+r.status);const j=await r.json();if(j.success===false)throw Error(j.error||'接口失败');return j;}finally{clearTimeout(t);}}
 let currentPromise;
 function refreshCurrentEntry(quickOnly=false){
  if(busy)return Promise.resolve();
  if(!document.getElementById('rexCurrentCompare'))return Promise.resolve();
  if(currentPromise)return currentPromise;
  const stop=document.getElementById('rexProbeStop');if(stop)stop.disabled=false;
  const button=document.getElementById('rexCompareButton'),dns=document.getElementById('rexCompareDns'),speed=document.getElementById('rexCompareSpeed'),latency=document.getElementById('rexCompareLatency');button.disabled=true;
  currentPromise=(async()=>{
   try{const data=await json('/api/get-dns');const records=(data.result||[]).filter(r=>['A','AAAA','CNAME'].includes(r.type));dns.textContent='Cloudflare 当前配置：'+(records.map(r=>r.type+' '+r.content).join('、')||'无地址记录');}
   catch(e){dns.textContent='当前解析读取失败：'+e.message;}
   speed.textContent='当前入口测速中…';latency.textContent='待测';
   try{if(quickOnly){const ms=await warmConnection({url:'/api/network-probe',control:true},text=>speed.textContent=text);latency.textContent=ms+' ms 热连接';speed.textContent='点右侧按钮测下载速度';return;}const result=await queuedMeasurement({url:'/api/network-probe',control:true,onLatency:ms=>latency.textContent=ms+' ms 热连接'},(text,p)=>transferProgress(speed,text,p));latency.textContent=result.latencyMs+' ms 热连接';speed.textContent=speedLabel(result);speed.title='数据传输计时 '+result.bodyMs.toFixed(1)+' ms；本次下载端到端 '+result.totalMs.toFixed(1)+' ms；延迟为 3 次热连接响应中位数。';}
   catch(e){if(!latency.textContent.includes('ms'))latency.textContent='未完成';speed.textContent=probeCancelled?'已停止；未完整下载，不保留有效速度':e.name==='AbortError'?'下载未完成或连接超时；未保留有效速度':'当前入口测速失败：'+(e instanceof TypeError?'解析或网络连接未完成':e.message);}

  })().finally(()=>{button.disabled=false;currentPromise=null;if(!busy){probeCancelled=false;if(stop)stop.disabled=true;}});
  return currentPromise;
 }
 function rowFor(item){const tr=document.createElement('tr');tr.className='test-row';tr.dataset.verified='false';tr.dataset.resultState='pending';
  const cb=document.createElement('input');cb.type='checkbox';cb.className='ip-checkbox row-checkbox';cb.value=item.ip;cb.disabled=true;const first=document.createElement('td');first.appendChild(cb);tr.appendChild(first);
  for(const cls of ['ip-text','latency','speed','loc']){const td=document.createElement('td');td.className=cls;td.textContent=cls==='ip-text'?item.ip:cls==='latency'?'待测':cls==='speed'?'等待测试':item.sampledFrom?'网段抽样 '+item.sampledFrom:'临时测速解析 / 独立下载';tr.appendChild(td);}
  const last=document.createElement('td'),btn=document.createElement('button');btn.className='btn-dns';btn.textContent='唯一解析';btn.disabled=true;btn.onclick=()=>updateSingleDns(item.ip,btn);const retry=document.createElement('button');retry.className='rex-probe-retest';retry.textContent='重测';retry.disabled=busy||!!item.error;retry.dataset.inputValid=String(!item.error);retry.style.cssText='margin-right:8px;border:1px solid #168ba6;border-radius:6px;background:transparent;color:#38bdf8;padding:6px 10px;cursor:pointer';retry.onclick=()=>retestSingle(item.ip,tr);last.appendChild(retry);last.appendChild(btn);tr.appendChild(last);return tr;
 }
 function compareMeasured(a,b){if(document.getElementById('rexProbeSort')?.value==='latency')return Number(a.dataset.latencyMs)-Number(b.dataset.latencyMs)||Number(a.dataset.seconds)-Number(b.dataset.seconds);return Number(a.dataset.seconds)-Number(b.dataset.seconds)||Number(a.dataset.latencyMs)-Number(b.dataset.latencyMs);}
 function groupResults(){
  const table=document.getElementById('testTableBody');if(!table)return;
  const rows=Array.from(table.children).filter(tr=>tr.className==='test-row');
  for(const header of Array.from(table.children).filter(tr=>tr.dataset.resultGroup==='true'))header.remove();
  const groups=[['passed','✅ 测速通过 · 满足本次阈值'],['ready','🔵 连通通过 · 等待独立带宽测试'],['unready','🕒 公共 DNS 尚未确认'],['rechecking','🔎 检查原因 / 新域名重试'],['below','🟡 未达本次测速阈值'],['failed','❌ 测试失败'],['skipped','⏭ 已跳过'],['pending','⏳ 等待测试']];
  for(const [state,label] of groups){const items=rows.filter(tr=>(tr.dataset.resultState||'pending')===state);if(!items.length)continue;if(state==='passed')items.sort(compareMeasured);if(state==='ready')items.sort((a,b)=>Number(a.dataset.latencyMs)-Number(b.dataset.latencyMs));
   const header=document.createElement('tr');header.className='rex-result-group';header.dataset.resultGroup='true';const cell=document.createElement('td');cell.colSpan=6;cell.textContent=label+'（'+items.length+'）';cell.style.cssText='padding:12px 20px;color:#94a3b8;background:rgba(100,116,139,.09);font-weight:600;text-align:left';header.appendChild(cell);table.appendChild(header);for(const tr of items)table.appendChild(tr);
  }
 }
 async function measure(item,tr,settings=probeSettings()){verified.delete(item.ip);tr.dataset.verified='false';tr.dataset.resultState='pending';tr.querySelector('.row-checkbox').disabled=true;tr.querySelector('.btn-dns').disabled=true;const latency=tr.querySelector('.latency'),status=tr.querySelector('.speed');latency.setAttribute('data-ms',999999);
  if(item.error){tr.dataset.resultState='skipped';latency.textContent='跳过';status.textContent=item.error;return false;}
  try{
   const result=await queuedMeasurement(item,(text,p)=>transferProgress(status,text,p));
   latency.textContent=result.latencyMs+' ms 热连接';latency.title='连接建立后 3 次小请求响应的中位数；不含 DNS、首次握手和重试等待。';latency.setAttribute('data-ms',result.latencyMs);
   status.textContent=speedLabel(result);status.title='数据传输计时 '+result.bodyMs.toFixed(1)+' ms；本次下载端到端 '+result.totalMs.toFixed(1)+' ms。';
   if(result.latencyMs>settings.maxLatency||result.Mbps/8<settings.minSpeed){tr.dataset.resultState='below';tr.dataset.latencyMs=result.latencyMs;tr.dataset.seconds=result.bodyMs/result.bytes;status.textContent+=' · '+(result.latencyMs>settings.maxLatency?'响应超过阈值':'速度低于下限');return false;}
   tr.dataset.verified='true';tr.dataset.seconds=result.bodyMs/result.bytes;tr.dataset.Mbps=result.Mbps;tr.dataset.latencyMs=result.latencyMs;tr.dataset.resultState='passed';tr.dataset.measurementTiming=result.timing;
   verified.add(item.ip);tr.querySelector('.row-checkbox').disabled=false;tr.querySelector('.btn-dns').disabled=false;return true;
  }catch(e){item.measureError=e;if(probeCancelled){tr.dataset.resultState='skipped';status.textContent='已停止；下载未完成，不保留有效速度';return false;}tr.dataset.resultState='failed';if(!Number.isFinite(item.warmLatencyMs))latency.textContent='失败';status.textContent=e.name==='AbortError'?'连接或传输超时；未获得有效测速值':e instanceof TypeError?'DNS/TLS/代理路径连接失败；未获得有效测速值':e.message;return false;}
 }

 function connectionFailure(item,error,tr,diagnostic){
  const latency=tr.querySelector('.latency'),status=tr.querySelector('.speed');
  if(probeCancelled){tr.dataset.resultState='skipped';status.textContent='已停止；不判定为节点失败';return;}
  const edge=diagnostic?.edge||item.edge,dns=diagnostic?.dnsState||item.dnsState;
  if(edge?.code){tr.dataset.resultState='failed';latency.textContent='HTTPS 失败';status.textContent='浏览器 HTTPS 未完成；云端入口检查返回 Cloudflare '+edge.code+(edge.code==='1034'?'（此路径入口 IP 受限）':'')+'。云端检查不代表本机速度。';}
  else if(error instanceof TypeError||error.name==='AbortError'){
   const ready=diagnostic?.dnsReady??item.dnsReady;
   tr.dataset.resultState=ready?'failed':'unready';latency.textContent=ready?'HTTPS 未完成':'DNS 未确认';
   const checks=dns?.checks||[];const detail=checks.map(c=>c.resolver+': '+(c.ready?'A 记录正确':c.rcode===3?'NXDOMAIN':c.reason?'查询超时':'未匹配目标 IP')).join('；');
   status.textContent=(ready?'公共 DNS 已核验；浏览器 HTTPS '+(error.name==='AbortError'?'超时':'失败')+'，TLS / 分流 / 边缘拒绝尚未区分。':'公共 DNS 尚未确认且浏览器 HTTPS 失败；未能判定节点好坏。')+(detail?' '+detail+'。':'')+' 可点右侧“重测”。';
  }else{tr.dataset.resultState='failed';latency.textContent='失败';status.textContent=error.message;}
 }
 async function retestSingle(ip,tr){
  if(busy)return notify('请先停止或等待当前测试结束');let settings;try{settings=probeSettings();}catch(e){return notify(e.message);}
  busy=true;probeCancelled=false;setProbeBusy(true);ids.forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=true;});let lease,item,cleanupWarning='';
  verified.delete(ip);tr.dataset.verified='false';tr.querySelector('.row-checkbox').disabled=true;tr.querySelector('.row-checkbox').checked=false;tr.querySelector('.btn-dns').disabled=true;tr.dataset.resultState='rechecking';tr.querySelector('.speed').textContent='正在准备新的辅助域名…';
  try{await currentPromise;const j=await json('/api/prepare-entry-probes',{input:ip,freshHost:true});lease=j.lease;if(lease)leases.set(lease.session,lease);item=j.probes[0];await measure(item,tr,settings);
   if(tr.dataset.resultState==='failed'&&!probeCancelled&&!Number.isFinite(item.warmLatencyMs)){const check=await json('/api/prepare-entry-probes',{input:ip,checkLease:lease,diagnose:true});const failure=item.measureError||Error('浏览器 HTTPS 未完成');connectionFailure(item,failure,tr,check.probes?.[0]);}
  }catch(error){if(item)connectionFailure(item,error,tr);else{tr.dataset.resultState='failed';tr.querySelector('.speed').textContent=error.message;}}
  finally{if(lease){try{await release(lease);}catch(error){cleanupWarning=error.message;}}groupResults();busy=false;probeCancelled=false;setProbeBusy(false);ids.forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=false;});if(cleanupWarning)notify('重测结束，但辅助解析清理尚未确认：'+cleanupWarning);else show('单节点重测结束；其它结果保留，辅助解析已清理，正式 DNS 未修改。');}
 }
 async function run(load){if(busy)return;const runStarted=performance.now();let settings;try{settings=probeSettings();}catch(e){return notify(e.message);}probeCancelled=false;busy=true;setProbeBusy(true);ids.forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=true;});
  try{const table=document.getElementById('testTableBody');table.innerHTML='';verified.clear();show('CIDR 每网段抽样 4 个；临时创建测速解析，测完清理。正式入口需手动提交。');await currentPromise;const source=await load();const plan=await json('/api/prepare-entry-probes',{...source,planOnly:true});const rows=plan.candidates.slice(0,settings.count),rowMap=new Map();for(const item of rows){const tr=rowFor(item);table.appendChild(tr);rowMap.set(item.ip,tr);}let passed=0,completed=0,skipped=0;
   for(let offset=0;offset<rows.length;offset+=12){if(probeCancelled)break;const batch=rows.slice(offset,offset+12),valid=batch.filter(x=>!x.error);let lease;const batchLeases=[];
    try{
     show('正在准备临时测速解析…');const ready=valid.length?await json('/api/prepare-entry-probes',{input:valid.map(x=>x.ip).join('\n'),warmIps:valid.filter(x=>recentlyConnected.get(x.ip)>Date.now()).map(x=>x.ip)}):{probes:[]};lease=ready.lease;if(lease){leases.set(lease.session,lease);batchLeases.push(lease);}
     const probes=batch.map(x=>({...x,...ready.probes.find(p=>p.ip===x.ip)}));
     show('快速检查连通与延迟…（小请求并发，尚未开始下载）');
     for(let i=0;i<probes.length;i+=4){if(probeCancelled)break;await Promise.all(probes.slice(i,i+4).map(async item=>{
      const tr=rowMap.get(item.ip),latency=tr.querySelector('.latency'),status=tr.querySelector('.speed');
      if(item.error){tr.dataset.resultState='skipped';latency.textContent='跳过';status.textContent=item.error;skipped++;completed++;return;}
      try{item.warmLatencyMs=await warmConnection(item,text=>status.textContent=text);recentlyConnected.set(item.ip,Date.now()+45000);tr.dataset.connectionAfterMs=Math.round(performance.now()-runStarted);latency.textContent=item.warmLatencyMs+' ms 热连接';tr.dataset.latencyMs=item.warmLatencyMs;tr.dataset.resultState='ready';status.textContent='连通通过，等待独立下载…';if(item.warmLatencyMs>settings.maxLatency){tr.dataset.resultState='below';status.textContent='响应超过 '+settings.maxLatency+' ms 阈值；未下载';completed++;}}
      catch(e){item.connectionError=e;connectionFailure(item,e,tr);completed++;}
     }));groupResults();}
     // Finish working candidates before spending time on failed-path diagnostics.
     for(const item of probes){if(probeCancelled)break;const tr=rowMap.get(item.ip);if(tr.dataset.resultState!=='ready')continue;show('独立测速 '+item.ip+'；已完成 '+completed+'/'+rows.length+'，通过 '+passed+'。');if(await measure(item,tr,settings))passed++;tr.dataset.completedAfterMs=Math.round(performance.now()-runStarted);completed++;groupResults();}
     const retryItems=probes.filter(item=>item.connectionError&&(item.connectionError.name==='AbortError'||item.connectionError instanceof TypeError));
     if(retryItems.length&&!probeCancelled){
      for(const item of retryItems){const tr=rowMap.get(item.ip);tr.dataset.resultState='rechecking';tr.querySelector('.speed').textContent='连接失败；检查公共 DNS 与边缘响应，换新辅助域名重试一次…';}groupResults();
      const diagnosis=await json('/api/prepare-entry-probes',{input:retryItems.map(x=>x.ip).join('\n'),checkLease:lease,diagnose:true});
      if(!probeCancelled){const fresh=await json('/api/prepare-entry-probes',{input:retryItems.map(x=>x.ip).join('\n'),freshHost:true});if(fresh.lease){leases.set(fresh.lease.session,fresh.lease);batchLeases.push(fresh.lease);}
       for(let i=0;i<retryItems.length;i+=4){if(probeCancelled)break;await Promise.all(retryItems.slice(i,i+4).map(async item=>{const tr=rowMap.get(item.ip),status=tr.querySelector('.speed');const oldHint=diagnosis.probes?.find(p=>p.ip===item.ip);Object.assign(item,fresh.probes.find(p=>p.ip===item.ip));
        try{item.warmLatencyMs=await warmConnection(item,text=>status.textContent='新域名重试：'+text);tr.querySelector('.latency').textContent=item.warmLatencyMs+' ms 热连接';tr.dataset.latencyMs=item.warmLatencyMs;tr.dataset.resultState=item.warmLatencyMs>settings.maxLatency?'below':'ready';status.textContent=tr.dataset.resultState==='below'?'响应超过设置阈值；未下载':'新辅助域名连通，等待完整下载';if(tr.dataset.resultState==='ready'){completed--;recentlyConnected.set(item.ip,Date.now()+45000);}}
        catch(error){connectionFailure(item,error,tr,{...oldHint,dnsReady:item.dnsReady,dnsState:item.dnsState});}
       }));groupResults();}
      }
     }
     for(const item of probes){if(probeCancelled)break;const tr=rowMap.get(item.ip);if(tr.dataset.resultState!=='ready')continue;show('独立测速 '+item.ip+'；已完成 '+completed+'/'+rows.length+'，通过 '+passed+'。');if(await measure(item,tr,settings))passed++;tr.dataset.completedAfterMs=Math.round(performance.now()-runStarted);completed++;groupResults();}

    }finally{for(const held of batchLeases.reverse()){show('正在清理本批全部临时测速解析（含重试域名）…');await release(held);}}
   }
   if(probeCancelled)skipped=Array.from(document.getElementById('testTableBody').children).filter(tr=>tr.className==='test-row'&&['skipped','pending','ready','rechecking'].includes(tr.dataset.resultState)).length;
   notify((probeCancelled?'测试已停止：候选通过 ':'测试结束：候选通过 ')+passed+'/'+rows.length+'，跳过 '+skipped+'，耗时 '+((performance.now()-runStarted)/1000).toFixed(1)+' 秒。本次临时解析已清理（含失败项）；正式入口未自动修改。');
  }catch(e){notify(e.name==='AbortError'?'请求超时；测试已停止，临时解析由过期任务兜底清理':e.message);}
  finally{for(const tr of Array.from(document.getElementById('testTableBody').children).filter(tr=>tr.className==='test-row'&&['pending','ready','rechecking'].includes(tr.dataset.resultState))){tr.dataset.resultState='skipped';tr.querySelector('.speed').textContent='本批未完成，未作为有效测速';}groupResults();for(const lease of [...leases.values()]){try{await release(lease);}catch{notify('临时解析清理未确认；过期后自动重试清理，正式入口未自动修改。');}}busy=false;probeCancelled=false;setProbeBusy(false);ids.forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=false;});}
 }
 testCustomIPs=()=>run(()=>Promise.resolve({input:document.getElementById('customIps').value}));
 fetchRemoteAndTest=()=>run(async()=>{const j=await json('/api/get-remote-ips?type='+encodeURIComponent(document.getElementById('ipType').value));if(!j.ips?.length)throw Error('预设源没有返回候选');return {inputs:j.ips.slice(0,512)};});
 fetchCustomApiAndTest=()=>run(async()=>{const value=document.getElementById('customApiUrl').value.trim();if(!value)throw Error('请填写 API 地址');const j=await json('/api/get-custom-api-ips?url='+encodeURIComponent(value));if(!j.ips?.length)throw Error('API 没有返回候选');return {inputs:j.ips.slice(0,512)};});
 doLocalPing=(ip,tr)=>retestSingle(ip,tr);
 sendDnsRequest=async function(ips,button){
  if(busy)return notify('请等待本批测速与临时解析清理结束，再提交 DNS。');
  if(!ips.length||ips.some(ip=>!verified.has(ip)))return notify('请选择本次测速成功的 IPv4；失败或未验证的地址不能提交。');
  const action=document.getElementById('rexDnsAction'),text=button.textContent;button.disabled=true;button.textContent='更新 DNS 中…';if(action)action.textContent='正在提交 DNS 修改…';
  try{const result=await json('/api/update-dns',{ips});if(action)action.textContent='DNS 已更新为：'+ips.join('、')+'；正在刷新当前入口对比。';showToast(result.message||'DNS 更新成功');show('DNS 已手动更新；下方保留的是提交前的候选测速结果。');if(typeof loadDNS==='function')Promise.resolve().then(()=>loadDNS()).catch(()=>{});await currentPromise;await refreshCurrentEntry();if(action)action.textContent='DNS 已更新为：'+ips.join('、')+'。当前入口已重测，请留意 DNS 缓存。';}
  catch(e){if(action)action.textContent='DNS 更新或刷新失败：'+e.message;notify('DNS 操作提示：'+e.message);}
  finally{button.disabled=false;button.textContent=text;}
 };
 updateTop3ToDns=function(){const rows=Array.from(document.querySelectorAll('#testTableBody .test-row')).filter(tr=>tr.dataset.verified==='true').sort(compareMeasured);const ips=rows.slice(0,3).map(tr=>tr.querySelector('.ip-text').textContent);if(!ips.length)return notify('没有测速成功的地址，请先完成测速');if(confirm('将 panel.rex-custom.invalid 手动更新为以下 IP？多条记录不会自动按运营商选路。\n'+ips.join('\n')))sendDnsRequest(ips,document.getElementById('btnTop3Dns'));};
 directSubmitCname=function(){notify('第三方 CNAME 尚未核验，当前仅支持测速成功的 Cloudflare IPv4。');};
 const clearOriginal=clearTest;clearTest=function(){if(busy)return notify('测试进行中，请等待当前任务结束');clearOriginal();};
 for(const id of ['btnTop3Dns','btnSelectedDns']){const b=document.getElementById(id);if(b){b.disabled=false;b.title='手动提交后修改 panel.rex-custom.invalid 的 DNS';}}
 const compareButton=document.getElementById('rexCompareButton');if(compareButton){compareButton.onclick=()=>refreshCurrentEntry();refreshCurrentEntry(true);}
 ${panelControlsClient}
 const input=document.getElementById('customIps');if(input)input.placeholder='Cloudflare IPv4、IP:443 或 CIDR；全部在面板内测速，正式 DNS 仅手动提交';

 let subUrl='',subRules='';
 async function subscriptionAction(save){const output=document.getElementById('rexSubStatus');try{
 const body=save==='environment'?{useEnvironment:true}:save?{list:document.getElementById('rexSubList').value,mode:document.getElementById('rexSubMode').value,relay:document.getElementById('rexSubRelay').value}:undefined;
 const j=await json('/api/emby-subscription',body);if(!j.success)throw Error(j.error||'订阅请求失败');subUrl=j.subscriptionUrl;subRules=j.rules;
 document.getElementById('rexSubUrl').value=subUrl;document.getElementById('rexSubList').value=j.nodes.map(n=>n.host+':'+n.port).join('\n');document.getElementById('rexSubMode').value=j.mode;document.getElementById('rexSubRelay').value=j.relay||'';
 document.getElementById('rexSubConnection').textContent='独立订阅服务已连接 · '+j.nodes.length+' 条入口 · 当前配置来源：'+(j.source==='environment'?'Workers 变量 p / yx':'面板 D1（优先于 Workers 变量）')+'。Surge 是否导入并命中规则：本页无法自动确认。';
 document.getElementById('rexSubPath').textContent='实际使用路径：\nRex/Emby → Surge 的 Emby优选策略 → 所选优选入口 → 独立订阅 Worker → '+(j.mode==='relay'?'固定 ProxyIP '+j.relay:'同址 ProxyIP')+' → '+j.target+' → 原 Emby 源站\n未导入订阅或未命中 Emby 分流规则时，仍走原来的访问路径。';
 document.getElementById('rexSubEnvironment').textContent='Workers yx：'+(j.environment?.yx||'未配置')+'\nWorkers p：'+(j.environment?.p||'未配置')+'\n这些变量只属于独立订阅 Worker；不要填到原反代 Worker。';
 output.textContent=(save?'已保存，Surge 需要刷新订阅。':'配置已读取。')+'\n以下是 Surge 策略组与 Emby 分流规则片段，不是整份配置。分别放入现有对应段；Emby 规则放在广泛规则之前。其它上网流量保持现有规则。\n\n'+j.rules;return true;
 }catch(e){document.getElementById('rexSubConnection').textContent='订阅服务读取失败；原反代不受影响。';output.textContent=e.message;return false;}}
 const subLoad=document.getElementById('rexSubLoad');if(subLoad){subLoad.onclick=()=>subscriptionAction(false);document.getElementById('rexSubSave').onclick=()=>subscriptionAction(true);document.getElementById('rexSubUseEnvironment').onclick=()=>subscriptionAction('environment');
 document.getElementById('rexSubSelected').onclick=()=>{const rows=Array.from(document.querySelectorAll('#testTableBody .test-row')).filter(tr=>tr.querySelector('input[type=checkbox]')?.checked&&tr.dataset.verified==='true');if(!rows.length)return notify('请勾选本次测速成功的候选');document.getElementById('rexSubList').value=rows.map(tr=>tr.querySelector('.ip-text').textContent+':443').join('\n');};
 async function copySubscription(rules){if(!subUrl&&!await subscriptionAction(false))return;const text=rules?subRules:subUrl;try{await navigator.clipboard.writeText(text);document.getElementById('rexSubStatus').textContent=(rules?'Surge 接入规则已复制。':'新订阅地址已复制。')+'请在 Surge 中手动添加/更新；本页没有修改你的 Surge 配置。';}catch{document.getElementById('rexSubStatus').textContent=text;}}
 document.getElementById('rexSubCopy').onclick=()=>copySubscription(false);document.getElementById('rexSubCopyRules').onclick=()=>copySubscription(true);subscriptionAction(false);
 }

})();
</script>`;

