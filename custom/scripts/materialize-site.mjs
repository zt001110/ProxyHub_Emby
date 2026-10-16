import {readFileSync,writeFileSync,mkdirSync,existsSync,symlinkSync,copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve,dirname,relative} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url)),custom=join(root,'custom');
const option=name=>{const n=process.argv.indexOf(name);return n<0?undefined:process.argv[n+1];};
const siteFile=resolve(option('--site')||join(custom,'site.local.json')),site=JSON.parse(readFileSync(siteFile));
const privateDir=resolve(site.deploymentDirectory),output=resolve(option('--output')||join(privateDir,'backups','fork-release-'+execFileSync('git',['rev-parse','--short=12','HEAD'],{cwd:root,encoding:'utf8'}).trim()));
const within=(p,base)=>{const r=relative(base,p);return r&&!r.startsWith('..')&&!r.startsWith('/');};
if(!within(output,join(privateDir,'backups'))&&!within(output,join(custom,'private-releases')))throw Error('Output must be inside private deployment backups/ or ignored custom/private-releases/.');
if(existsSync(output))throw Error('Output already exists; choose a new output directory. No overwrite performed.');
const replacements={...site.replacements};for(const [from,to]of Object.entries(site.replacements)){if(from.includes('.'))replacements[from.replaceAll('.','\\.')]=to.replaceAll('.','\\.');}const keys=Object.keys(replacements).sort((a,b)=>b.length-a.length);if(!keys.length)throw Error('Site replacements missing.');
for(const key of Object.keys(site.replacements)){if(!/^[a-z0-9_.-]+$/i.test(replacements[key]))throw Error('Only hostname/bot-name values are accepted.');}
const regex=new RegExp(keys.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
const files=execFileSync('git',['ls-files','-z','--','custom'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
mkdirSync(output,{recursive:true,mode:0o700});
for(const file of files){const target=join(output,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});const text=readFileSync(join(root,file),'utf8');writeFileSync(target,text.replace(regex,value=>replacements[value]),{mode:0o600});}
copyFileSync(join(root,'worker.js'),join(output,'worker.js'));
for(const name of ['wrangler.jsonc','update-guard/wrangler.jsonc']){const target=join(output,'custom',name);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(join(privateDir,name),target);}
for(const name of ['admin-credentials.txt','deployment-private.json']){if(existsSync(join(privateDir,name)))symlinkSync(join(privateDir,name),join(output,'custom',name));}
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();writeFileSync(join(output,'RELEASE.json'),JSON.stringify({revision,preparedAt:new Date().toISOString(),deployed:false,configurationCopiedFromPrivateDeployment:true},null,2)+'\n',{mode:0o600});
console.log('Prepared private release: '+output+'\nRun npm ci && npm test inside its custom/ directory. Production was not changed.');
