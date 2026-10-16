import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = join(await mkdtemp(join(tmpdir(), 'rex-telegram-test-')), 'worker.mjs');
await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', platform: 'browser',
  loader: { '.txt': 'text' }, outfile: output, logLevel: 'silent' });
const { default: worker } = await import(pathToFileURL(output));
const env = { TG_BOT_TOKEN: 'test', TG_WEBHOOK_SECRET: 'secret', TG_CHAT_ID: '123',
  DB: { prepare() { return { async all() { return { results: [] }; }, async first() { return { count: 4 }; } }; } } };
const req = (id = 123, secret = 'secret', text = '/stats', from = id) => new Request('https://legacy.rex-custom.invalid/api/tg-webhook', {
  method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
  body: JSON.stringify({ message: { chat: { id, type: 'private' }, from: { id: from }, text } }),
});
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
try {
  assert.equal((await worker.fetch(req(), {}, {})).status, 503);
  assert.equal((await worker.fetch(req(123, 'wrong'), env, {})).status, 403);
  await worker.fetch(req(999), env, {});
  await worker.fetch(req(123, 'secret', '/stats', 999), env, {});
  assert.equal(sent.length, 0);
  assert.equal((await worker.fetch(req(), env, {})).status, 200);
  assert.equal(sent[0].chat_id, '123');
  assert(sent[0].text.includes('4 次') && sent[0].text.includes('合计：<b>0 B</b>'));
  assert.equal(sent[0].parse_mode, 'HTML');
  assert(sent[0].text.includes('📊 <b>今日观看情况播报</b>') && sent[0].text.includes('最多地区：无记录'));
  await worker.fetch(req(123, 'secret', '/start'), env, {});
  assert(sent[1].text.includes('/stats'));
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-15T20:00:00Z'])); }
    static now() { return new RealDate('2026-10-15T20:00:00Z').getTime(); }
  };
  const richEnv = { ...env, CF_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone-test', DB: { prepare(sql) {
    return { async all() { return { results: [{ prefix: 'one', remark: '<节点&一>' }] }; },
      async first() { return sql.includes('GROUP BY country') ? { country: 'CN', count: 3 }
        : sql.includes('LEFT JOIN') ? { remark: '<节点&一>', count: 4 } : { count: 4 }; } };
  } } };
  let failTraffic = false;
  let historyOnlyFailure = false;
  const queries = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('api.telegram.org')) { sent.push(body); return Response.json({ ok: true }); }
    queries.push(body.query);
    assert(body.query.includes('requestSource:"eyeball"'));
    assert(body.query.includes('panel.rex-custom.invalid') && body.query.includes('fast.rex-custom.invalid'));
    assert(body.query.includes('"/one/%"') && body.query.includes('"%/one/%"'));
    assert(!body.query.includes('httpRequests1dGroups') && !body.query.includes('datetime_leq:'));
    if (failTraffic || (historyOnlyFailure && body.query.includes('history0:'))) return Response.json({ errors: [{ message: 'permission denied' }] });
    const zone = body.query.includes('node0:') ? { node0: [{ sum: { edgeResponseBytes: 1024 } }] }
      : { history0: [{ sum: { edgeResponseBytes: 4096 } }], history1: [{ sum: { edgeResponseBytes: 8192 } }] };
    return Response.json({ data: { viewer: { zones: [zone] } } });
  };
  assert.equal((await worker.fetch(req(), richEnv, {})).status, 200);
  const report = sent.at(-1).text;
  assert(report.includes('🇨🇳 中国大陆（3 次）'));
  assert(report.includes('&lt;节点&amp;一&gt;（4 次）') && !report.includes('<节点'));
  assert(report.includes('今天：1.00 KB') && report.includes('合计：<b>1.00 KB</b>'));
  assert(report.includes('近 7 天：5.00 KB') && report.includes('近 30 天：9.00 KB'));
  assert(report.includes('Emby 节点流量') && report.includes('全部按北京时间') && !report.includes('域名区域流量'));
  const todayQuery = queries.find(query => query.includes('node0:'));
  const historyQuery = queries.find(query => query.includes('history0:'));
  assert(todayQuery.includes('datetime_geq:"2026-10-15T16:00:00.000Z"') && todayQuery.includes('datetime_lt:"2026-10-15T20:00:00.000Z"'));
  assert(historyQuery.includes('datetime_geq:"2026-10-09T16:00:00.000Z"'));
  assert(historyQuery.includes('datetime_geq:"2026-09-16T16:00:00.000Z"'));
  assert.equal((historyQuery.match(/datetime_lt:"2026-10-15T16:00:00.000Z"/g) || []).length, 2);
  const queryCount = queries.length;
  await worker.fetch(req(), richEnv, {});
  assert.equal(queries.length, queryCount, 'reuse both current and historical caches');
  historyOnlyFailure = true;
  await worker.fetch(req(), { ...richEnv, CF_ZONE_ID: 'history-error-zone' }, {});
  assert(sent.at(-1).text.includes('今天：1.00 KB') && sent.at(-1).text.includes('近 7 天：暂不可用'));
  historyOnlyFailure = false;
  assert(report.includes('👑 &lt;节点&amp;一&gt; · 1.00 KB') && report.includes('🥇'));
  assert(!report.includes('副面板'));
  failTraffic = true;
  await worker.fetch(req(), { ...richEnv, CF_ZONE_ID: 'different-zone' }, {});
  assert(sent.at(-1).text.includes('今天：暂不可用') && sent.at(-1).text.includes('流量统计暂不可用'));
  assert(sent.at(-1).text.includes('4 次'));
  globalThis.Date = RealDate;
  console.log('PASS: owner-only HTML reports, escaped labels, eyeball-only node filters, Beijing date windows, shared daily totals, historical sums, caching and failures.');
} finally { globalThis.fetch = realFetch; }
