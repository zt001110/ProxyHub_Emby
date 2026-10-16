import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
const src=await readFile('update-guard/worker.js','utf8');
const {default:guard,...lib}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
function db(){
 const sqlite=new DatabaseSync(':memory:');
 return {
  exec(sql){sqlite.exec(sql);return Promise.resolve();},
  prepare(sql){let values=[];return {
   bind(...v){values=v;return this;},
   async first(){return sqlite.prepare(sql).get(...values)||null;},
   async all(){return {results:sqlite.prepare(sql).all(...values)};},
   async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:r.changes}};}
  };}
 };
}
const env={DB:db(),CF_API_TOKEN:'private-token',ADMIN_TOKEN:'private-admin',CF_ACCOUNT_ID:'account',CF_WORKER_NAME:'worker'};
await env.DB.exec(`CREATE TABLE routes (prefix TEXT,remark TEXT); INSERT INTO routes VALUES ('jp','Japan'); CREATE TABLE app_config (key TEXT,value TEXT); INSERT INTO app_config VALUES ('secret','hidden');`);
const baseline={version:'3.4.6',adapter:'a'.repeat(64),configHash:'config-original'};
let deployed=[{version_id:'before-id',percentage:100}],failure=false,providerFail=false,backupFail=false,readyChecks=true,missingBinding=false,rollbackThrows=false;
const settings={bindings:[{name:'DB',type:'d1',id:'database'},{name:'UPDATE_GUARD',type:'service',service:'guard'},{name:'ADMIN_TOKEN',type:'secret_text'}],compatibility_date:'2026-10-15'};
const originalFetch=globalThis.fetch;
let uploads=0,deployments=0;let next=0;
function health(){return {...baseline,version:deployed[0].version_id==='before-id'?'3.4.6':'3.4.7',adapter:failure?'bad':baseline.adapter,database:true,ownerBinding:true,dnsBinding:true,analyticsBinding:true};}
env.TARGET={async fetch(req){const u=new URL(req.url);if(u.pathname==='/api/update-health')return Response.json(health());if(u.pathname==='/')return new Response(readyChecks?['measurement-v15-probe-readiness','rexProbePreset','rexProbeStop','rex-update-protection','rex-probe-retest',"return 'https://' + 'panel.rex-custom.invalid'"].join(' '):'missing UI');if(u.pathname==='/api/me')return Response.json({role:'admin'});if(u.pathname==='/api/network-probe')return req.headers.get('Cookie')?new Response(new Uint8Array(2048)):new Response('',{status:401});if(u.pathname==='/api/prepare-entry-probes')return Response.json({success:true,candidates:[{ip:'172.64.79.192'}]});if(u.pathname==='/api/tg-webhook')return new Response('',{status:403});return new Response('<svg/>');}};
globalThis.fetch=async(url,o={})=>{
 assert.equal(o.headers.Authorization,'Bearer '+env.CF_API_TOKEN);
 const path=new URL(url).pathname.split('/scripts/worker')[1];
 if(path==='/deployments'&&!o.method)return Response.json({success:true,result:{deployments:[{versions:deployed}]}});
 if(path==='/deployments'){if(rollbackThrows&&JSON.parse(o.body).versions[0].version_id==='before-id')throw Error('network');deployed=JSON.parse(o.body).versions;deployments++;return Response.json({success:true,result:{id:'deployment-'+deployments}});}
 if(path==='/settings')return Response.json({success:true,result:{...settings,bindings:missingBinding?[]:settings.bindings}});
 if(path==='/content/v2')return new Response('multipart-old-worker-with-all-custom-functions',{status:backupFail?500:200,headers:{'Content-Type':'multipart/form-data; boundary=export'}});
 if(path==='/versions'&&o.method==='POST'){
  uploads++;const m=JSON.parse(await o.body.get('metadata').text());assert.deepEqual(m.keep_bindings,['secret_text']);assert(!m.bindings.some(b=>b.type==='secret_text'));assert.equal(m.bindings[1].name,'UPDATE_GUARD');assert(!JSON.stringify(m).includes('private-admin'));
  return Response.json({success:!providerFail,result:{id:'candidate-'+(++next)},errors:[{code:10021}]});
 }
 if(path.startsWith('/versions/'))return Response.json({success:true,result:{id:'before-id'}});
 throw Error('Unexpected '+path);
};
const form=()=>{const f=new FormData();f.set('rex-manifest',JSON.stringify({version:'3.4.7',adapter:baseline.adapter}));return f;};
const request=(path,body)=>new Request('https://guard'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.ADMIN_TOKEN},...(body?{body:JSON.stringify(body)}:{})});
try{
 assert.equal((await guard.fetch(new Request('https://guard/status'),env,{})).status,401);
 const noToken=await guard.fetch(request('/status'),{...env,CF_API_TOKEN:undefined},{});assert.equal((await noToken.json()).ready,false);
 await assert.rejects(()=>lib.begin({...env,CF_API_TOKEN:undefined},form()),/凭据/);assert.equal(deployments,0);
 readyChecks=false;await assert.rejects(()=>lib.begin(env,form()),/当前功能检查/);readyChecks=true;assert.equal(uploads,0);
 missingBinding=true;await assert.rejects(()=>lib.begin(env,form()),/绑定缺失/);missingBinding=false;
 backupFail=true;await assert.rejects(()=>lib.begin(env,form()),/备份读取失败/);backupFail=false;assert.equal(uploads,0);assert.equal(deployments,0);
 const job=await lib.begin(env,form());assert.equal(job.status,'ready');assert.equal(deployments,0);assert.equal(Buffer.from(await lib.readChunks(env.DB,job.id,'code')).toString(),'multipart-old-worker-with-all-custom-functions');
 assert((await lib.readChunks(env.DB,job.id,'configuration')).length>0);
 await assert.rejects(()=>lib.begin(env,form()),/已有更新/);
 await lib.advance(env,job.id);assert.equal(deployed[0].version_id,job.candidate);
 await lib.advance(env,job.id);assert.equal((await lib.load(env.DB,job.id)).status,'verifying');let stabilizing=await lib.load(env.DB,job.id);stabilizing.firstHealthyAt=Date.now()-61000;stabilizing.lastHealthyAt=Date.now()-31000;stabilizing.healthySamples=2;await lib.save(env.DB,stabilizing);await lib.advance(env,job.id);assert.equal((await lib.load(env.DB,job.id)).status,'passed');
 const beforeManual=await env.DB.prepare('SELECT * FROM app_config').all();await lib.advance(env,job.id,true);assert.equal(deployed[0].version_id,'before-id');assert.equal((await lib.load(env.DB,job.id)).status,'rolled_back');assert.deepEqual(await env.DB.prepare('SELECT * FROM app_config').all(),beforeManual);
 const broken=await lib.begin(env,form());await lib.advance(env,broken.id);failure=true;await lib.advance(env,broken.id);let j=await lib.load(env.DB,broken.id);assert.equal(j.status,'verifying');assert(j.checks.some(x=>!x.passed));j.deadline=Date.now()-1;await lib.save(env.DB,j);rollbackThrows=true;await lib.advance(env,j.id);assert.equal((await lib.load(env.DB,j.id)).status,'rollback_failed');rollbackThrows=false;failure=false;await lib.tick(env);assert.equal((await lib.load(env.DB,j.id)).status,'rolled_back');
 const changed=await lib.begin(env,form());await lib.advance(env,changed.id);deployed=[{version_id:'operator-deployment',percentage:100}];await lib.advance(env,changed.id);assert.equal((await lib.load(env.DB,changed.id)).status,'superseded');assert.equal(deployed[0].version_id,'operator-deployment');
 deployed=[{version_id:'before-id',percentage:100}];providerFail=true;await assert.rejects(()=>lib.begin(env,form()),/Cloudflare/);assert.equal(deployed[0].version_id,'before-id');providerFail=false;
 const output=await (await guard.fetch(request('/status'),env,{})).json();assert.equal(output.ready,true);assert(output.jobs.length>0);assert(!JSON.stringify(output).includes('private-token'));assert(!JSON.stringify(output).includes('hidden'));
 console.log('PASS: real SQLite backup/checksum, preflight fail-closed, staged upload before deployment, independent checks, automatic rollback and cron retry, manual rollback preserves current data, concurrent update exclusion, external deployment protection, scoped reports and missing credential guard.');
}finally{globalThis.fetch=originalFetch;}
