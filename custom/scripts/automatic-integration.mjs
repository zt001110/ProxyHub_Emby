// This runs without production credentials. The publisher never executes the candidate tree.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function validateChanges(paths) {
  if(paths.some(p=>p==='custom'||p.startsWith('custom/')||p==='.github'||p.startsWith('.github/')||p==='.gitignore'||p==='.gitmodules'))throw Error('Upstream touches automation/customization boundaries; manual integration required.');
}
export function validateVersion(source,previous) {
  const v=source.match(/const\s+CURRENT_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1];
  if(!v||source.match(/\/\/\s*VERSION:\s*v?(\d+\.\d+\.\d+)/)?.[1]!==v)throw Error('Invalid upstream version markers.');
  const a=v.split('.').map(Number),b=previous.split('.').map(Number);for(let i=0;i<3;i++){if(a[i]>b[i])break;if(a[i]<b[i])throw Error('Upstream version downgrade refused.');}return v;
}
const sha=s=>createHash('sha256').update(s).digest('hex');
export function prepare(root,out,{retryBlocked=false}={}) {
 const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const cfg=JSON.parse(readFileSync(resolve(root,'custom/maintenance.json'))),lock=JSON.parse(readFileSync(resolve(root,'custom/upstream.lock.json')));
 const base=git('rev-parse','HEAD');mkdirSync(out,{recursive:true});
 git('fetch','--no-tags','https://github.com/'+cfg.upstream+'.git',cfg.upstreamBranch);const latest=git('rev-parse','FETCH_HEAD');
 const manifest={base,latest,hasUpdate:latest!==lock.commit,coreChanged:process.env.REX_EXERCISE_DEPLOYMENT==='true',blocked:false,version:lock.version,sha256:lock.sha256};
 const output=()=>{writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');if(process.env.GITHUB_OUTPUT)for(const [k,v]of Object.entries(manifest))appendFileSync(process.env.GITHUB_OUTPUT,k+'='+v+'\n');};
 output();
 if(manifest.hasUpdate&&!retryBlocked&&process.env.GH_TOKEN){const issues=JSON.parse(execFileSync('gh',['api','repos/'+cfg.fork+'/issues?state=open&per_page=100'],{encoding:'utf8'}));if(issues.some(i=>i.title==='Automatic update blocked: '+latest)){manifest.blocked=true;output();return manifest;}}
 if(!manifest.hasUpdate)return manifest;
 if(spawnSync('git',['merge-base','--is-ancestor',lock.commit,latest],{cwd:root}).status!==0)throw Error('Upstream ancestry changed; manual integration required.');
 validateChanges(git('diff','--name-only',lock.commit,latest).split('\n'));
 const bytes=execFileSync('git',['show',latest+':worker.js'],{cwd:root,maxBuffer:8*1024*1024});
 manifest.version=validateVersion(bytes.toString(),lock.version);manifest.coreChanged=sha(bytes)!==lock.sha256;output();
 git('switch','-c','codex/automatic-candidate');git('merge','--no-ff','--no-commit',latest);
 writeFileSync(resolve(root,'custom/upstream.lock.json'),JSON.stringify({...lock,commit:latest,version:manifest.version,sha256:sha(bytes)},null,2)+'\n');
 git('add','custom/upstream.lock.json');git('-c','user.name=rex-update-automation','-c','user.email=rex-update-automation@users.noreply.github.com','commit','-m','Integrate upstream '+latest.slice(0,12)+' (v'+manifest.version+')');
 manifest.candidate=git('rev-parse','HEAD');manifest.sha256=sha(bytes);output();return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepare(process.cwd(),resolve(process.env.REX_ARTIFACT_DIR||'automatic-artifact'),{retryBlocked:process.env.REX_RETRY_BLOCKED==='true'});
