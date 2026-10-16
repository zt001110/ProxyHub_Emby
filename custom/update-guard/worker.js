// Independent from the panel Worker: a broken new panel cannot disable rollback.
const ACTIVE = ['preparing','ready','deploying','verifying','rolling_back','rollback_failed'];
const encoder = new TextEncoder();
const reply = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function digest(value){const b=typeof value==='string'?encoder.encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function init(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS rex_updates (id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS rex_update_chunks (job TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(job,kind,seq));
 CREATE TABLE IF NOT EXISTS rex_update_lock (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, expires INTEGER NOT NULL);`);
}
async function lock(db){const holder=crypto.randomUUID(),now=Date.now();const r=await db.prepare('INSERT INTO rex_update_lock (id,holder,expires) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE rex_update_lock.expires < ? RETURNING holder').bind(holder,now+120000,now).first();if(r?.holder!==holder)throw Error('更新检查正在执行，请稍后再试。');return ()=>db.prepare('DELETE FROM rex_update_lock WHERE holder=?').bind(holder).run();}
export async function save(db,j){j.updated=Date.now();await db.prepare('INSERT INTO rex_updates (id,created,updated,status,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,status=excluded.status,data=excluded.data').bind(j.id,j.created,j.updated,j.status,JSON.stringify(j)).run();}
export async function load(db,id){const r=await db.prepare('SELECT data FROM rex_updates WHERE id=?').bind(id).first();return r?JSON.parse(r.data):null;}
export async function chunks(db,job,kind,value){const bytes=typeof value==='string'?encoder.encode(value):new Uint8Array(value);for(let offset=0;offset<bytes.length;offset+=49152){const content=(bytes.subarray(offset,offset+49152).toBase64?.()||btoa(String.fromCharCode(...bytes.subarray(offset,offset+49152))));await db.prepare('INSERT INTO rex_update_chunks (job,kind,seq,content) VALUES (?,?,?,?)').bind(job,kind,offset/49152,content).run();}return {sha256:await digest(bytes),bytes:bytes.length};}
export async function readChunks(db,job,kind){const {results}=await db.prepare('SELECT content FROM rex_update_chunks WHERE job=? AND kind=? ORDER BY seq').bind(job,kind).all();const parts=results.map(x=>(Uint8Array.fromBase64?Uint8Array.fromBase64(x.content):Uint8Array.from(atob(x.content),c=>c.charCodeAt(0))));const b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let n=0;for(const p of parts){b.set(p,n);n+=p.length;}return b;}
async function api(env,path,options={}){
 if(!env.CF_API_TOKEN)throw Error('独立更新检查器缺少 Workers Scripts 编辑凭据；未执行更新。');
 const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+env.CF_ACCOUNT_ID+'/workers/scripts/'+env.CF_WORKER_NAME+path,{...options,headers:{Authorization:'Bearer '+env.CF_API_TOKEN,...options.headers},signal:AbortSignal.timeout(15000)});
 const j=await r.json();if(!r.ok||!j.success)throw Error('Cloudflare '+path.split('?')[0]+' 操作失败（'+(j.errors||[]).map(x=>x.code).join(',')+'）。');return j.result;
}
export async function active(env){const r=await api(env,'/deployments');const d=r.deployments?.[0];if(!d?.versions?.length)throw Error('无法读取当前部署；未更新。');return d;}
const same=(a,b)=>JSON.stringify([...a].sort((x,y)=>x.version_id.localeCompare(y.version_id)))===JSON.stringify([...b].sort((x,y)=>x.version_id.localeCompare(y.version_id)));
async function deploy(env,versions,message){return api(env,'/deployments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy:'percentage',versions,annotations:{'workers/message':message}})});}
async function target(env,path,options={}){return (env.TARGET ? env.TARGET.fetch.bind(env.TARGET) : fetch)(new Request('https://panel.rex-custom.invalid'+path,{...options,headers:{Cookie:'admin_token='+env.ADMIN_TOKEN,...options.headers},signal:AbortSignal.timeout(6000)}));}
export async function configuration(db){
 const {results:tables}=await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();const out=[];
 for(const t of tables){if(!['routes','app_config','settings','config','users','rex_bot_owner'].includes(t.name))continue;const {results}=await db.prepare('SELECT * FROM "'+t.name+'" LIMIT 10001').all();if(results.length>10000)throw Error('配置快照过大；未执行更新。');out.push({name:t.name,schema:t.sql,rows:results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});}
 return out;
}
export async function inspect(env,expected){
 const checks=[];async function check(id,fn){try{await fn();checks.push({id,passed:true});}catch{checks.push({id,passed:false});}}
 await check('adapter-version-config-bindings',async()=>{const r=await target(env,'/api/update-health');const j=await r.json();if(!r.ok||j.adapter!==expected.adapter||j.version!==expected.version||j.configHash!==expected.configHash||!j.database||!j.ownerBinding||!j.dnsBinding||!j.analyticsBinding)throw Error();});
 await check('panel-speedtest-dns-update-controls',async()=>{const r=await target(env,'/');const text=await r.text();for(const marker of ['measurement-v15-probe-readiness','rexProbePreset','rexProbeStop','rex-update-protection','rex-probe-retest',"return 'https://' + 'panel.rex-custom.invalid'"]){if(!r.ok||!text.includes(marker))throw Error();}});
 await check('admin-session',async()=>{const r=await target(env,'/api/me');if(!r.ok||(await r.json()).role!=='admin')throw Error();});
 await check('anonymous-access-blocked',async()=>{const r=await target(env,'/api/network-probe',{headers:{Cookie:''}});if(r.status!==401)throw Error();});
 await check('speedtest-valid-payload',async()=>{const r=await target(env,'/api/network-probe?bytes=2048');if(!r.ok||(await r.arrayBuffer()).byteLength!==2048)throw Error();});
 await check('candidate-planner-readonly',async()=>{const r=await target(env,'/api/prepare-entry-probes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'172.64.79.192',planOnly:true})});const j=await r.json();if(!r.ok||!j.success||j.candidates?.[0]?.ip!=='172.64.79.192')throw Error();});
 await check('telegram-webhook-auth',async()=>{const r=await target(env,'/api/tg-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(![401,403].includes(r.status))throw Error();});
 await check('region-assets',async()=>{const r=await target(env,'/assets/regions/us.svg');if(!r.ok||!(await r.text()).includes('<svg'))throw Error();});
 return checks;
}
export async function begin(env,form){
 await init(env.DB);const unlock=await lock(env.DB);let job;
 try{
  const ongoing=await env.DB.prepare("SELECT id FROM rex_updates WHERE status IN ('preparing','ready','deploying','verifying','rolling_back','rollback_failed') LIMIT 1").first();if(ongoing)throw Error('已有更新或待恢复任务，请先查看更新记录。');
  const manifest=JSON.parse(String(form.get('rex-manifest')));if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||!/^[a-f0-9]{64}$/.test(manifest.adapter))throw Error('更新清单无效。');form.delete('rex-manifest');
  const before=await active(env);if(before.versions.length!==1||before.versions[0].percentage!==100)throw Error('当前为多版本灰度部署，请先人工核对，未执行更新。');
  await api(env,'/versions/'+before.versions[0].version_id);
  const settings=await api(env,'/settings');if(!settings.bindings?.some(b=>b.name==='DB'&&b.type==='d1')||!settings.bindings.some(b=>b.name==='UPDATE_GUARD'&&b.type==='service'))throw Error('数据库或独立更新器绑定缺失，未执行更新。');
  const healthResponse=await target(env,'/api/update-health');const health=await healthResponse.json();if(!healthResponse.ok||!health.adapter||!health.configHash)throw Error('更新前健康检查失败，未执行更新。');
  const baseline={version:health.version,adapter:health.adapter,configHash:health.configHash};const baselineChecks=await inspect(env,baseline);if(baselineChecks.some(x=>!x.passed))throw Error('当前功能检查未通过，未执行更新：'+baselineChecks.filter(x=>!x.passed).map(x=>x.id).join(', '));
  job={id:crypto.randomUUID(),created:Date.now(),status:'preparing',version:manifest.version,baseline,expected:{...manifest,configHash:health.configHash},before:before.versions,baselineChecks,checks:[],events:[{at:Date.now(),stage:'backup-started'}]};await save(env.DB,job);
  const raw=await fetch('https://api.cloudflare.com/client/v4/accounts/'+env.CF_ACCOUNT_ID+'/workers/scripts/'+env.CF_WORKER_NAME+'/content/v2',{headers:{Authorization:'Bearer '+env.CF_API_TOKEN},signal:AbortSignal.timeout(15000)});if(!raw.ok)throw Error('当前代码备份读取失败。');
  const bytes=await raw.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>8*1024*1024)throw Error('当前代码备份大小异常。');job.code=await chunks(env.DB,job.id,'code',bytes);job.code.contentType=raw.headers.get('content-type');
  job.settings=await chunks(env.DB,job.id,'settings',JSON.stringify(settings));job.config=await chunks(env.DB,job.id,'configuration',JSON.stringify(await configuration(env.DB)));
  if(await digest(await readChunks(env.DB,job.id,'code'))!==job.code.sha256||await digest(await readChunks(env.DB,job.id,'configuration'))!==job.config.sha256)throw Error('备份完整性核验失败。');
  job.events.push({at:Date.now(),stage:'backup-verified'});await save(env.DB,job);
  const metadata={main_module:'index.js',bindings:settings.bindings.filter(b=>b.type!=='secret_text'),keep_bindings:['secret_text'],compatibility_date:settings.compatibility_date||'2026-10-15'};
  for(const k of ['compatibility_flags','placement','limits','observability','logpush','tail_consumers','tags'])if(settings[k]!==undefined)metadata[k]=settings[k];
  form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
  const candidate=await api(env,'/versions',{method:'POST',body:form});if(!candidate.id)throw Error('候选版本未返回版本号。');job.candidate=candidate.id;job.status='ready';job.events.push({at:Date.now(),stage:'candidate-uploaded'});await save(env.DB,job);return job;
 }catch(e){if(job){job.status='failed_before_deploy';job.error=e.message;await save(env.DB,job);}throw e;}finally{await unlock();}
}
async function rollback(env,j){
 const now=await active(env);const ours=[{version_id:j.candidate,percentage:100}];
 if(same(now.versions,j.before)){j.rollbackChecks=await inspect(env,j.baseline);if(j.rollbackChecks.some(x=>!x.passed)){j.status='rollback_failed';j.recoveryError='旧版本已切回，但功能检查尚未通过，将继续重试。';await save(env.DB,j);return;}j.status='rolled_back';j.events.push({at:Date.now(),stage:'rollback-confirmed'});await save(env.DB,j);return;}
 if(!same(now.versions,ours)){j.status='superseded';j.error='检测到其它部署，停止自动回滚，避免覆盖人工更新。';await save(env.DB,j);return;}
 j.status='rolling_back';await save(env.DB,j);
 try{await deploy(env,j.before,'Rex protected update rollback '+j.id);const current=await active(env);if(!same(current.versions,j.before))throw Error('旧版本尚未确认生效。');j.rollbackChecks=await inspect(env,j.baseline);if(j.rollbackChecks.some(x=>!x.passed))throw Error('Rollback health checks failed');j.status='rolled_back';j.events.push({at:Date.now(),stage:'rollback-confirmed'});delete j.recoveryError;}
 catch{j.status='rollback_failed';j.recoveryError='自动回滚尚未确认；独立检查器会再次尝试，请查看故障记录。';}
 await save(env.DB,j);
}
export async function advance(env,id,manual=false){
 await init(env.DB);const unlock=await lock(env.DB);
 try{const j=await load(env.DB,id);if(!j)return null;
  if(manual){if(!['passed','verifying','rollback_failed','rolling_back'].includes(j.status))throw Error('该记录当前不能回滚。');await rollback(env,j);return j;}
  if(j.status==='preparing'){if(Date.now()-j.updated>180000){j.status='failed_before_deploy';j.error='备份或上传中断；正式版本未由该任务修改。';await save(env.DB,j);}return j;}
  if(['rolling_back','rollback_failed'].includes(j.status)){await rollback(env,j);return j;}
  if(!['ready','deploying','verifying'].includes(j.status))return j;
  const before=await active(env),ours=[{version_id:j.candidate,percentage:100}];
  if(j.status==='ready'){if(!same(before.versions,j.before)){j.status='superseded';j.error='部署前发现其它版本已发布，已取消本次更新。';await save(env.DB,j);return j;}j.status='deploying';j.deadline=Date.now()+300000;await save(env.DB,j);try{await deploy(env,ours,'Rex protected update '+j.id);}catch{j.error='部署响应未确认，正在核对实际版本。';}return j;}
  if(same(before.versions,j.before)){if(Date.now()>j.deadline){j.status='failed_before_deploy';j.error='候选版本未生效，原版本仍在服务。';await save(env.DB,j);}return j;}
  if(!same(before.versions,ours)){j.status='superseded';j.error='检测到其它部署，已停止自动操作。';await save(env.DB,j);return j;}
  j.status='verifying';j.checks=await inspect(env,j.expected);j.attempts=(j.attempts||0)+1;j.events.push({at:Date.now(),stage:'checks',failed:j.checks.filter(x=>!x.passed).map(x=>x.id)});
  if(j.checks.every(x=>x.passed)){const now=Date.now();j.firstHealthyAt??=now;if(!j.lastHealthyAt||now-j.lastHealthyAt>=30000){j.healthySamples=(j.healthySamples||0)+1;j.lastHealthyAt=now;}if(now-j.firstHealthyAt<60000||(j.healthySamples||0)<3){await save(env.DB,j);return j;}delete j.error;delete j.recoveryError;j.status='passed';j.events.push({at:Date.now(),stage:'verified'});await save(env.DB,j);}
  else if(Date.now()>=j.deadline){delete j.firstHealthyAt;delete j.lastHealthyAt;j.healthySamples=0;j.error='更新后关键功能检查失败。';await save(env.DB,j);await rollback(env,j);}
  else {delete j.firstHealthyAt;delete j.lastHealthyAt;j.healthySamples=0;await save(env.DB,j);}return j;
 }catch(e){const j=await load(env.DB,id);if(j&&ACTIVE.includes(j.status)){j.recoveryError=e.message;await save(env.DB,j);}throw e;}finally{await unlock();}
}
export async function tick(env){await init(env.DB);const {results}=await env.DB.prepare("SELECT id FROM rex_updates WHERE status IN ('preparing','ready','deploying','verifying','rolling_back','rollback_failed') ORDER BY created LIMIT 1").all();for(const r of results)await advance(env,r.id);}
export function publicJob(j){if(!j)return null;const {id,created,updated,status,version,baseline,candidate,before,code,config,settings,checks,baselineChecks,rollbackChecks,events,error,recoveryError,attempts}=j;return {id,created,updated,status,version,previousVersion:baseline.version,candidate,previousVersions:before,backup:{code,config,settings},checks,baselineChecks,rollbackChecks,events,error,recoveryError,attempts};}
export default{
 async fetch(request,env,ctx){
  if(!env.ADMIN_TOKEN||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_TOKEN)return reply({success:false,error:'Unauthorized'},401);
  try{await init(env.DB);const u=new URL(request.url);
   if(u.pathname==='/status'){const {results}=await env.DB.prepare('SELECT data FROM rex_updates ORDER BY created DESC LIMIT 10').all();return reply({success:true,ready:!!env.CF_API_TOKEN,jobs:results.map(r=>publicJob(JSON.parse(r.data)))});}
   if(u.pathname==='/start'&&request.method==='POST'){const j=await begin(env,await request.formData());ctx.waitUntil(advance(env,j.id).catch(()=>{}));return reply({success:true,pending:true,jobId:j.id,version:j.version,msg:'备份已核验，正在发布并检查；关闭页面后检查仍会继续。'});}
   if(u.pathname==='/rollback'&&request.method==='POST'){const {id}=await request.json();const j=await advance(env,id,true);if(!j)throw Error('记录不存在。');return reply({success:j.status==='rolled_back',job:publicJob(j),error:j.recoveryError});}
   if(u.pathname==='/check'&&request.method==='POST'){const {id}=await request.json();const j=await advance(env,id);return reply({success:true,job:publicJob(j)});}
   return reply({success:false,error:'Not found'},404);
  }catch(e){return reply({success:false,error:e.message});}
 },
 async scheduled(event,env,ctx){ctx.waitUntil(tick(env));}
};
