import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);const failures=[];
for(const file of files){
 if(/(^|\/)(backups|verification|node_modules|\.wrangler|private-releases)(\/|$)|(^|\/)(site\.local\.json|deployment-private\.json|admin-credentials\.txt|routes\.json|wrangler\.jsonc)$|\.sql$/.test(file))failures.push(file+': private/local-only path');
 if(!file.startsWith('custom/')&&!file.startsWith('.github/'))continue;
 const text=readFileSync(join(root,file),'utf8');
 if(/\/Users\/[^/]+\//.test(text))failures.push(file+': absolute personal path');
 if(/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|\d{6,12}:[A-Za-z0-9_-]{30,})\b/.test(text))failures.push(file+': credential-shaped literal');
 if(/"(?:account_id|CF_ACCOUNT_ID|CF_ZONE_ID)"\s*:\s*"(?!0{32}")[a-f0-9]{32}"/.test(text))failures.push(file+': live account/zone identifier');
}
if(failures.length)throw Error('Public-tree check failed:\n'+failures.join('\n'));
console.log('PASS: tracked tree excludes credentials, private deployment configuration, node exports, verification evidence and local release output.');
