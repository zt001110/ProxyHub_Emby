// Emby-only preferred subscription transport.
const embyTunnelFailures=new Map();
// Emby-only Trojan WebSocket transport. No general proxy, UDP or fallback path.
export function decodeEmbyTrojanHeader(bytes,passwordHash,target){
 if(bytes.length<61)return null;
 const expected=new TextEncoder().encode(passwordHash);
 let mismatch=expected.length!==56?1:0;for(let i=0;i<56;i++)mismatch|=bytes[i]^(expected[i]||0);
 if(mismatch||bytes[56]!==13||bytes[57]!==10||bytes[58]!==1||bytes[59]!==3)throw Error('Rejected');
 const length=bytes[60],end=61+length+4;if(bytes.length<end)return null;
 const host=new TextDecoder().decode(bytes.subarray(61,61+length)).toLowerCase().replace(/\.$/,'');
 const port=(bytes[61+length]<<8)|bytes[62+length];
 if(host!==target.toLowerCase()||port!==443||bytes[63+length]!==13||bytes[64+length]!==10)throw Error('Rejected');
 return bytes.subarray(end);
}
async function embyTrojanTunnel(request,env){

 const relay=new URL(request.url).searchParams.get('p')?.match(/^([a-z0-9.-]+):(\d+)$/);if(!relay)return new Response('Not configured',{status:503});
 const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();server.binaryType='arraybuffer';
 let socket,writer,closed=false,header=new Uint8Array(),pending=0,chain=Promise.resolve(),ready=false;
 const close=(error)=>{if(closed)return;closed=true;if(error instanceof Error){const id=new URL(request.url).pathname.split('/').pop();embyTunnelFailures.set(id,{at:new Date().toISOString(),reason:error.message.slice(0,180)});if(embyTunnelFailures.size>32)embyTunnelFailures.delete(embyTunnelFailures.keys().next().value);}clearTimeout(timer);try{server.close(error instanceof Error?1011:1000,error instanceof Error?error.message.replace(/[^\x20-\x7e]/g,'').slice(0,100):'closed')}catch{}try{writer?.releaseLock()}catch{}try{socket?.close()}catch{}};
 const timer=setTimeout(close,12000);
 async function receive(data){
  if(closed)return;
  const bytes=new Uint8Array(data);
  if(ready){await writer.write(bytes);return;}
  if(header.length+bytes.length>131072)throw Error('Header too large');
  const merged=new Uint8Array(header.length+bytes.length);merged.set(header);merged.set(bytes,header.length);header=merged;
  const payload=decodeEmbyTrojanHeader(header,env.EMBY_TROJAN_HASH,env.CF_DOMAIN);if(payload===null)return;
  socket=env.SOCKET_CONNECT({hostname:relay[1],port:Number(relay[2])});
  let connectTimer;try{await Promise.race([socket.opened,new Promise((_,reject)=>{connectTimer=setTimeout(()=>reject(Error('Connect timeout')),8000)})]);}finally{clearTimeout(connectTimer);}
  if(closed){socket.close();return;}writer=socket.writable.getWriter();ready=true;header=new Uint8Array();if(payload.length)await writer.write(payload);
  socket.readable.pipeTo(new WritableStream({write(chunk){if(closed)return;clearTimeout(timer);for(let i=0;i<chunk.length;i+=65536)server.send(chunk.subarray(i,i+65536));},close,abort:close})).catch(close);
  socket.closed.catch(close);
 }
 server.addEventListener('message',event=>{if(typeof event.data==='string'||!(event.data instanceof ArrayBuffer))return close();pending+=event.data.byteLength;if(pending>2097152)return close();chain=chain.then(()=>receive(event.data)).catch(close).finally(()=>pending-=event.data.byteLength);});
 server.addEventListener('close',close);server.addEventListener('error',close);
 return new Response(null,{status:101,webSocket:client});
}

const KEY='rex_emby_subscription_v1',TLS_PORTS=new Set([443,2053,2083,2087,2096,8443]);
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export function parseList(text){
 const values=String(text||'').split(/[\s,]+/).filter(Boolean);if(!values.length||values.length>32)throw Error('请填写 1–32 个 IP 或域名，可带 TLS 端口');
 return [...new Set(values)].map(value=>{
  const m=value.toLowerCase().match(/^([a-z0-9.-]+)(?::(\d+))?$/);if(!m)throw Error('订阅支持公网 IPv4 或域名，可带 TLS 端口');
  const isIP=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(m[1]);
  if(!isIP&&(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(m[1])||/\.(localhost|local|internal|invalid)$/.test(m[1])))throw Error('域名格式不支持');
  const octets=m[1].split('.').map(Number),port=Number(m[2]||443);
  if((isIP&&(octets.some(n=>n>255)||[0,10,127].includes(octets[0])||octets[0]>=224||(octets[0]===169&&octets[1]===254)||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168)||(octets[0]===100&&octets[1]>=64&&octets[1]<=127)))||!TLS_PORTS.has(port))throw Error('仅允许公网 IPv4 和受支持 TLS 端口');
  return {id:crypto.randomUUID(),host:m[1],port};
 });
}
async function environmentConfig(env){
 const text=String(env.yx||'').split(/[\n,]+/).map(line=>line.split('#')[0].trim()).filter(Boolean).join('\n');
 const nodes=text?parseList(text):[];
 for(const node of nodes){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('emby-sub-v1|'+node.host+':'+node.port));const hex=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);node.id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);}
 const relay=env.p?parseList(String(env.p)):[];if(relay.length>1)throw Error('p 只能配置一个固定 ProxyIP');
 return {nodes,relay:relay.length?relay[0].host+':'+relay[0].port:'',mode:relay.length?'relay':'matched',source:'environment'};
}
async function load(env){const row=await env.DB.prepare('SELECT value FROM app_config WHERE key=?').bind(KEY).first();return row?{...JSON.parse(row.value),source:'panel'}:environmentConfig(env);}
export function policies(nodes,env){return nodes.map((n,i)=>`Emby优选${String(i+1).padStart(2,'0')} = trojan, ${n.host}, ${n.port}, password=${env.TROJAN_PASSWORD}, sni=${env.TUNNEL_DOMAIN||env.CF_DOMAIN}, ws=true, ws-path=/__emby-sub/ws/${n.id}, ws-headers=Host:${env.TUNNEL_DOMAIN||env.CF_DOMAIN}, skip-cert-verify=false, udp-relay=false`).join('\n')+'\n';}
export async function serveEmbySubscription(request,env,ctx){
 env={...env,SUB_TOKEN:env.EMBY_SUB_TOKEN,TROJAN_PASSWORD:env.EMBY_TROJAN_PASSWORD};
 try{
  if(!env.ADMIN_TOKEN||!env.SUB_TOKEN||env.SUB_TOKEN.length<32||!env.TROJAN_PASSWORD||env.TROJAN_PASSWORD.length<32)return new Response('Not configured',{status:503});
  const u=new URL(request.url);
  if(u.pathname==='/admin'){
   if(request.headers.get('Authorization')!=='Bearer '+env.ADMIN_TOKEN)return json({success:false},401);
   let config=await load(env);
   if(request.method==='POST'){
    if(Number(request.headers.get('Content-Length')||0)>12000)throw Error('Payload too large');
    const raw=await request.text();if(raw.length>12000)throw Error('Payload too large');const body=JSON.parse(raw);if(body.useEnvironment===true){const fallback=await environmentConfig(env);if(!fallback.nodes.length)throw Error('yx 变量未配置');await env.DB.prepare('DELETE FROM app_config WHERE key=?').bind(KEY).run();config=fallback;}else{const parsed=parseList(body.list),nodes=[...new Map(parsed.map(n=>[n.host+':'+n.port,n])).values()],mode=body.mode==='relay'?'relay':'matched';
    const relay=mode==='relay'?parseList(body.relay):[];if(mode==='relay'&&relay.length!==1)throw Error('独立中转地址只能填写一个');
    const old=new Map(config.nodes.map(n=>[n.host+':'+n.port,n.id]));for(const n of nodes)n.id=old.get(n.host+':'+n.port)||n.id;
    config={nodes,mode,relay:relay.length?relay[0].host+':'+relay[0].port:'',updatedAt:new Date().toISOString()};
    await env.DB.prepare('INSERT INTO app_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(KEY,JSON.stringify(config)).run();config.source='panel';}
   }
   return json({success:true,...config,yx:config.nodes.map(n=>n.host+':'+n.port).join(','),p:config.mode==='relay'?config.relay:'',environment:{yx:String(env.yx||''),p:String(env.p||'')},integration:{target:env.CF_DOMAIN,transportHost:env.TUNNEL_DOMAIN||env.CF_DOMAIN,requiresSurgeRule:true,clientStatus:'unknown'},diagnostics:Object.fromEntries(embyTunnelFailures),subscriptionUrl:'https://'+(env.EMBY_SUB_DOMAIN||env.CF_DOMAIN)+'/'+env.SUB_TOKEN,rules:'[Proxy Group]\nEmby优选 = select, policy-path=https://'+(env.EMBY_SUB_DOMAIN||env.CF_DOMAIN)+'/'+env.SUB_TOKEN+', update-interval=86400\n\n[Rule]\nDOMAIN,'+env.CF_DOMAIN+',Emby优选\n',target:env.CF_DOMAIN,scope:'Emby only; target port 443; no other destinations; no fallback; actual egress equality not guaranteed'});
  }
  if((u.pathname==='/'+env.SUB_TOKEN||u.pathname==='/__emby-sub/'+env.SUB_TOKEN+'/surge.list')&&request.method==='GET'){
   const config=await load(env);if(!config.nodes.length)return new Response('No configured Emby policies',{status:503,headers:{'Cache-Control':'no-store'}});
   return new Response(policies(config.nodes,env),{headers:{'Content-Type':'text/plain;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  const match=u.pathname.match(/^\/__emby-sub\/ws\/([a-f0-9-]{36})$/);
  if(match&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   const config=await load(env),node=config.nodes.find(n=>n.id===match[1]);if(!node)return new Response('Not found',{status:404});
   // Outbound selection is server controlled. Client query p/s/wk overrides are discarded.
   u.search='';u.searchParams.set('p',config.mode==='matched'?node.host+':'+node.port:config.relay);
   return embyTrojanTunnel(new Request(u,request),env);
  }
  return new Response('Not found',{status:404});
 }catch{return json({success:false,error:'配置或订阅请求失败，请检查公网 IP、TLS 端口及存储状态。'},400);}
}
