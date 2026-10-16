import assert from'node:assert/strict';import{build}from'esbuild';
const built=await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'browser',loader:{'.txt':'text'},write:false,logLevel:'silent'});const worker=(await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
const env={ADMIN_TOKEN:'test-admin',CF_DOMAIN:'panel.rex-custom.invalid',CF_ZONE_ID:'a'.repeat(32),CF_DNS_API_TOKEN:'test-dns'},ctx={waitUntil(){}};
const req=(ips,auth=true)=>new Request('https://panel.rex-custom.invalid/api/'+(ips?'update-dns':'get-dns'),{method:ips?'POST':'GET',headers:{...(auth?{Cookie:'admin_token=test-admin'}:{}),'Content-Type':'application/json'},...(ips?{body:JSON.stringify({ips})}:{})});
const records=[{id:'working',name:'panel.rex-custom.invalid',type:'A',content:'192.0.2.1',proxied:true}];
const original=globalThis.fetch;let calls=[];globalThis.fetch=async(url,opt)=>{calls.push({url,opt});assert(url.endsWith('?name=panel.rex-custom.invalid'));assert.equal(opt.method,'GET');return Response.json({success:true,result:records})};
try{
 assert.equal((await worker.fetch(req(undefined,false),env,ctx)).status,401);assert.equal((await worker.fetch(req(['104.17.138.18'],false),env,ctx)).status,401);assert.equal(calls.length,0);
 const read=await(await worker.fetch(req(),env,ctx)).json();assert(read.success&&!read.writeEnabled);assert.deepEqual(read.result,records);calls=[];
 for(const ips of [['172.64.79.192'],['127.0.0.1'],[]]){const result=await(await worker.fetch(req(ips),env,ctx)).json();assert(!result.success&&!result.writeEnabled);assert(result.error.includes('订阅'));assert.equal(calls.length,0);}
 console.log('PASS: admin-only DNS reads, default proxied record preserved, every legacy DNS write blocked before provider calls.');
}finally{globalThis.fetch=original;}
