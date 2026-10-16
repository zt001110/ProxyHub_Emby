import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function http(url, { cookie, body, method, userAgent = 'Rex/1.0', maxTime = 25, retries = 2 } = {}) {
  const resolveArgs = process.env.REX_HTTP_RESOLVE && new URL(url).hostname === 'panel.rex-custom.invalid' ? ['--resolve', 'panel.rex-custom.invalid:443:' + process.env.REX_HTTP_RESOLVE] : [];
  const lines = ['url = ' + JSON.stringify(url), 'user-agent = ' + JSON.stringify(userAgent)];
  if (cookie) lines.push('header = ' + JSON.stringify('Cookie: ' + cookie));
  if (method) lines.push('request = ' + JSON.stringify(method));
  if (body !== undefined) lines.push('header = "Content-Type: application/json"', 'data = ' + JSON.stringify(JSON.stringify(body)));
  const directory = await mkdtemp(join(tmpdir(), 'rex-http-'));
  const output = join(directory, 'body');
  // Secrets travel on stdin, never command arguments or console output.
  return await new Promise((resolve, reject) => {
    const child = execFile('curl', [...resolveArgs, ...(process.env.REX_HTTP_INTERFACE && (!process.env.REX_HTTP_RESOLVE || resolveArgs.length) ? ['--interface', process.env.REX_HTTP_INTERFACE] : []), '--silent', '--show-error', '--noproxy', '*', '--connect-timeout', '8', '--retry', String(retries), '--retry-all-errors', '--retry-delay', '1', '--max-time', String(maxTime), '--config', '-', '--output', output, '--write-out', '%{json}'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, async (error, stdout) => {
        let metrics;
        let responseBody;
        try { metrics = JSON.parse(stdout); responseBody = await readFile(output, 'utf8').catch(() => ''); }
        catch { return reject(new Error('HTTP request failed')); }
        finally { await rm(directory, { recursive: true, force: true }); }
        // Do not return metrics.url_effective: proxy URLs contain the key.
        const result = { status: metrics.http_code, tlsVerified: metrics.http_code > 0 && metrics.ssl_verify_result === 0,
          seconds: metrics.time_total, bytes: metrics.size_download, remoteIp: metrics.remote_ip, body: responseBody };
        if (error) result.error = 'Network/TLS error, curl exit ' + error.code;
        resolve(result);
      });
    child.stdin.end(lines.join('\n') + '\n');
  });
}
