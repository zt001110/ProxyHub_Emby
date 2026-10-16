// Trusted controller: run from the workflow revision, never from upstream/candidate code.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {http} from './http.mjs';
export async function deploy({base,password,adapter,manifest,source,report,call:transport,sleep=ms=>new Promise(r=>setTimeout(r,ms)),polls=100}) {
 const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid deployment origin.');
 if(!password||!adapter)throw Error('Deployment credentials or expected adapter fingerprint missing.');
 const save=value=>{if(report)writeFileSync(report,JSON.stringify(value,null,2)+'\n');};
 const call=transport|| (async(path,body)=>{const r=await http(new URL(path,url).href,{cookie:'admin_token='+password,body,retries:0,maxTime:100});if(r.status!==200)throw Error('Protected API request failed; inspect guard before retrying.');try{return JSON.parse(r.body);}catch{throw Error('Invalid protected API response.');}});
 const health=await call('/api/update-health'),status=await call('/api/update-protection/status');
 if(!health.success||health.adapter!==adapter||!['database','ownerBinding','dnsBinding','analyticsBinding'].every(k=>health[k])||!status.success||!status.ready)throw Error('Live baseline/adapter/guard checks failed; no deployment sent.');
 const active=['preparing','ready','deploying','verifying','rolling_back','rollback_failed'];
 if(status.jobs?.some(j=>active.includes(j.status)))throw Error('An update or recovery is already active; no duplicate deployment sent.');
 if(!manifest.coreChanged){save({result:'baseline_passed',version:health.version});return 'baseline_passed';}
 if(createHash('sha256').update(source).digest('hex')!==manifest.sha256)throw Error('Candidate digest mismatch; no deployment sent.');
 // Never retry POST /api/deploy: a lost response may still mean an accepted job.
 const started=await call('/api/deploy',{newCode:source});
 if(!started.success||!started.jobId)throw Error('Update not confirmed; inspect guard records before retrying.');
 save({result:'pending',jobId:started.jobId});
 for(let n=0;n<polls;n++){
  const state=await call('/api/update-protection/status'),j=state.jobs?.find(x=>x.id===started.jobId);
  if(!state.success||!j)throw Error('Update record unavailable; independent guard continues recovery.');
  // Public artifact deliberately excludes server error text, configuration, URLs and backup bytes.
  save({jobId:j.id,result:j.status,version:j.version,checks:(j.checks||[]).map(c=>({id:c.id,passed:!!c.passed})),rollbackChecks:(j.rollbackChecks||[]).map(c=>({id:c.id,passed:!!c.passed}))});
  if(j.status==='passed'){if(j.version!==manifest.version)throw Error('Unexpected deployed version.');return 'passed';}
  if(!active.includes(j.status))throw Error('Protected update ended: '+j.status+'. See the panel protection record.');
  if(['ready','deploying','verifying'].includes(j.status))await call('/api/update-protection/check',{id:j.id});
  await sleep(4000);
 }
 throw Error('Update still pending; independent guard continues. Do not resubmit until its record is checked.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const dir=process.env.REX_ARTIFACT_DIR||'automatic-artifact',manifest=JSON.parse(readFileSync(resolve(dir,'manifest.json')));const result=await deploy({base:process.env.REX_PANEL_ORIGIN,password:process.env.REX_PANEL_ADMIN,adapter:process.env.REX_EXPECTED_ADAPTER,manifest,source:manifest.coreChanged?readFileSync(resolve(dir,'worker.js'),'utf8'):'',report:resolve('automatic-report.json')});console.log('Protected automation: '+result);}
 catch{console.error('Automatic deployment stopped. Check the sanitized report and panel update-protection records; no automatic resubmission.');process.exitCode=1;}
}
