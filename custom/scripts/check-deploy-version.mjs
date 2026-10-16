import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cloudflare } from './cloudflare-api.mjs';

export function sourceVersion(source) {
  const header = source.match(/\/\/\s*VERSION:\s*v?(\d+\.\d+\.\d+)/i)?.[1];
  const runtime = source.match(/\bconst\s+CURRENT_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1];
  if (!header || header !== runtime) throw new Error('本地版本标记缺失或不一致，停止部署。');
  return runtime;
}

export function assertNoDowngrade(local, live) {
  if (![local, live].every(version => /^\d+\.\d+\.\d+$/.test(version))) throw new Error('无法确认版本，停止部署。');
  const left = local.split('.').map(Number), right = live.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return;
    if (left[i] < right[i]) throw new Error('停止部署：本地 v' + local + ' 低于线上 v' + live + '。请先同步线上或官方新版 src/worker.js，避免覆盖网页升级。');
  }
}

export async function checkDeployVersion() {
  const local = sourceVersion(await readFile(new URL('../src/worker.js', import.meta.url), 'utf8'));
  const configuration = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const scripts = cloudflare('/accounts/' + configuration.account_id + '/workers/scripts');
  if (!Array.isArray(scripts)) throw new Error('无法确认 Worker 清单，停止部署。');
  if (!scripts.some(script => script.id === configuration.name)) {
    console.log('Authenticated inventory confirms Worker absent; initial deployment v' + local + '.');
    return;
  }
  const credentials = await readFile(new URL('../admin-credentials.txt', import.meta.url), 'utf8');
  const password = credentials.match(/^管理员密码：(.+)$/m)?.[1]?.trim();
  if (!password) throw new Error('缺少本地管理员凭据，无法核对线上版本，停止部署。');
  const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const routes = JSON.parse(config).routes;
  let host = routes.find(route => route.custom_domain)?.pattern;
  // Prefer the verified client entry when configured, while restricting the
  // credential destination to a hostname explicitly bound in Wrangler.
  try {
    const privateConfig = JSON.parse(await readFile(new URL('../deployment-private.json', import.meta.url), 'utf8'));
    const preferred = new URL(privateConfig.base);
    if (preferred.protocol === 'https:' && routes.some(route => route.pattern.replace(/\/\*$/, '') === preferred.hostname)) {
      host = preferred.hostname;
    }
  } catch { /* Existing configurations can continue using their Custom Domain. */ }
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error('部署域名配置无效。');
  let live;
  try {
    const input = 'url = ' + JSON.stringify('https://' + host + '/api/version?t=' + Date.now()) + '\nheader = ' + JSON.stringify('Cookie: admin_token=' + password) + '\n';
    const raw = execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
      '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--config', '-'], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw);
    if (!result.success) throw new Error('Invalid version response');
    live = result.version;
  } catch {
    throw new Error('无法读取线上版本，停止部署；请检查网络和本地管理员凭据后重试。');
  }
  assertNoDowngrade(local, live);
  console.log('Version guard passed: local v' + local + ', live v' + live + '.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkDeployVersion().catch(error => { console.error(error.message); process.exitCode = 1; });
}
