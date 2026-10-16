import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,readlinkSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const temp=mkdtempSync(join(tmpdir(),'rex-maintenance-')),root=join(temp,'repo'),privateDir=join(temp,'private');
function write(path,text){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);}
try{
 mkdirSync(root,{recursive:true});execFileSync('git',['init','--quiet'],{cwd:root});
 write(join(root,'.gitignore'),'custom/site.local.json\ncustom/src/worker.js\n');
 const core=readFileSync('../worker.js','utf8'),lock=JSON.parse(readFileSync('upstream.lock.json'));
 write(join(root,'worker.js'),core);write(join(root,'custom/upstream.lock.json'),JSON.stringify(lock));
 for(const name of ['prepare-upstream.mjs','materialize-site.mjs']){const target=join(root,'custom/scripts',name);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(join('scripts',name),target);}
 write(join(root,'custom/src/index.js'),"export const host='panel.rex-custom.invalid';\n");
 write(join(privateDir,'wrangler.jsonc'),'{"name":"private-target"}');write(join(privateDir,'update-guard/wrangler.jsonc'),'{"name":"private-guard"}');
 write(join(privateDir,'admin-credentials.txt'),'fixture credential kept outside git');write(join(privateDir,'deployment-private.json'),'{}');
 write(join(root,'custom/site.local.json'),JSON.stringify({deploymentDirectory:privateDir,replacements:{'panel.rex-custom.invalid':'panel.example.com'}}));
 execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture'],{cwd:root});
 execFileSync(process.execPath,['custom/scripts/prepare-upstream.mjs'],{cwd:root,stdio:'pipe'});const patched=readFileSync(join(root,'custom/src/worker.js'),'utf8');assert(patched.includes('arguments[1].REX_ORIGIN_FETCH || fetch'));
 write(join(root,'worker.js'),core+'\n// unreviewed change');const mismatch=spawnSync(process.execPath,['custom/scripts/prepare-upstream.mjs'],{cwd:root,encoding:'utf8'});assert.notEqual(mismatch.status,0);assert.equal(readFileSync(join(root,'custom/src/worker.js'),'utf8'),patched);write(join(root,'worker.js'),core);
 const output=join(privateDir,'backups','release');execFileSync(process.execPath,['custom/scripts/materialize-site.mjs','--output',output],{cwd:root,stdio:'pipe'});
 assert.equal(readFileSync(join(output,'custom/src/index.js'),'utf8'),"export const host='panel.example.com';\n");assert.equal(readFileSync(join(output,'custom/wrangler.jsonc'),'utf8'),'{"name":"private-target"}');assert.equal(readlinkSync(join(output,'custom/admin-credentials.txt')),join(privateDir,'admin-credentials.txt'));
 assert(!existsSync(join(output,'custom/site.local.json')));assert(!existsSync(join(output,'custom/src/worker.js')));
 const existing=spawnSync(process.execPath,['custom/scripts/materialize-site.mjs','--output',output],{cwd:root,encoding:'utf8'});assert.notEqual(existing.status,0);assert.equal(readFileSync(join(output,'custom/src/index.js'),'utf8'),"export const host='panel.example.com';\n");
 const unsafe=join(temp,'unsafe-public-output');const outside=spawnSync(process.execPath,['custom/scripts/materialize-site.mjs','--output',unsafe],{cwd:root,encoding:'utf8'});assert.notEqual(outside.status,0);assert(!existsSync(unsafe));
 console.log('PASS: unreviewed upstream refuses regeneration; private release maps site, preserves existing configurations, links rather than publishes credentials, excludes ignored files, and rejects overwrite or unsafe output.');
}finally{rmSync(temp,{recursive:true,force:true});}
