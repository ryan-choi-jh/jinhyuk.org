/**
 * src/cms/app/library/harness/server.mjs
 *
 * A static server for the harness, on 127.0.0.1 only. Two roots: the built
 * bundle first, then the repo's public/, so the catalogue's images and
 * thumbnails resolve from disk at exactly the paths the published site uses.
 * Nothing is proxied and nothing leaves the machine.
 *
 *   node src/cms/app/library/harness/server.mjs    # builds, then serves
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUT_DIR, build } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', '..', '..', '..', '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0]));
  if (clean.includes('..')) return null;
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  for (const root of [OUT_DIR, PUBLIC_DIR]) {
    const candidate = join(root, relative);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function startServer({ port = 0 } = {}) {
  const server = createServer((request, response) => {
    const file = resolveFile(request.url ?? '/');
    if (file === null) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });

  return new Promise((resolveServer) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({
        url: `http://127.0.0.1:${address.port}/`,
        port: address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await build();
  const { url } = await startServer({ port: Number(process.env.PORT ?? 5184) });
  process.stdout.write(`harness on ${url}\n`);
}
