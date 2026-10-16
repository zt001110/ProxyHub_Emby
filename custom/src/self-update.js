import indexSource from './index-source.txt';
import selfUpdateSource from './self-update-source.txt';
import regionIconsSource from './region-icons-source.txt';
import upstream from './worker.js';
import entryProbesSource from './entry-probes-source.txt';

function result(data) {
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}

// Preserve the request-scoped origin observer across upstream web updates.
export function patchProxyFetch(source) {
  if (source.includes('arguments[1].REX_ORIGIN_FETCH || fetch')) return source;
  let count = 0;
  const patched = source.replace(/(\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new Request\([^;]{1,400}?\),\s*[A-Za-z_$][\w$]*\s*=\s*await\s+)fetch\(\2\)/g,
    (_, before, name) => { count++; return before + '(arguments[1].REX_ORIGIN_FETCH || fetch)(' + name + ')'; });
  if (count !== 1) throw new Error('上游回源结构已变化，请使用本地 Wrangler 核对适配后更新。');
  return patched;
}

// Deploy all modules, including this updater, instead of overwriting the adapter
// with upstream's single-file build. This keeps the next update safe as well.
export async function deployUpdate(request, env) {
  if (!env.UPDATE_GUARD || !env.CF_ACCOUNT_ID || !env.CF_WORKER_NAME) {
    return result({ success: false, error: '独立更新检查器尚未绑定；未执行更新。' });
  }
  try {
    const { newCode } = await request.json();
    if (typeof newCode !== 'string' || !newCode.trim()) {
      return result({ success: false, error: '更新代码为空。' });
    }
    if (new TextEncoder().encode(newCode).length > 2 * 1024 * 1024) {
      return result({ success: false, error: '更新文件过大，请使用 Wrangler 部署。' });
    }
    if (!/\bexport\s+default\b/.test(newCode)) {
      return result({ success: false, error: '更新代码缺少 export default，未执行部署。' });
    }
    const version = newCode.match(/\bconst\s+CURRENT_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1];
    const marker = newCode.match(/\/\/\s*VERSION:\s*v?(\d+\.\d+\.\d+)/i)?.[1];
    if (!version || version !== marker) {
      return result({ success: false, error: '更新版本标记缺失或不一致，未执行部署。' });
    }
    const currentResponse = await upstream.fetch(new Request(new URL('/api/version', request.url), { headers: request.headers }), env, { waitUntil() {} });
    const currentVersion = (await currentResponse.json()).version;
    if (!currentResponse.ok || !/^\d+\.\d+\.\d+$/.test(currentVersion)) {
      return result({ success: false, error: '无法核对当前版本，未执行部署。' });
    }
    const nextParts = version.split('.').map(Number), currentParts = currentVersion.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (nextParts[i] > currentParts[i]) break;
      if (nextParts[i] < currentParts[i]) return result({ success: false, error: '更新被阻止：v' + version + ' 低于当前 v' + currentVersion + '，请刷新页面后重新检查更新。' });
    }

    if (!env.UPDATE_GUARD) return result({success:false,error:'独立更新检查器尚未绑定；未执行更新。'});
    const form = new FormData();
    form.append('rex-manifest', JSON.stringify({version,adapter:await adapterFingerprint()}));
    const modules = [
      ['index.js', indexSource, 'application/javascript+module'],
      ['worker.js', patchProxyFetch(newCode), 'application/javascript+module'],
      ['self-update.js', selfUpdateSource, 'application/javascript+module'],
      ['region-icons.js', regionIconsSource, 'application/javascript+module'],
      ['entry-probes.js', entryProbesSource, 'application/javascript+module'],
      ['index-source.txt', indexSource, 'text/plain'],
      ['self-update-source.txt', selfUpdateSource, 'text/plain'],
      ['region-icons-source.txt', regionIconsSource, 'text/plain'],
      ['entry-probes-source.txt', entryProbesSource, 'text/plain'],
    ];
    for (const [name, source, type] of modules) {
      form.append(name, new Blob([source], { type }), name);
    }
    return env.UPDATE_GUARD.fetch(new Request('https://update-guard/start', {method:'POST',headers:{Authorization:'Bearer '+env.ADMIN_TOKEN},body:form}));
  } catch {
    return result({ success: false, error: '更新请求未能完成，请刷新页面核对当前版本后重试；必要时使用 Wrangler 检查部署。' });
  }
}

async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function adapterFingerprint(){return hash(indexSource+'\n'+selfUpdateSource+'\n'+regionIconsSource+'\n'+entryProbesSource);}
export async function updateHealth(request,env){
 const {results:tables}=await env.DB.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();const config=[];
 for(const t of tables){if(!['routes','app_config','settings','config','users','rex_bot_owner'].includes(t.name))continue;const {results}=await env.DB.prepare('SELECT * FROM "'+t.name+'" LIMIT 10001').all();if(results.length>10000)throw Error('Configuration too large');config.push({name:t.name,schema:t.sql,rows:results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});}
 const r=await upstream.fetch(new Request(new URL('/api/version',request.url),{headers:request.headers}),env,{waitUntil(){}});const v=await r.json();
 return result({success:true,version:v.version,adapter:await adapterFingerprint(),configHash:await hash(JSON.stringify(config)),database:config.some(t=>t.name==='routes'),ownerBinding:!!(env.TG_BOT_TOKEN&&env.TG_WEBHOOK_SECRET),dnsBinding:!!env.CF_DNS_API_TOKEN,analyticsBinding:!!env.CF_ANALYTICS_TOKEN});
}
export async function updateProtection(request,env){
 if(!env.UPDATE_GUARD)return result({success:false,error:'独立更新检查器尚未绑定。'});
 const path=new URL(request.url).pathname;
 return env.UPDATE_GUARD.fetch(new Request('https://update-guard/'+(path.endsWith('/rollback')?'rollback':path.endsWith('/check')?'check':'status'),{method:request.method,headers:{Authorization:'Bearer '+env.ADMIN_TOKEN,'Content-Type':'application/json'},...(request.method==='POST'?{body:await request.text()}:{})}));
}

// The author update still uses /api/deploy. Keep its response pending until the
// independent guard confirms success or rollback, even across page reloads.
export const updateProtectionScript=String.raw`<script data-rex-update-protection="v1">
(()=>{
 const originalFetch=window.fetch.bind(window);let card,output,history,refreshing=false,watching=false;
 const names={preparing:'正在备份',ready:'备份完成，等待发布',deploying:'正在发布',verifying:'检查定制功能',passed:'检查通过',rolled_back:'已回滚',failed_before_deploy:'已停止，原版本保留',superseded:'检测到其它部署，已停止',rolling_back:'正在回滚',rollback_failed:'回滚待重试'};
 function render(j){output.textContent=names[j.status]||j.status;history.textContent='';
  const p=document.createElement('p');p.textContent='更新前 '+j.previousVersion+' → '+j.version+' · '+new Date(j.created).toLocaleString();history.appendChild(p);
  if(j.error||j.recoveryError){const e=document.createElement('p');e.textContent=j.recoveryError||j.error;history.appendChild(e);}
  const labels={'adapter-version-config-bindings':'版本、定制代码、配置与绑定','panel-speedtest-dns-update-controls':'面板测速、DNS 与更新控件','admin-session':'管理员会话','anonymous-access-blocked':'未登录访问拦截','speedtest-valid-payload':'测速数据完整性','candidate-planner-readonly':'候选规划接口','telegram-webhook-auth':'Telegram 回调鉴权','region-assets':'地区图标'};const rows=j.checks?.length?j.checks:j.baselineChecks||[];for(const c of rows){const d=document.createElement('div');d.textContent=(c.passed?'✅ ':'❌ ')+(labels[c.id]||c.id);history.appendChild(d);}
  const info=document.createElement('p');info.textContent='记录 ID：'+j.id+'；代码与配置快照已保存在数据库。';history.appendChild(info);
  const exportButton=document.createElement('button');exportButton.textContent='下载故障报告';exportButton.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(j,null,2)],{type:'application/json'}));a.download='rex-update-'+j.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};history.appendChild(exportButton);
  if(['passed','rollback_failed'].includes(j.status)){const b=document.createElement('button');b.textContent='回滚至更新前版本';b.style.marginLeft='12px';b.onclick=async()=>{if(!confirm('恢复此次更新前的代码版本？数据库新增设置会保留。'))return;b.disabled=true;try{const r=await originalFetch('/api/update-protection/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:j.id})});const x=await r.json();if(x.job)render(x.job);else output.textContent=x.error||'回滚未确认';}catch{output.textContent='回滚请求未确认，请刷新记录。';}finally{b.disabled=false;}};history.appendChild(b);}
 }
 async function status(){const r=await originalFetch('/api/update-protection/status',{cache:'no-store'});return r.json();}
 async function refresh(){if(refreshing)return;refreshing=true;try{const x=await status();if(!x.success){output.textContent=x.error;return;}if(!x.ready)output.textContent='尚未启用：独立检查器缺少 Workers Scripts 编辑凭据。';else if(!x.jobs.length)output.textContent='保护已就绪；下次更新前会自动备份。';if(x.jobs?.length)render(x.jobs[0]);if(x.jobs?.some(j=>['ready','deploying','verifying','rolling_back','rollback_failed'].includes(j.status))&&!watching){watching=true;watch(x.jobs[0].id).finally(()=>watching=false);}}catch{output.textContent='更新记录暂时不可用，请刷新。';}finally{refreshing=false;}}
 async function watch(id){for(let n=0;n<90;n++){try{const x=await status(),j=x.jobs?.find(j=>j.id===id);if(j){render(j);if(!['preparing','ready','deploying','verifying','rolling_back','rollback_failed'].includes(j.status))return {success:j.status==='passed',version:j.version,error:j.status==='rolled_back'?'检查失败，已回滚至更新前版本。':j.error||j.recoveryError,msg:'更新及关键功能检查完成。'};if(['ready','deploying','verifying'].includes(j.status))await originalFetch('/api/update-protection/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});}}catch{}await new Promise(r=>setTimeout(r,4000));}return {success:false,error:'后台仍在处理，请查看更新保护记录；不要重复更新。'};}
 window.fetch=async(input,options)=>{const r=await originalFetch(input,options);const path=typeof input==='string'?input:input.url;if(path&&new URL(path,location.origin).pathname==='/api/deploy'){let j;try{j=await r.clone().json();}catch{return r;}if(j.pending&&j.jobId){if(output)output.textContent=j.msg;const result=await watch(j.jobId);return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});}}return r;};
 function mount(){if(document.getElementById('rex-update-protection'))return;const host=document.getElementById('view-settings');if(!host)return;card=document.createElement('section');card.className='card admin-only';card.id='rex-update-protection';card.style.cssText='border:1px solid #168ba6;border-radius:14px;padding:18px;margin-top:18px;color:#cbd5e1;line-height:1.7';const title=document.createElement('strong');title.textContent='🛡 更新保护 · 自动备份与回滚';card.appendChild(title);output=document.createElement('p');card.appendChild(output);const reload=document.createElement('button');reload.textContent='刷新更新记录';reload.onclick=refresh;card.appendChild(reload);history=document.createElement('div');history.style.fontSize='13px';card.appendChild(history);const backup=document.getElementById('config-backup-card');if(backup)backup.before(card);else host.appendChild(card);refresh();}
 mount();new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();</script>`;
