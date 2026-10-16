import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
const id=process.argv[2];if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('Usage: node scripts/export-update-backup.mjs <record UUID>');
const query=sql=>JSON.parse(execFileSync('npx',['wrangler','d1','execute','rex-emby-proxy-db','--remote','--json','--command',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:24*1024*1024}))[0].results;
const record=query("SELECT data FROM rex_updates WHERE id='"+id+"'")[0];if(!record)throw Error('Record not found');
const j=JSON.parse(record.data),dir='backups/update-protection/'+id;mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const save=(name,data)=>writeFileSync(dir+'/'+name,data,{mode:0o600});
for(const kind of ['code','settings','configuration']){
 const rows=query("SELECT content FROM rex_update_chunks WHERE job='"+id+"' AND kind='"+kind+"' ORDER BY seq");const b=Buffer.concat(rows.map(r=>Buffer.from(r.content,'base64')));const expected=j[kind==='configuration'?'config':kind]?.sha256;if(!expected||createHash('sha256').update(b).digest('hex')!==expected)throw Error('Backup checksum mismatch: '+kind);save(kind==='code'?'source.multipart':kind+'.json',b);
}
save('source-content-type.txt',j.code.contentType||'');save('record.json',JSON.stringify(j,null,2)+'\n');console.log('Backup exported and SHA-256 verified: '+dir+' (private files; do not publish)');
