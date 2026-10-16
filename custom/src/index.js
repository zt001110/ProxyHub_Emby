import { prepareEntryProbes, cleanupEntryProbes, sweepEntryProbes, serveEntryProbe, probePayload, panelProbeScript, currentComparisonMarkup, panelControlsMarkup } from './entry-probes.js';
import upstream from './worker.js';
import { deployUpdate, updateHealth, updateProtection, updateProtectionScript } from './self-update.js';
import { regionIcons } from './region-icons.js';

// Keep the upstream release intact and customize only the panel's share URLs.
const originalEntryUrl = "return 'https://' + window.location.host + '/' + (PT.enabled ? PT.key + '/' : '') + prefix;";
const customEntryUrl = "return 'https://' + 'panel.rex-custom.invalid' + '/' + (PT.enabled ? PT.key + '/' : '') + prefix;";

const entryDnsName = 'panel.rex-custom.invalid';
const honestBrowserPing = panelProbeScript;

const cfIPv4Networks = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];
function ipv4Number(ip) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const parts = ip.split('.').map(Number);
  if (parts.some(part => part > 255)) return null;
  return parts.reduce((n, part) => n * 256 + part, 0);
}
function isCloudflareIPv4(ip) {
  const n = ipv4Number(ip);
  return n !== null && cfIPv4Networks.some(([base, bits]) =>
    Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits)));
}
function dnsResult(data) { return Response.json(data, { headers: { 'Cache-Control': 'no-store' } }); }
async function entryDns(request, env) {
  if (env.CF_DOMAIN !== entryDnsName) return dnsResult({ success: false, error: 'DNS 管理域名尚未配置为优选入口。' });
  const token = env.CF_DNS_API_TOKEN;
  // Read public DNS without giving the Worker persistent write access.
  if (!token && request.method === 'GET') {
    try {
      const response = await fetch('https://cloudflare-dns.com/dns-query?name=' + entryDnsName + '&type=A', { headers: { Accept: 'application/dns-json' } });
      const answer = await response.json();
      if (!response.ok || answer.Status !== 0) throw new Error();
      return dnsResult({ success: true, source: 'public-dns', writeEnabled: false,
        result: (answer.Answer || []).filter(row => row.type === 1).map(row => ({ type: 'A', name: entryDnsName, content: row.data, ttl: row.TTL, proxied: false })) });
    } catch { return dnsResult({ success: false, error: '公开 DNS 查询失败，请稍后重试。' }); }
  }
  if (!token) return dnsResult({ success: false, error: 'DNS 读取已可用；写入需要单独授权 DNS 编辑凭据。' });
  if (!/^[a-f0-9]{32}$/.test(env.CF_ZONE_ID || '')) return dnsResult({ success: false, error: 'DNS Zone 配置无效。' });
  const endpoint = 'https://api.cloudflare.com/client/v4/zones/' + env.CF_ZONE_ID + '/dns_records';
  async function api(suffix, body) {
    const response = await fetch(endpoint + suffix, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error('Cloudflare DNS 请求未成功（代码 ' + ((data.errors || []).map(e => e.code).join(', ') || response.status) + '）。');
    return data.result;
  }
  try {
    let ips;
    if (request.method === 'POST') {
      const body = await request.json();
      if (!Array.isArray(body.ips) || !body.ips.length || body.ips.length > 8 || body.ips.some(ip => typeof ip !== 'string' || !isCloudflareIPv4(ip))) {
        return dnsResult({ success: false, error: '仅支持 1–8 个 Cloudflare 官方 IPv4 地址；CNAME 和 IPv6 目标需先单独核验。' });
      }
      ips = [...new Set(body.ips)];
    }
    const records = await api('?name=' + encodeURIComponent(entryDnsName));
    if (!Array.isArray(records) || records.some(row => row.name !== entryDnsName)) throw new Error('DNS 查询范围不符，操作已停止。');
    if (request.method === 'GET') return dnsResult({ success: true, result: records, writeEnabled: true, source: 'cloudflare-api' });
    // One provider transaction avoids deleting the working record before a
    // replacement is accepted. Preserve TXT/MX and every other hostname.
    const addressRecords = records.filter(row => ['A', 'AAAA', 'CNAME'].includes(row.type));
    const keep = addressRecords.filter(row => row.type === 'A' && !row.proxied && ips.includes(row.content));
    const posts = ips.filter(ip => !keep.some(row => row.content === ip)).map(content => ({ type: 'A', name: entryDnsName, content, ttl: 60, proxied: false }));
    const deletes = addressRecords.filter(row => !keep.includes(row)).map(row => ({ id: row.id }));
    if (posts.length || deletes.length) await api('/batch', { posts, deletes });
    return dnsResult({ success: true, message: '✅ 优选入口 DNS 已更新；所有设备在 DNS 缓存刷新后生效。多条记录不会自动按运营商测速选路。' });
  } catch (error) { return dnsResult({ success: false, error: error.message || 'DNS 操作失败。' }); }
}

let cfUsageCache;
async function analyticsQuery(token, query) {
  if (!token) throw Error('缺少只读统计凭据');
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({query}), signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || data.errors?.length) throw Error('统计读取失败：' + String(data.errors?.[0]?.message || response.status).slice(0, 140));
  return data.data?.viewer;
}
function metricSum(rows, field) {
  if (!Array.isArray(rows)) throw Error('统计缺少数据');
  return rows.reduce((total, row) => {
    const value = field === 'count' ? row.count : row.sum?.[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('统计数值无效');
    return total + value;
  }, 0);
}
async function cfUsage(env, now = new Date()) {
  const cacheKey = JSON.stringify([env.CF_ZONE_ID, env.CF_ACCOUNT_ID, !!env.CF_WORKERS_ANALYTICS_TOKEN]);
  if (cfUsageCache?.key === cacheKey && cfUsageCache.until > Date.now()) return cfUsageCache.value;
  const start = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const end = now.toISOString();
  const filter = from => JSON.stringify({ datetime_geq: from.toISOString(), datetime_lt: end, requestSource: 'eyeball', clientRequestHTTPHost: 'panel.rex-custom.invalid' }).replace(/"([A-Za-z_][A-Za-z_0-9]*)":/g, '$1:');
  const todayFilter = filter(start);
  const fields = [0, 6, 29].map((days, i) => 'period' + i + ': httpRequestsAdaptiveGroups(limit:1,filter:' + filter(new Date(start.getTime() - days * 86400000)) + '){count sum{edgeResponseBytes}}').join('\n') +
    ['status|100|edgeResponseStatus', 'caches|100|cacheStatus', 'actions|100|securityAction', 'hours|24|datetimeHour', 'countries|250|clientCountryName'].map(spec => { const [name, limit, dimension] = spec.split('|'); return name + ':httpRequestsAdaptiveGroups(limit:' + limit + ',filter:' + todayFilter + '){count dimensions{' + dimension + '}}'; }).join('\n');
  const value = { success: true, scope: 'panel.rex-custom.invalid-eyeball', timezone: 'UTC', quota: null };
  await Promise.all([
    (async () => {
      try {
        const viewer = await analyticsQuery(env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN, '{viewer{zones(filter:{zoneTag:' + JSON.stringify(env.CF_ZONE_ID) + '}){' + fields + '}}}');
        const zone = viewer?.zones?.[0]; if (!zone) throw Error('没有域名统计权限');
        [value.today, value.week, value.month] = [0,1,2].map(i => metricSum(zone['period' + i], 'count'));
        value.bandwidth = metricSum(zone.period0, 'edgeResponseBytes');
        value.statusCodes = {'2xx':0,'3xx':0,'4xx':0,'5xx':0};
        for (const row of zone.status) { const key = Math.floor(Number(row.dimensions.edgeResponseStatus) / 100) + 'xx'; if (key in value.statusCodes) value.statusCodes[key] += metricSum([row], 'count'); }
        const cached = zone.caches.filter(r => ['hit', 'stale', 'revalidated', 'updating'].includes(r.dimensions.cacheStatus));
        value.cacheHitRatio = value.today ? Math.round(metricSum(cached,'count') * 10000 / value.today) / 100 : 0;
        value.blocked = metricSum(zone.actions.filter(r => r.dimensions.securityAction === 'block'), 'count');
        value.hours = Array(24).fill(0); for (const row of zone.hours) value.hours[new Date(row.dimensions.datetimeHour).getUTCHours()] += metricSum([row], 'count');
        value.countries = zone.countries.map(r => ({country: /^[A-Z]{2}$/.test(r.dimensions.clientCountryName) ? r.dimensions.clientCountryName : '未知', count: metricSum([r],'count')})).sort((a,b) => b.count-a.count).slice(0,10);
      } catch (error) { value.zoneError = error.message; }
    })(),
    (async () => {
      try {
        const token = env.CF_WORKERS_ANALYTICS_TOKEN;
        if (!token || !env.CF_ACCOUNT_ID) throw Error('账号用量需要 CF_WORKERS_ANALYTICS_TOKEN（账号分析只读）');
        const range = 'datetime_geq:' + JSON.stringify(start.toISOString()) + ',datetime_leq:' + JSON.stringify(end);
        const query = '{viewer{accounts(filter:{accountTag:' + JSON.stringify(env.CF_ACCOUNT_ID) + '}){all:workersInvocationsAdaptive(limit:1,filter:{' + range + '}){sum{requests}} rex:workersInvocationsAdaptive(limit:1,filter:{' + range + ',scriptName:' + JSON.stringify(env.CF_WORKER_NAME) + '}){sum{requests errors}}}}}';
        const viewer = await analyticsQuery(token, query); const account = viewer?.accounts?.[0]; if (!account) throw Error('没有账号统计权限');
        const requests = metricSum(account.all, 'requests');
        value.quota = {requests, workerRequests: metricSum(account.rex,'requests'), workerErrors: metricSum(account.rex,'errors'), referenceLimit:100000, percent: Math.round(requests / 1000 * 100) / 100, remain: Math.max(0,100000-requests), timezone:'UTC', scope:'account-all-workers', nextReset:new Date(start.getTime()+86400000).toISOString()};
      } catch (error) { value.quotaError = error.message; }
    })(),
  ]);
  cfUsageCache = {key:cacheKey,value,until:Date.now()+60000};
  return value;
}
const cfUsagePanelScript = `<script>
loadCfUsage = async function() {
 const el = id => document.getElementById(id), set = (id, text) => {const e=el(id);if(e)e.innerText=text;};
 try {
  const res=await fetch('/api/cfusage',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('HTTP '+res.status);const data=await res.json();if(!data.success)throw Error(data.error||'统计读取失败');
  const number=n=>Math.round(n).toLocaleString('zh-CN');
  for(const [id,key] of [['cfToday','today'],['cfWeek','week'],['cfMonth','month']])set(id,Number.isFinite(data[key])?number(data[key])+' 次':'不可用');
  set('cfBandwidth',Number.isFinite(data.bandwidth)?(data.bandwidth/1073741824).toFixed(2)+' GB':'不可用');
  set('cfCacheRatio',Number.isFinite(data.cacheHitRatio)?data.cacheHitRatio+'%':'不可用');set('cfBlocked',Number.isFinite(data.blocked)?number(data.blocked)+' 次':'不可用');set('cf5xx',data.statusCodes?number(data.statusCodes['5xx'])+' 次':'不可用');
  const q=data.quota;set('cfQuotaText',q?q.percent+'%（免费额度参考）':'账号用量暂不可用');if(el('cfQuotaBar'))el('cfQuotaBar').style.width=q?Math.min(100,q.percent)+'%':'0%';
  set('cfQuotaDetail',q?'账号全部 Worker：'+number(q.requests)+' 次 / 免费版参考 100,000 次；剩余约 '+number(q.remain)+' 次。本 Worker：'+number(q.workerRequests)+' 次，运行错误 '+number(q.workerErrors)+' 次。UTC 00:00（北京时间 08:00）重置。统计可能延迟/采样，非账单。':data.quotaError||'账号统计不可用');
  if(data.zoneError)set('cfCountryList',data.zoneError);else set('cfCountryList',data.countries.map(c=>c.country+'：'+number(c.count)+' 次').join(' · ')||'暂无请求');
  if(typeof Chart==='function'&&data.statusCodes){if(cfStatusChartInstance)cfStatusChartInstance.destroy();cfStatusChartInstance=new Chart(el('cfStatusChart').getContext('2d'),{type:'doughnut',data:{labels:Object.keys(data.statusCodes),datasets:[{data:Object.values(data.statusCodes),backgroundColor:['#34c759','#0a84ff','#ff9f0a','#ff3b30']}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{color:'#8e8e93'}}}}});if(cfHourChartInstance)cfHourChartInstance.destroy();cfHourChartInstance=new Chart(el('cfHourChart').getContext('2d'),{type:'line',data:{labels:Array.from({length:24},(_,i)=>i+'h'),datasets:[{label:'panel.rex-custom.invalid 入口请求（UTC）',data:data.hours,borderColor:'#00e5ff'}]},options:{responsive:true}});}
 }catch(e){set('cfQuotaText','读取失败');set('cfQuotaDetail',e.message);if(el('cfQuotaBar'))el('cfQuotaBar').style.width='0%';}
};
</script>`;

let bandwidthCache;
let historyBandwidthCache;

function formatBandwidth(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (unit ? value.toFixed(2) : String(value)) + ' ' + units[unit];
}

// Only Cloudflare edge-to-client bytes. Never add originResponseBytes or
// Content-Length: neither describes bytes delivered for an interrupted download.
function downloadBytes(group) {
  const value = group.sum?.edgeResponseBytes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('统计返回缺少下载字节数');
  return value;
}

function nodePaths(routes) {
  return routes.flatMap(route => {
    const path = '/' + route.prefix;
    return [
      { clientRequestPath: path }, { clientRequestPath_like: path + '/%' },
      { clientRequestPath_like: '%' + path }, { clientRequestPath_like: '%' + path + '/%' },
    ];
  });
}

function nodeTrafficFilter(routes, start, end) {
  return JSON.stringify({
    datetime_geq: start, datetime_lt: end, requestSource: 'eyeball',
    clientRequestHTTPHost_in: ['panel.rex-custom.invalid', 'fast.rex-custom.invalid'], OR: nodePaths(routes),
  }).replace(/"([A-Za-z_][A-Za-z_0-9]*)":/g, '$1:');
}

async function nodeBandwidth(routes, env, now = new Date()) {
  const analyticsToken = env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN;
  if (!analyticsToken || !env.CF_ZONE_ID) throw new Error('缺少只读统计配置 CF_ANALYTICS_TOKEN');
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const start = new Date(day + 'T00:00:00+08:00').toISOString();
  const key = JSON.stringify([env.CF_ZONE_ID, day, routes.map(route => route.prefix)]);
  if (bandwidthCache?.key === key && bandwidthCache.until > Date.now()) return bandwidthCache.values;
  const fields = routes.map((route, i) => {
    // Include legacy and Token-prefixed node URLs; exclude Worker subrequests.
    const filter = nodeTrafficFilter([route], start, now.toISOString());
    return 'node' + i + ': httpRequestsAdaptiveGroups(limit: 1, filter: ' + filter + ') { sum { edgeResponseBytes } }';
  }).join('\n');
  const query = 'query { viewer { zones(filter: {zoneTag: ' + JSON.stringify(env.CF_ZONE_ID) + '}) { ' + fields + ' } } }';
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: 'Bearer ' + analyticsToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    throw new Error(String(data.errors?.[0]?.message || '统计服务不可用').slice(0, 180));
  }
  const zone = data.data?.viewer?.zones?.[0];
  if (!zone) throw new Error('统计区域不可用或无读取权限');
  const values = Object.fromEntries(routes.map((route, i) => {
    const groups = zone['node' + i];
    if (!Array.isArray(groups)) throw new Error('统计返回缺少节点数据');
    return [route.prefix, groups.reduce((sum, group) => sum + downloadBytes(group), 0)];
  }));
  bandwidthCache = { key, values, until: Date.now() + 60000 };
  return values;
}

async function telegramMessage(env, text, html = false) {
  const stamp = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  text += '\n\n🕒 ' + (html ? '<i>' : '') + '更新于 ' + stamp + '（北京时间）' + (html ? '</i>' : '');
  const response = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, ...(html ? { parse_mode: 'HTML' } : {}), reply_markup: telegramKeyboard(), link_preview_options: {is_disabled:true} }), signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('Telegram 消息发送失败');
}

function escapeTelegram(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function countryLabel(country) {
  const code = String(country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return '未知地区';
  const flag = [...code].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
  const name = code === 'CN' ? '中国大陆' : new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code);
  return flag + ' ' + escapeTelegram(name);
}

async function nodeTrafficHistory(routes, env, now) {
  if (!routes.length) return [0, 0];
  const analyticsToken = env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN;
  if (!analyticsToken || !env.CF_ZONE_ID) throw new Error('缺少只读统计配置 CF_ANALYTICS_TOKEN');
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const key = JSON.stringify([env.CF_ZONE_ID, day, routes.map(route => route.prefix)]);
  if (historyBandwidthCache?.key === key && historyBandwidthCache.until > Date.now()) return historyBandwidthCache.values;
  const todayStart = new Date(day + 'T00:00:00+08:00').getTime();
  // Query completed Beijing days only. Add the exact current-day node sum below,
  // so all three totals share the same live data and today's value cannot differ.
  const fields = [6, 29].map((days, i) => {
    const start = new Date(todayStart - days * 86400000).toISOString();
    const filter = nodeTrafficFilter(routes, start, new Date(todayStart).toISOString());
    return 'history' + i + ': httpRequestsAdaptiveGroups(limit: 1, filter: ' + filter + ') { sum { edgeResponseBytes } }';
  }).join('\n');
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: 'Bearer ' + analyticsToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { viewer { zones(filter: {zoneTag: ' + JSON.stringify(env.CF_ZONE_ID) + '}) { ' + fields + ' } } }' }), signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok || data.errors?.length) throw new Error('历史统计服务不可用');
  const zone = data.data?.viewer?.zones?.[0];
  const values = [0, 1].map(i => {
    const rows = zone?.['history' + i];
    if (!Array.isArray(rows)) throw new Error('历史统计数据不可用');
    return rows.reduce((sum, row) => sum + downloadBytes(row), 0);
  });
  historyBandwidthCache = { key, values, until: Date.now() + 600000 };
  return values;
}

async function telegramStats(env) {
  const { results: routes } = await env.DB.prepare('SELECT prefix, remark FROM routes').all();
  const now = new Date();
  const todayWhere = "date(timestamp, '+8 hours') = date('now', '+8 hours')";
  const [plays, region, favorite, bytes, history] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM visitor_logs WHERE ' + todayWhere).first(),
    env.DB.prepare('SELECT country, COUNT(*) AS count FROM visitor_logs WHERE ' + todayWhere + ' GROUP BY country ORDER BY count DESC, country LIMIT 1').first(),
    env.DB.prepare("SELECT COALESCE(r.remark, v.prefix, '未知节点') AS remark, COUNT(*) AS count FROM visitor_logs v LEFT JOIN routes r ON v.prefix = r.prefix WHERE date(v.timestamp, '+8 hours') = date('now', '+8 hours') GROUP BY v.prefix ORDER BY count DESC, v.prefix LIMIT 1").first(),
    (routes.length ? nodeBandwidth(routes, env, now) : Promise.resolve({})).catch(() => null),
    nodeTrafficHistory(routes, env, now).catch(() => null),
  ]);
  const count = Number(plays?.count || 0);
  const todayBytes = bytes ? Object.values(bytes).reduce((a, b) => a + b, 0) : null;
  const daily = todayBytes === null ? '暂不可用' : formatBandwidth(todayBytes);
  const periods = history && todayBytes !== null ? history.map(value => formatBandwidth(value + todayBytes)) : ['暂不可用', '暂不可用'];
  const lines = ['📊 <b>今日观看情况播报</b>', '',
    '🔥 <b>今日总计播放：</b>' + count + ' 次', '',
    '🎞 以上为播放触发记录，不代表完整观看次数。',
    '🌍 最多地区：' + (region?.country ? countryLabel(region.country) + '（' + Number(region.count || 0) + ' 次）' : '无记录'),
    '🚀 今日最爱：' + (favorite?.remark ? escapeTelegram(String(favorite.remark).slice(0, 80)) + '（' + Number(favorite.count || 0) + ' 次）' : '无记录'), '',
    '🌐 <b>Emby 节点流量</b>', '📺 今天：' + daily,
    '📺 近 7 天：' + periods[0], '📺 近 30 天：' + periods[1], '',
    '🏆 <b>今日流量之王</b>'];
  if (bytes) {
    const sorted = [...routes].sort((a, b) => bytes[b.prefix] - bytes[a.prefix]);
    const winner = sorted[0];
    lines.push(winner && bytes[winner.prefix] > 0
      ? '👑 ' + escapeTelegram(String(winner.remark || winner.prefix).slice(0, 80)) + ' · ' + formatBandwidth(bytes[winner.prefix]) : '👑 暂无流量记录', '',
      '📡 <b>今日节点流量</b>', '合计：<b>' + daily + '</b>');
    for (const [i, route] of sorted.slice(0, 8).entries()) {
      lines.push((['🥇', '🥈', '🥉'][i] || '▫️') + ' ' + escapeTelegram(String(route.remark || route.prefix).slice(0, 80)) + '：' + formatBandwidth(bytes[route.prefix]));
    }
    if (sorted.length > 8) lines.push('另有 ' + (sorted.length - 8) + ' 个节点，详见面板。');
  } else lines.push('流量统计暂不可用，请稍后重试。');
  lines.push('', '🕒 <i>全部按北京时间统计；近 7/30 天均含今天。</i>',
    '<i>仅统计 Emby 节点发给客户端的下行量，不叠加回源；同一线路所有设备合计，CF 数据可能延迟或采样。</i>');
  await telegramMessage(env, lines.join('\n'), true);
}

function telegramKeyboard() {
  return {inline_keyboard:[
    [{text:'📊 观看概览',callback_data:'stats'},{text:'📥 下载流量',callback_data:'traffic'}],
    [{text:'📡 我的线路',callback_data:'nodes'},{text:'☁️ Worker 用量',callback_data:'usage'}],
    [{text:'🩺 运行状态',callback_data:'status'},{text:'📖 使用帮助',callback_data:'help'}],
    [{text:'🖥 打开管理面板',url:'https://panel.rex-custom.invalid/'}],
  ]};
}
async function telegramCall(env, method, body) {
  const response = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + method, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  const result = await response.json(); if (!response.ok || !result.ok) throw Error('Telegram API unavailable'); return result.result;
}
async function telegramHelp(env) {
 await telegramMessage(env, [
 '🎬 <b>Mlitm · Emby 私人管家</b>','━━━━━━━━━━━━━━',
 '👋 你好！线路、下载量和 Worker 用量，都可以在这里查询。','',
 '📊 /stats — 今日观看概览与线路排行',
 '📥 /traffic — 今天 / 近 7 天 / 近 30 天下载量',
 '📡 /nodes — 已配置的反代线路',
 '☁️ /usage — 账号与本 Worker 请求量',
 '🩺 /status — 机器人和数据库状态',
 '🖥 /panel — 打开管理面板',
 '📖 /help — 查看此菜单','',
 '🔒 仅绑定主人的私聊可查询；不会发送密码、反代密钥或带密钥链接。',
 '💡 点击下方按钮也能查询。',
 ].join('\n'), true);
}
async function telegramTraffic(env) {
 const {results:routes}=await env.DB.prepare('SELECT prefix, remark FROM routes').all();const now=new Date();
 const [bytes,history]=await Promise.all([routes.length?nodeBandwidth(routes,env,now).catch(()=>null):{},nodeTrafficHistory(routes,env,now).catch(()=>null)]);
 const today=bytes?Object.values(bytes).reduce((a,b)=>a+b,0):null;const fmt=n=>n===null?'暂不可用':formatBandwidth(n);
 const lines=['📥 <b>客户端下载流量</b>','━━━━━━━━━━━━━━','🗓 今天：<b>'+fmt(today)+'</b>','📅 近 7 天：'+fmt(today!==null&&history?today+history[0]:null),'🗓 近 30 天：'+fmt(today!==null&&history?today+history[1]:null),'','📡 <b>今日各线路</b>'];
 for(const route of routes.slice(0,20))lines.push('▫️ '+escapeTelegram(String(route.remark||route.prefix).slice(0,70))+'：'+fmt(bytes?bytes[route.prefix]:null));
 lines.push('','🕗 北京时间统计，近 7/30 天含今天。','💧 仅下行，不叠加回源；包含实际传输的视频、海报与接口数据。','📱 同一线路的所有设备合计。CF 数据可能延迟或采样；外部直连下载无法统计。');await telegramMessage(env,lines.join('\n'),true);
}
async function telegramNodes(env) {
 const {results:routes}=await env.DB.prepare('SELECT prefix, remark FROM routes').all();const lines=['📡 <b>我的反代线路</b>','━━━━━━━━━━━━━━','📦 共 '+routes.length+' 条已配置线路',''];
 for(const [i,route] of routes.slice(0,25).entries())lines.push('🔹 <b>'+escapeTelegram(String(route.remark||route.prefix).slice(0,70))+'</b>\n    路径：<code>/'+escapeTelegram(String(route.prefix).slice(0,80))+'</code>');
 lines.push('','🌐 统一入口：<code>panel.rex-custom.invalid</code>','🔐 完整连接地址请在管理面板复制。','ℹ️ 已配置不代表当前可回源或可播放；此指令不会对源站发起测速。');await telegramMessage(env,lines.join('\n'),true);
}
async function telegramUsage(env) {
 const data=await cfUsage(env);const q=data.quota,number=n=>Math.round(n).toLocaleString('zh-CN');
 const lines=['☁️ <b>Worker 用量看板</b>','━━━━━━━━━━━━━━'];
 if(q){const blocks=Math.min(10,Math.floor(q.percent/10));lines.push('📊 '+ '🟦'.repeat(blocks)+'⬜'.repeat(10-blocks)+' '+q.percent+'%','👥 账号全部 Worker：<b>'+number(q.requests)+' 次</b>','🎬 本反代：'+number(q.workerRequests)+' 次','🛠 Worker 运行错误：'+number(q.workerErrors)+' 次','🎟 免费版参考：100,000 次 / 天','🧮 参考剩余：约 '+number(q.remain)+' 次');}else lines.push('⚠️ 账号用量暂不可用，请稍后重试。');
 lines.push('','🌐 <b>panel.rex-custom.invalid 入口</b>');
 if(Number.isFinite(data.today))lines.push('📨 今天：'+number(data.today)+' 次','🗂 近 7 天：'+number(data.week)+' 次','📚 近 30 天：'+number(data.month)+' 次','📥 入口下行：'+formatBandwidth(data.bandwidth),'🧊 缓存命中：'+data.cacheHitRatio+'%','🛡 拦截：'+number(data.blocked)+' 次','🚧 HTTP 5xx：'+number(data.statusCodes['5xx'])+' 次');else lines.push('⚠️ 入口统计暂不可用。');
 lines.push('','🕗 本页按 UTC 日，北京时间 08:00 重置。','💡 额度由账号内 Worker 共用，不把回源子请求再累加。','⏳ CF 数据可能延迟或采样，100,000 为免费版参考，非账单。');await telegramMessage(env,lines.join('\n'),true);
}
async function telegramStatus(env) {
 const started=Date.now();let dbOk=false,total=0;try{const {results}=await env.DB.prepare('SELECT prefix FROM routes').all();total=results.length;dbOk=true;}catch{}
 await telegramMessage(env,['🩺 <b>私人管家运行状态</b>','━━━━━━━━━━━━━━','🤖 机器人：已响应','🗄 数据库：'+(dbOk?'✅ 可读取（'+(Date.now()-started)+' ms）':'⚠️ 读取失败'),'📡 已配置线路：'+total+' 条','📥 下载统计凭据：'+(env.CF_ANALYTICS_TOKEN?'✅ 已配置':'⚠️ 未配置'),'☁️ 账号统计凭据：'+(env.CF_WORKERS_ANALYTICS_TOKEN?'✅ 已配置':'⚠️ 未配置'),'🔒 私聊访问限制：已启用','','🕒 '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date())+'（北京时间）','ℹ️ 此结果仅说明机器人与配置状态，未验证各源站登录和播放。'].join('\n'),true);
}
async function telegramWebhook(request, env) {
 if(request.method!=='POST')return new Response('Method Not Allowed',{status:405});
 if(!env.TG_WEBHOOK_SECRET||!env.TG_BOT_TOKEN)return new Response('Not configured',{status:503});
 if(request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TG_WEBHOOK_SECRET)return new Response('Forbidden',{status:403});
 let update;try{update=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
 const callback=update.callback_query,message=callback?.message||update.message,from=callback?.from||message?.from;
 if(message?.chat?.type!=='private'||!from||String(message.chat.id)!==String(from.id))return new Response('OK');
 let owner=env.TG_CHAT_ID;
 if(!owner){
  if(!env.TG_PAIRING_CODE)return new Response('Not configured',{status:503});
  await env.DB.exec('CREATE TABLE IF NOT EXISTS rex_bot_owner (id INTEGER PRIMARY KEY CHECK(id=1), chat_id TEXT NOT NULL, bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  owner=(await env.DB.prepare('SELECT chat_id FROM rex_bot_owner WHERE id=1').first())?.chat_id;
  if(!owner){
   if(callback||message.text!=='/start '+env.TG_PAIRING_CODE)return new Response('OK');
   await env.DB.prepare('INSERT OR IGNORE INTO rex_bot_owner (id,chat_id) VALUES (1,?)').bind(String(from.id)).run();
   owner=(await env.DB.prepare('SELECT chat_id FROM rex_bot_owner WHERE id=1').first())?.chat_id;
  }
 }
 if(String(from.id)!==String(owner)||String(message.chat.id)!==String(owner))return new Response('OK');
 const target={...env,TG_CHAT_ID:String(owner)};
 const text=String(message.text||'').trim().split(/\s/)[0];const [base,address]=text.split('@');
 if(address&&address.toLowerCase()!=='rex_custom_example_bot')return new Response('OK');
 const command=callback?'/'+String(callback.data):base;
 try{
  if(callback)await telegramCall(target,'answerCallbackQuery',{callback_query_id:callback.id});
  if(command==='/stats')await telegramStats(target);
  else if(command==='/traffic')await telegramTraffic(target);
  else if(command==='/nodes')await telegramNodes(target);
  else if(command==='/usage')await telegramUsage(target);
  else if(command==='/status')await telegramStatus(target);
  else if(command==='/panel')await telegramMessage(target,'🖥 <b>管理面板</b>\n\n点击下方“打开管理面板”。管理密码仍需在网页输入。',true);
  else await telegramHelp(target);
 }catch{
  try{await telegramMessage(target,'😿 暂时没能完成这次查询。\n\n请稍后点击按钮重试；已有反代线路不会因此修改。',false);return Response.json({ok:true,report:'unavailable'});}catch{return new Response('Please retry',{status:502});}
 }
 return Response.json({ok:true,report:'sent'});
}

// Diagnostic timings for playback setup only: no URL, account, token, or media ID logs.
// Source requests have a bounded header wait. The timer is cleared when
// headers arrive; it never truncates an active video stream.
export function originObserver(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/' || path.startsWith('/api/') || path.startsWith('/assets/')) return null;
  const node = path.split('/').find(part => ['us-cf','jp','de','us1','us2','us3','hk'].includes(part));
  if (!node) return null;
  const category = /PlaybackInfo/i.test(path) ? 'playback-info' : /\/(?:videos|audio)\//i.test(path) ? 'media' : /\/Images\//i.test(path) ? 'image' : /\/(?:Items|Users)\//i.test(path) ? 'library' : 'api';
  const id = crypto.randomUUID();
  let attempt = 0;
  return { id, env: { ...env, REX_ORIGIN_FETCH: async (upstreamRequest) => {
    const started = Date.now(), current = ++attempt, controller = new AbortController();
    const timeoutMs = category === 'media' ? 20000 : 10000;
    const abort = () => controller.abort();
    upstreamRequest.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    const waiting = setTimeout(() => console.log(JSON.stringify({type:'rex-origin',id,node,category,attempt:current,stage:'waiting-4s',elapsedMs:Date.now()-started})),4000);
    try {
      const response = await fetch(new Request(upstreamRequest,{signal:controller.signal}));
      console.log(JSON.stringify({type:'rex-origin',id,node,category,attempt:current,stage:'headers',status:response.status,elapsedMs:Date.now()-started}));
      return response;
    } catch (error) {
      const stage = controller.signal.aborted ? 'aborted-before-headers' : 'fetch-error';
      console.log(JSON.stringify({type:'rex-origin',id,node,category,attempt:current,stage,elapsedMs:Date.now()-started}));
      throw new Error(stage === 'aborted-before-headers' ? 'Origin header wait aborted or timed out' : 'Origin network request failed');
    } finally { clearTimeout(timeout);clearTimeout(waiting);upstreamRequest.signal?.removeEventListener('abort',abort); }
  } } };
}

function playbackTiming(request, env) {
  if (!/\/PlaybackInfo$/i.test(new URL(request.url).pathname) || !env.DB) return null;
  const started = Date.now(), pending = new Map(), completed = [];
  const originals = new WeakMap(); let next = 0;
  async function timed(label, action) {
    const id = next++; pending.set(id, { label, started: Date.now() });
    try { return await action(); } finally { const item = pending.get(id); pending.delete(id); completed.push({ label, ms: Date.now() - item.started }); }
  }
  function statement(value) {
    const proxy = new Proxy(value, { get(target, name) {
      if (name === 'bind') return (...args) => statement(target.bind(...args));
      if (['first', 'all', 'run', 'raw'].includes(name)) return (...args) => timed(String(name), () => target[name](...args));
      const item = target[name]; return typeof item === 'function' ? item.bind(target) : item;
    } }); originals.set(proxy, value); return proxy;
  }
  const DB = new Proxy(env.DB, { get(target, name) {
    if (name === 'prepare') return (...args) => statement(target.prepare(...args));
    if (name === 'batch') return statements => timed('batch', () => target.batch(statements.map(item => originals.get(item) || item)));
    if (name === 'exec') return (...args) => timed('exec', () => target.exec(...args));
    const item = target[name]; return typeof item === 'function' ? item.bind(target) : item;
  } });
  function report(stage, status) { console.log(JSON.stringify({ type: 'rex-playback-timing', stage, colo: request.cf?.colo || 'unknown', elapsedMs: Date.now() - started, status, dbCompleted: completed.map(item => ({ method: item.label, ms: item.ms })), dbPending: [...pending.values()].map(item => ({ method: item.label, ms: Date.now() - item.started })) })); }
  const timer = setTimeout(() => report('waiting-8s'), 8000);
  return { env: { ...env, DB }, finish(status) { clearTimeout(timer); report('response-headers', status); } };
}

export default {
  ...upstream,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepEntryProbes(env));
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__rex_probe/')) return serveEntryProbe(request, env, isCloudflareIPv4);
    if ((path === '/api/get-dns' && request.method === 'GET') ||
        (path === '/api/update-dns' && request.method === 'POST') ||
        (path === '/api/prepare-entry-probes' && request.method === 'POST') ||
        (path === '/api/cleanup-entry-probes' && request.method === 'POST')) {
      const auth = await upstream.fetch(new Request(new URL('/api/me', request.url), { headers: request.headers }), env, ctx);
      if (!auth.ok) return auth;
      if ((await auth.json()).role !== 'admin') return new Response('Forbidden', { status: 403 });
      if (path === '/api/cleanup-entry-probes') return cleanupEntryProbes(request, env);
      return path === '/api/prepare-entry-probes' ? prepareEntryProbes(request, env, isCloudflareIPv4) : entryDns(request, env);
    }
    // Authenticated, bounded test data isolates client-to-Worker throughput
    // from Emby origin requests. No account or media information is returned.
    if (path === '/api/network-probe' && request.method === 'GET') {
      const auth = await upstream.fetch(new Request(new URL('/api/me', request.url), {
        headers: request.headers,
      }), env, ctx);
      if (!auth.ok) return auth;
      if ((await auth.json()).role !== 'admin') return new Response('Forbidden', { status: 403 });
      return probePayload(request);
    }
    if (path === '/api/cfusage' && request.method === 'GET') {
      const auth = await upstream.fetch(new Request(new URL('/api/me', request.url), {headers:request.headers}), env, ctx);
      if (!auth.ok) return auth;
      if ((await auth.json()).role !== 'admin') return new Response('Forbidden',{status:403});
      return Response.json(await cfUsage(env),{headers:{'Cache-Control':'no-store'}});
    }
    if (path === '/api/tg-webhook') return telegramWebhook(request, env);
    const regionAsset = /^\/assets\/regions\/(us|jp|de|hk)\.svg$/.exec(path);
    if (regionAsset && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : regionIcons[regionAsset[1]], {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if ((path === '/api/deploy' && request.method === 'POST') || path === '/api/update-health' || path.startsWith('/api/update-protection/')) {
      const auth = await upstream.fetch(new Request(new URL('/api/me', request.url), {
        headers: request.headers,
      }), env, ctx);
      if (!auth.ok) return auth;
      if ((await auth.json()).role !== 'admin') {
        return new Response('Forbidden', { status: 403 });
      }
      if (path === '/api/update-health') return updateHealth(request, env);
      if (path.startsWith('/api/update-protection/')) return updateProtection(request, env);
      return deployUpdate(request, env);
    }
    const isRoutes = path === '/api/routes' && request.method === 'GET';
    const isAnalytics = path === '/api/analytics' && request.method === 'GET';
    // The upstream per-node query misses Token prefixes and swallows API errors
    // as zero bytes. Let it handle auth/data, then supply validated statistics.
    const origin = originObserver(request, env);
    const timing = playbackTiming(request, origin?.env || env);
    let response;
    try { response = await upstream.fetch(request, timing?.env || origin?.env || (isRoutes || isAnalytics ? { ...env, CF_ZONE_ID: undefined } : env), ctx); }
    finally { timing?.finish(response?.status); }
    if (isAnalytics && response.ok) {
      const analytics = await response.json();
      if (!analytics.success) return Response.json(analytics, { headers: { 'Cache-Control': 'no-store' } });
      const { results: routes } = await env.DB.prepare('SELECT prefix, remark FROM routes').all();
      const now = new Date();
      const [bytes, history] = await Promise.all([
        routes.length ? nodeBandwidth(routes, env, now).catch(() => null) : {},
        nodeTrafficHistory(routes, env, now).catch(() => null),
      ]);
      const today = bytes ? Object.values(bytes).reduce((sum, value) => sum + value, 0) : null;
      analytics.trafficToday = today === null ? '统计不可用' : formatBandwidth(today);
      analytics.traffic7d = today !== null && history ? formatBandwidth(today + history[0]) : '统计不可用';
      analytics.traffic30d = today !== null && history ? formatBandwidth(today + history[1]) : '统计不可用';
      analytics.trafficScope = 'emby-node-eyeball';
      analytics.trafficTimezone = 'Asia/Shanghai';
      analytics.trafficMetric = 'edgeResponseBytes';
      analytics.trafficNote = '各线路全部客户端的下行量；排除回源、面板和测速。CF 统计可能延迟或采样，非设备账单精确值。';
      return Response.json(analytics, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (isRoutes && response.ok) {
      const routes = await response.json();
      if (!Array.isArray(routes)) return Response.json(routes);
      if (!routes.length) return Response.json(routes);
      try {
        const bytes = await nodeBandwidth(routes, env);
        for (const route of routes) route.todayBandwidth = formatBandwidth(bytes[route.prefix]);
      } catch (error) {
        for (const route of routes) {
          route.todayBandwidth = '统计不可用';
          route.bandwidthError = error.message;
        }
      }
      return Response.json(routes, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (new URL(request.url).pathname !== '/' ||
        !response.headers.get('content-type')?.includes('text/html')) {
      return response;
    }

    const html = await response.text();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('Cache-Control', 'no-store');
    const dnsExplanation = '<div style="color:#94a3b8;font-size:13px;line-height:1.7;margin-bottom:12px"><p>所有测试直接在本面板完成。当前入口与候选使用同一套完整下载测速，逐步显示已下载量、百分比和速度。辅助解析临时创建并在测完清理；正式 DNS 仅手动提交。</p><details><summary style="cursor:pointer">测速口径与清理说明</summary><p>响应为 3 次热连接请求的中位数；下载使用 4 MiB，快链路追加 8 MiB，速度不含建连和首包等待。测速反映当前浏览器网络路径；网页不能强制绕过系统代理，需由用户的分流规则保证直连，不等同 ICMP Ping 或视频源站带宽。CIDR 每网段抽样 4 个，最多 512 个候选，单批测试最多 100 个。当前入口固定首行，候选按通过、失败、跳过分组；通过项速度优先，同速时响应低优先。关闭页面或断网时，临时解析在 10 分钟到期后由每 5 分钟的清理任务重试回收。多条正式 DNS 不会自动按运营商选路，自动优选关闭。</p></details></div>';

    const trafficExplanation = '<p style="color:#94a3b8;font-size:13px;line-height:1.7">客户端下载流量：按线路汇总所有客户端收到的下行量，排除回源、面板和测速；按北京时间统计。Cloudflare 数据可能延迟或采样，不等同于设备或运营商账单的精确流量。外部直连下载无法统计。</p>';
    const adapted = html.replace(originalEntryUrl, customEntryUrl)
      .replace('预估延迟', '热连接响应')
      .replace('连通状态', '下载速度 / 测试状态')
      .replace('CF Worker 每日免费请求额度', '账号 Worker 每日请求量')
      .replace('CF请求 今天:', '入口请求 今天（UTC）:')
      .replace('今日带宽:', '入口下载量（UTC）:')
      .replaceAll('今日产生总流量', '今日客户端下载流量')
      .replace('<h2>已反代的媒体库 <span class="card-sub">拖拽卡片可排序</span></h2>', '<div><h2>已反代的媒体库 <span class="card-sub">拖拽卡片可排序</span></h2>' + trafficExplanation + '</div>')
      .replace('<textarea id="customIps"', panelControlsMarkup + dnsExplanation + '<textarea id="customIps"')
      .replace('<tbody id="testTableBody">', '<tbody id="rexCurrentBody">' + currentComparisonMarkup + '</tbody><tbody id="testTableBody">');
    const output = adapted.includes('</body>') ? adapted.replace('</body>', honestBrowserPing + cfUsagePanelScript + updateProtectionScript + '</body>') : adapted + honestBrowserPing + cfUsagePanelScript + updateProtectionScript;
    return new Response(output, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
