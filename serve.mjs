/*
 * A static HTTPS server, because getUserMedia and getDisplayMedia need a secure
 * context. No dependencies: node and openssl are all it takes.
 *
 *   node serve.mjs            https://localhost:8443
 *   PORT=9443 node serve.mjs
 *
 * The certificate is self-signed, so each browser shows a warning the first time.
 * Accept it once per browser and the page loads normally afterwards.
 */
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8443);
const certDir = join(root, 'certs');
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');

if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.log('No certificate yet, generating a self-signed one...');
  execFileSync(join(root, 'make-cert.sh'), { stdio: 'inherit' });
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const options = {
  key: await readFile(keyPath),
  cert: await readFile(certPath)
};

createServer(options, async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'https://localhost').pathname);
  const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, relative);

  if (!file.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, () => {
  console.log(`Serving ${root} at https://localhost:${port}`);
});
