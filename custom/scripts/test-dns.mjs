import assert from'node:assert/strict';import{build}from'esbuild';
const built=await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'browser',loader:{'.txt':'text'},write:false,logLevel:'silent'});const worker=(await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
const env={ADMIN_TOKEN:'test-admin',CF_DOMAIN:'panel.rex-custom.invalid',CF_ZONE_ID:'a'.repeat(32),CF_DNS_API_TOKEN:'test-dns'},ctx={waitUntil(){}};
const req=(ips,auth=true)=>new Request('https://panel.rex-custom.invalid/api/'+(ips?'update-dns':'get-dns'),{method:ips?'POST':'GET',headers:{...(auth?{Cookie:'admin_token=test-admin'}:{}),'Content-Type':'application/json'},...(ips?{body:JSON.stringify({ips})}:{})});
const records=[{id:'working',name:'panel.rex-custom.invalid',type:'A',content:'104.17.138.18',proxied:false},{id:'txt',name:'panel.rex-custom.invalid',type:'TXT',content:'keep'}];
const original=globalThis.fetch;let calls=[],fail=false;globalThis.fetch=async(url,opt)=>{calls.push({url,opt});assert(url.includes('/zones/'+env.CF_ZONE_ID+'/dns_records'));if(url.endsWith('/batch'))return Response.json({success:!fail,result:{},errors:fail?[{code:1004}]:[]});assert(url.endsWith('?name=panel.rex-custom.invalid'));return Response.json({success:true,result:records})};
try{
 assert.equal((await worker.fetch(req(undefined,false),env,ctx)).status,401);assert.equal((await worker.fetch(req(['104.17.138.18'],false),env,ctx)).status,401);assert.equal(calls.length,0);
 const read=await(await worker.fetch(req(),env,ctx)).json();assert(read.success&&read.writeEnabled);calls=[];
 const same=await(await worker.fetch(req(['104.17.138.18']),env,ctx)).json();assert(same.success);assert.equal(calls.length,1);assert(!calls.some(c=>c.opt.method==='POST'));calls=[];
 const changed=await(await worker.fetch(req(['172.64.79.1']),env,ctx)).json();assert(changed.success);const batch=JSON.parse(calls.find(c=>c.url.endsWith('/batch')).opt.body);assert.deepEqual(batch.deletes,[{id:'working'}]);assert.equal(batch.posts[0].name,'panel.rex-custom.invalid');assert.equal(batch.posts[0].proxied,false);assert(!JSON.stringify(batch).includes('txt'));calls=[];
 assert.equal((await(await worker.fetch(req(['127.0.0.1']),env,ctx)).json()).success,false);assert.equal(calls.length,0);
 fail=true;const rejected=await(await worker.fetch(req(['172.64.79.1']),env,ctx)).json();assert(!rejected.success&&rejected.error.includes('1004'));assert.equal(calls.filter(c=>c.opt.method==='POST').length,1);assert(!calls.some(c=>c.opt.method==='DELETE'));
 console.log('PASS: manual DNS writes restored, admin-only, fixed hostname, invalid IP rejection, current-IP no-op, TXT preserved, atomic batch and explicit provider errors.');
}finally{globalThis.fetch=original;}
