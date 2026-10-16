import assert from 'node:assert/strict';
import { sourceVersion, assertNoDowngrade } from './check-deploy-version.mjs';
import { build } from 'esbuild';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function bundle(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'browser', loader: { '.txt': 'text' }, write: false, logLevel: 'silent' });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
}

const worker = await bundle('src/index.js');
const patchBuild = await build({entryPoints:['src/self-update.js'],bundle:true,format:'esm',platform:'browser',loader:{'.txt':'text'},write:false,logLevel:'silent'});
const {patchProxyFetch} = await import('data:text/javascript;base64,'+Buffer.from(patchBuild.outputFiles[0].text).toString('base64'));
const patchedSource = await readFile('src/worker.js','utf8');
assert.equal(patchProxyFetch(patchedSource.replace('(arguments[1].REX_ORIGIN_FETCH || fetch)', 'fetch')),patchedSource);
assert.throws(()=>patchProxyFetch('export default {}'), /结构已变化/);

const env = { ADMIN_TOKEN: 'test-admin-secret', CF_API_TOKEN: 'test-api-secret',
  CF_ACCOUNT_ID: 'account-test', CF_WORKER_NAME: 'worker-test' };
const upstream = await readFile('src/worker.js', 'utf8');
const context = { waitUntil() {} };
const bindings = [
  { name: 'DB', type: 'd1', id: 'existing-database' },
  { name: 'ADMIN_TOKEN', type: 'secret_text' },
  { name: 'CF_API_TOKEN', type: 'secret_text' },
  { name: 'CF_ACCOUNT_ID', type: 'plain_text', text: env.CF_ACCOUNT_ID },
  { name: 'CF_WORKER_NAME', type: 'plain_text', text: env.CF_WORKER_NAME },
];
let uploads = [];
let providerSuccess = true;
let databasePresent = true;
env.UPDATE_GUARD={async fetch(request){
  const form=await request.formData();
  assert.equal(request.headers.get('Authorization'),'Bearer '+env.ADMIN_TOKEN);
  const manifest=JSON.parse(form.get('rex-manifest'));assert.equal(manifest.version,sourceVersion(upstream));assert.match(manifest.adapter,/^[a-f0-9]{64}$/);
  if(!databasePresent)return Response.json({success:false,error:'Missing DB binding'});
  const modules={};for(const name of ['index.js','worker.js','self-update.js','region-icons.js','index-source.txt','self-update-source.txt','region-icons-source.txt','entry-probes.js','entry-probes-source.txt'])modules[name]=await form.get(name).text();
  assert.equal(modules['worker.js'],upstream);
  for(const name of ['index','self-update','region-icons','entry-probes'])assert.equal(modules[name+'.js'],modules[name+'-source.txt']);
  assert(modules['entry-probes.js'].includes('measurement-v15-probe-readiness'));
  assert(modules['index.js'].includes('updateProtectionScript'));
  uploads.push(modules);
  return Response.json({success:providerSuccess,pending:providerSuccess,jobId:'test-update',version:manifest.version});
}};
const request = (body = { newCode: upstream }, cookie = true) => new Request('https://legacy.rex-custom.invalid/api/deploy', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'admin_token=' + env.ADMIN_TOKEN } : {}) },
  body: JSON.stringify(body),
});
try {
  assert.equal((await worker.fetch(new Request('https://panel.rex-custom.invalid/api/network-probe'), env, context)).status, 401);
  const probe = await worker.fetch(new Request('https://panel.rex-custom.invalid/api/network-probe', {
    headers: { Cookie: 'admin_token=' + env.ADMIN_TOKEN },
  }), env, context);
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal((await probe.arrayBuffer()).byteLength, 1024 * 1024);
  assert.equal((await worker.fetch(request({}, false), env, context)).status, 401);
  assert.equal(uploads.length, 0);
  assert.equal((await (await worker.fetch(request(), { ...env, UPDATE_GUARD: undefined }, context)).json()).success, false);
  assert.equal((await (await worker.fetch(request({ newCode: '' }), env, context)).json()).success, false);
  const current = sourceVersion(upstream);
  assert.throws(() => assertNoDowngrade('3.3.28', '3.3.29'));
  assert.doesNotThrow(() => assertNoDowngrade('3.3.29', '3.3.29'));
  assert.doesNotThrow(() => assertNoDowngrade('3.3.100', '3.3.99'));
  assert.throws(() => sourceVersion('// VERSION: 3.3.28\nconst CURRENT_VERSION = "3.3.29";'));
  const stale = upstream.replaceAll(current, '3.3.0');
  const staleResult = await (await worker.fetch(request({ newCode: stale }), env, context)).json();
  assert.equal(staleResult.success, false);
  assert(staleResult.error.includes('低于当前'));
  assert.equal(uploads.length, 0);
  databasePresent = false;
  assert.equal((await (await worker.fetch(request(), env, context)).json()).success, false);
  assert.equal(uploads.length, 0);
  databasePresent = true;
  assert.equal((await (await worker.fetch(request(), env, context)).json()).success, true);

  // Rebuild the exact uploaded multipart files and update a second time. This
  // proves the first update does not discard the updater or link adapter.
  const directory = await mkdtemp(join(tmpdir(), 'rex-updater-test-'));
  for (const [name, source] of Object.entries(uploads[0])) await writeFile(join(directory, name), source);
  const roundTripWorker = await bundle(join(directory, 'index.js'));
  assert.equal((await (await roundTripWorker.fetch(request(), env, context)).json()).success, true);
  assert.equal(uploads.length, 2);
  const html = await (await roundTripWorker.fetch(new Request('https://legacy.rex-custom.invalid/', {
    headers: { Cookie: 'admin_token=' + env.ADMIN_TOKEN },
  }), env, context)).text();
  assert(html.includes("return 'https://' + 'panel.rex-custom.invalid'"));
  for (const region of ['us', 'jp', 'de', 'hk']) {
    const response = await roundTripWorker.fetch(new Request('https://legacy.rex-custom.invalid/assets/regions/' + region + '.svg'), env, context);
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').startsWith('image/svg+xml'));
    assert((await response.text()).includes('<svg'));
  }
  providerSuccess = false;
  assert.equal((await (await worker.fetch(request(), env, context)).json()).success, false);
  console.log('PASS: auth, missing credentials, invalid input, missing DB guard, protected guard delegation, retained v15 module and update UI, two consecutive updates, custom domains, provider failure.');
} finally {}
