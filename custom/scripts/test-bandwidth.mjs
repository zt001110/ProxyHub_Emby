import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = join(await mkdtemp(join(tmpdir(), 'rex-bandwidth-test-')), 'worker.mjs');
const built = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm',
  platform: 'browser', loader: { '.txt': 'text' }, outfile: output, logLevel: 'silent' });
const { default: worker } = await import(pathToFileURL(output));
const routes = [{ prefix: 'us-cf', target: 'https://example.com' }, { prefix: 'us1', target: 'https://example.org' }];
const DB = {
  async exec() {}, async batch() { return []; },
  prepare(sql) {
    return { bind() { return this; }, async run() { return {}; }, async first() { return null; },
      async all() { return { results: /FROM\s+routes\b/i.test(sql) ? routes.map(route => ({ ...route })) : [] }; } };
  },
};
const env = { DB, ADMIN_TOKEN: 'admin-test', CF_API_TOKEN: 'legacy-unused', CF_ANALYTICS_TOKEN: 'analytics-read-only', CF_ZONE_ID: 'zone-test' };
const request = () => new Request('https://legacy.rex-custom.invalid/api/routes', { headers: { Cookie: 'admin_token=admin-test' } });
const context = { waitUntil() {} };
let queries = 0, deny = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://raw.githubusercontent.com/')) return Response.json({ versions: [] });
  assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
  queries++;
  assert.equal(options.headers.Authorization, 'Bearer analytics-read-only');
  const { query } = JSON.parse(options.body);
  assert(query.includes('panel.rex-custom.invalid') && query.includes('fast.rex-custom.invalid'));
  assert(query.includes('"/us-cf/%"') && query.includes('"%/us-cf/%"'));
  assert(!query.includes('"/us1%"'));
  assert(query.includes('requestSource:"eyeball"'));
  assert(query.includes('edgeResponseBytes') && !query.includes('originResponseBytes'));
  assert(!query.includes('network-probe') && !query.includes('__rex_probe'));
  assert(query.includes('datetime_lt:') && !query.includes('datetime_leq:'));
  if (deny) return Response.json({ errors: [{ message: 'permission denied' }] });
  if (query.includes('history0:')) return Response.json({ data: { viewer: { zones: [{ history0: [], history1: [{ sum: { originResponseBytes: 999999999999, edgeResponseBytes: 1073741824 } }] }] } } });
  return Response.json({ data: { viewer: { zones: [{
    node0: [{ sum: { originResponseBytes: 999999999999, edgeResponseBytes: 1073741824 } }], node1: [{ sum: { edgeResponseBytes: 1024 } }],
  }] } } });
};
try {
  const unavailable = await (await worker.fetch(request(), env, context)).json();
  assert(unavailable.every(route => route.todayBandwidth === '统计不可用'));
  assert.equal(unavailable[0].bandwidthError, 'permission denied');
  deny = false;
  const result = await (await worker.fetch(request(), { ...env, CF_API_TOKEN: undefined }, context)).json();
  assert.equal(result[0].todayBandwidth, '1.00 GB');
  assert.equal(result[1].todayBandwidth, '1.00 KB');
  const count = queries;
  await worker.fetch(request(), env, context);
  assert.equal(queries, count);
  const unauth = await worker.fetch(new Request('https://legacy.rex-custom.invalid/api/routes'), env, context);
  assert.equal(unauth.status, 401);
  assert.equal(queries, count);
  const analyticsResponse = await worker.fetch(new Request('https://legacy.rex-custom.invalid/api/analytics', { headers: { Cookie: 'admin_token=admin-test' } }), env, context);
  const analytics = await analyticsResponse.json();
  assert.equal(analyticsResponse.headers.get('cache-control'), 'no-store');
  assert.equal(analytics.success, true);
  assert.equal(analytics.trafficScope, 'emby-node-eyeball');
  assert.equal(analytics.trafficTimezone, 'Asia/Shanghai');
  assert.equal(analytics.trafficToday, '1.00 GB');
  assert.equal(analytics.traffic7d, '1.00 GB');
  assert.equal(analytics.traffic30d, '2.00 GB');
  assert(Array.isArray(analytics.trend) && Array.isArray(analytics.locations) && Array.isArray(analytics.recents));
  const beforeUnauth = queries;
  assert.equal((await worker.fetch(new Request('https://legacy.rex-custom.invalid/api/analytics'), env, context)).status, 401);
  assert.equal(queries, beforeUnauth);
  deny = true;
  const unavailableAnalytics = await (await worker.fetch(new Request('https://legacy.rex-custom.invalid/api/analytics', { headers: { Cookie: 'admin_token=admin-test' } }), { ...env, CF_ZONE_ID: 'error-zone' }, context)).json();
  assert.equal(unavailableAnalytics.trafficToday, '统计不可用');
  assert.equal(unavailableAnalytics.traffic7d, '统计不可用');
  console.log('PASS: token and legacy paths, both hosts, node boundary, byte formatting, explicit API errors, cache, auth.');
} finally { globalThis.fetch = realFetch; }
