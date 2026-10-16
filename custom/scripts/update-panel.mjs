// Run only in a private materialized release. This uses the existing protected
// panel update API, so backup, post-update checks and rollback remain mandatory.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {http} from './http.mjs';
const configuration=JSON.parse(readFileSync('wrangler.jsonc')),privateConfig=JSON.parse(readFileSync('deployment-private.json'));
const base=new URL(privateConfig.base);if(base.protocol!=='https:'||base.hostname!==configuration.vars.CF_DOMAIN||!configuration.routes.some(r=>r.pattern.replace(/\/\*$/,'')===base.hostname))throw Error('Credential destination does not match the private bound domain.');
const cookie='admin_token='+privateConfig.admin_password;
async function call(path,body){const r=await http(new URL(path,base).href,{cookie,body,maxTime:100,retries:0});if(r.status!==200)throw Error('Panel API HTTP '+r.status);return JSON.parse(r.body);}
const status=await call('/api/update-protection/status');if(!status.success||!status.ready)throw Error('Independent backup/rollback guard is not ready. No update sent.');
const started=await call('/api/deploy',{newCode:readFileSync('src/worker.js','utf8')});if(!started.success||!started.jobId)throw Error(started.error||'Update not accepted; inspect existing records before retrying.');
const dir=resolve('backups/update-reports');mkdirSync(dir,{recursive:true,mode:0o700});let last;
for(let n=0;n<90;n++){
 const s=await call('/api/update-protection/status'),j=s.jobs?.find(x=>x.id===started.jobId);if(!j)throw Error('Update record unavailable. Check the independent guard before retrying.');
 writeFileSync(join(dir,j.id+'.json'),JSON.stringify(j,null,2)+'\n',{mode:0o600});if(j.status!==last){console.log('Update '+j.id+': '+j.status);last=j.status;}
 if(!['preparing','ready','deploying','verifying','rolling_back','rollback_failed'].includes(j.status)){if(j.status!=='passed')throw Error(j.error||j.recoveryError||j.status);console.log('Protected author-core update and critical checks passed.');break;}
 if(['ready','deploying','verifying'].includes(j.status))await call('/api/update-protection/check',{id:j.id});
 if(n===89)throw Error('Guard still processing; inspect the saved job, do not resubmit blindly.');await new Promise(r=>setTimeout(r,4000));
}
