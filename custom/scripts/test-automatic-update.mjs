import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateChanges,validateVersion} from './automatic-integration.mjs';
import {deploy} from './automatic-deploy.mjs';
const source='// VERSION: 3.4.7\nconst CURRENT_VERSION="3.4.7"; export default {};';
const manifest={coreChanged:true,version:'3.4.7',sha256:createHash('sha256').update(source).digest('hex')};
const healthy={success:true,version:'3.4.6',adapter:'fixture',database:true,ownerBinding:true,dnsBinding:true,analyticsBinding:true};
const options={base:'https://panel.example.invalid',password:'fixture',adapter:'fixture',manifest,source,sleep:async()=>{}};
const make=(outcome='passed',initial={success:true,ready:true,jobs:[]})=>{const paths=[];let submitted=false;return {paths,call:async(path,body)=>{paths.push(path);if(path==='/api/update-health')return healthy;if(path==='/api/deploy'){assert.equal(body.newCode,source);submitted=true;return {success:true,jobId:'fixture-job'};}if(path==='/api/update-protection/check')return {success:true};return submitted?{success:true,jobs:[{id:'fixture-job',status:outcome,version:'3.4.7',checks:[{id:'fixture',passed:true}]}]}:initial;}};};
let mock=make();assert.equal(await deploy({...options,call:mock.call}),'passed');assert.equal(mock.paths.filter(p=>p==='/api/deploy').length,1);
mock=make('rolled_back');await assert.rejects(deploy({...options,call:mock.call}),/rolled_back/);assert.equal(mock.paths.filter(p=>p==='/api/deploy').length,1);
for(const state of [{success:true,ready:false,jobs:[]},{success:true,ready:true,jobs:[{status:'rollback_failed'}]}]){mock=make('passed',state);await assert.rejects(deploy({...options,call:mock.call}));assert(!mock.paths.includes('/api/deploy'));}
mock=make();await assert.rejects(deploy({...options,adapter:'wrong',call:mock.call}));assert(!mock.paths.includes('/api/deploy'));
mock=make();await assert.rejects(deploy({...options,source:source+'tampered',call:mock.call}));assert(!mock.paths.includes('/api/deploy'));
mock=make();assert.equal(await deploy({...options,manifest:{coreChanged:false},call:mock.call}),'baseline_passed');assert(!mock.paths.includes('/api/deploy'));
mock=make('verifying');await assert.rejects(deploy({...options,call:mock.call,polls:2}),/pending/);assert.equal(mock.paths.filter(p=>p==='/api/deploy').length,1);
mock=make();await assert.rejects(deploy({...options,call:async(p,b)=>{if(p==='/api/deploy'){await mock.call(p,b);throw Error('lost response');}return mock.call(p,b);}}),/lost response/);assert.equal(mock.paths.filter(p=>p==='/api/deploy').length,1);
assert.equal(validateVersion(source,'3.4.6'),'3.4.7');assert.throws(()=>validateVersion(source,'3.5.0'),/downgrade/);
for(const path of ['custom/src/index.js','.github/workflows/hostile.yml','.gitmodules','.gitignore'])assert.throws(()=>validateChanges([path]));validateChanges(['worker.js','changelog.json']);
// Exercise actual git bundles, guarded publishing and atomic branch updates against a disposable bare remote.
const temp=mkdtempSync(join(tmpdir(),'rex-auto-')),repo=join(temp,'repo'),remote=join(temp,'remote.git'),artifact=join(temp,'artifact');
const publisher=resolve('scripts/automatic-publish.mjs');
const fixtureEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
const git=(...a)=>execFileSync('git',a,{cwd:repo,env:fixtureEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=()=>{git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture');return git('rev-parse','HEAD');};
try{
 mkdirSync(repo);mkdirSync(artifact);git('init','--quiet');execFileSync('git',['init','--bare','--quiet',remote]);git('remote','add','origin',remote);mkdirSync(join(repo,'custom'));writeFileSync(join(repo,'worker.js'),'old core');writeFileSync(join(repo,'custom/maintenance.json'),JSON.stringify({customBranch:'codex/rex-custom',upstreamBranch:'main'}));const base=commit();git('branch','main');git('branch','codex/rex-custom');git('push','origin','main','codex/rex-custom');
 git('switch','-c','upstream-fixture');writeFileSync(join(repo,'worker.js'),source);const latest=commit();git('switch','-c','codex/automatic-candidate',base);git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','merge','--no-ff','--no-commit',latest);
 writeFileSync(join(repo,'custom/upstream.lock.json'),JSON.stringify({commit:latest,version:manifest.version,sha256:manifest.sha256}));const candidate=commit();git('bundle','create',join(artifact,'candidate.bundle'),'refs/heads/codex/automatic-candidate');writeFileSync(join(artifact,'manifest.json'),JSON.stringify({...manifest,base,latest,candidate,hasUpdate:true}));git('switch','--detach',base);
 execFileSync(process.execPath,[publisher],{cwd:repo,env:{...process.env,REX_ARTIFACT_DIR:artifact},stdio:'pipe'});
 assert(git('ls-remote','origin','refs/heads/codex/rex-custom').startsWith(candidate));assert(git('ls-remote','origin','refs/heads/main').startsWith(latest));
 const stale=spawnSync(process.execPath,[publisher],{cwd:repo,env:{...process.env,REX_ARTIFACT_DIR:artifact},encoding:'utf8'});assert.notEqual(stale.status,0);assert.match(stale.stderr,/branch changed/);
 writeFileSync(join(artifact,'manifest.json'),JSON.stringify({base:candidate,latest,hasUpdate:false}));execFileSync(process.execPath,[publisher],{cwd:repo,env:{...process.env,REX_ARTIFACT_DIR:artifact,REX_VERIFY_PUBLICATION:'true'},stdio:'pipe'});assert(git('ls-remote','origin','refs/heads/codex/rex-custom').startsWith(candidate));
}finally{rmSync(temp,{recursive:true,force:true});}
console.log('PASS: automatic update integrity, adapter drift, active recovery, rollback/timeout/lost-response stops, no duplicate deployment, protected-path refusal, bundle publishing and stale-branch refusal.');
