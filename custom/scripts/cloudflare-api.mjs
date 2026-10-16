import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Reuse Wrangler's existing OAuth session; never print or persist its token.
export function cloudflare(path, options = {}) {
  return request(path, true, options);
}
function request(path, allowRefresh, options) {
  const config = readFileSync(homedir() + '/Library/Preferences/.wrangler/config/default.toml', 'utf8');
  const token = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error('Wrangler OAuth login required');
  const raw = execFileSync('curl', ['--silent', '--show-error', '--max-time', '30', '--config', '-'], {
    input: (options.method ? 'request = ' + JSON.stringify(options.method) + '\n' : '') + (options.body !== undefined ? 'header = "Content-Type: application/json"\ndata = ' + JSON.stringify(JSON.stringify(options.body)) + '\n' : '') + 'url = ' + JSON.stringify('https://api.cloudflare.com/client/v4' + path) + '\nheader = ' + JSON.stringify('Authorization: Bearer ' + token) + '\n',
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!raw.trim() && options.method === 'DELETE') return null;
  const data = JSON.parse(raw);
  if (!data.success && allowRefresh && data.errors?.some(error => error.code === 10000)) {
    // Wrangler refreshes its existing OAuth grant; no new access is requested.
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'whoami'], { stdio: 'pipe' });
    } catch { throw new Error('Wrangler session refresh failed; deployment stopped'); }
    return request(path, false, options);
  }
  if (!data.success) throw new Error('Cloudflare API failed: ' + JSON.stringify(data.errors?.map(e => ({ code: e.code, message: e.message }))));
  return data.result;
}
