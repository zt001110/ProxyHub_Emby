import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=fileURLToPath(new URL('../../',import.meta.url)),custom=join(root,'custom');
const cfg=JSON.parse(readFileSync(join(custom,'maintenance.json'))),file=join(custom,'upstream.lock.json'),lock=JSON.parse(readFileSync(file));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,stdio:'inherit'});if(r.status!==0)throw Error(command+' failed; integration branch preserved for inspection.');}
function validateRemote(name,repo){const url=git('remote','get-url',name);if(![...['https://github.com/','git@github.com:'].flatMap(prefix=>[prefix+repo,prefix+repo+'.git'])].includes(url))throw Error(name+' remote does not match '+repo);}
validateRemote('origin',cfg.fork);validateRemote('upstream',cfg.upstream);
run('git',['fetch','upstream',cfg.upstreamBranch]);const ref='refs/remotes/upstream/'+cfg.upstreamBranch,latest=git('rev-parse',ref),source=git('show',ref+':worker.js');
console.log(JSON.stringify({upstream:cfg.upstream,pinned:lock.commit,latest,hasUpdate:latest!==lock.commit},null,2));
if(process.argv.includes('--status')||latest===lock.commit)process.exit(0);
if(git('branch','--show-current')!==cfg.customBranch)throw Error('Switch to '+cfg.customBranch+' first.');
if(git('status','--porcelain'))throw Error('Worktree must be clean. Commit or preserve local changes first.');
if(spawnSync('git',['merge-base','--is-ancestor',lock.commit,ref],{cwd:root}).status!==0)throw Error('Upstream history changed; review manually. No reset/force performed.');
const version=source.match(/\bconst\s+CURRENT_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1],header=source.match(/\/\/\s*VERSION:\s*v?(\d+\.\d+\.\d+)/)?.[1];if(!version||version!==header)throw Error('Upstream version marker invalid.');
const branch='codex/upstream-'+latest.slice(0,12);
if(spawnSync('git',['show-ref','--verify','--quiet','refs/heads/'+branch],{cwd:root}).status===0)throw Error('Integration branch already exists: '+branch);
run('gh',['repo','sync',cfg.fork,'--source',cfg.upstream,'--branch',cfg.upstreamBranch]);
run('git',['fetch','origin',cfg.upstreamBranch]);
run('git',['switch','-c',branch]);
run('git',['merge','--no-ff','--no-commit',ref]);
// Read bytes from the merge result, preserving the exact author file hash.
const bytes=readFileSync(join(root,'worker.js'));writeFileSync(file,JSON.stringify({...lock,commit:latest,version,sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
run('npm',['test'],custom);run('node',['custom/scripts/check-public-tree.mjs']);
run('git',['add','custom/upstream.lock.json']);run('git',['commit','-m','Merge upstream v'+version+' into maintained customization']);
console.log('Validated integration branch: '+branch+'. No Cloudflare deployment performed.');
if(process.argv.includes('--pr')){
 run('git',['push','--set-upstream','origin',branch]);const temp=mkdtempSync(join(tmpdir(),'rex-sync-pr-'));
 try{const body=join(temp,'body.md');writeFileSync(body,'Merge author commit '+latest+' (v'+version+') while retaining the customization modules and independent backup/rollback guard.\n\nValidation: npm test and public-tree privacy checks passed. No production deployment is performed by this PR.\n');run('gh',['pr','create','--repo',cfg.fork,'--head',branch,'--base',cfg.customBranch,'--draft','--title','Sync upstream v'+version,'--body-file',body]);}finally{rmSync(temp,{recursive:true,force:true});}
}
