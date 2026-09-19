'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav'
};

function createStaticServer(root, port = 0) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch (error) { response.writeHead(400).end('Bad request'); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filename = path.resolve(resolvedRoot, relative);
    if (filename !== resolvedRoot && !filename.startsWith(resolvedRoot + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(filename, (statError, stat) => {
      if (statError || !stat.isFile()) { response.writeHead(404).end('Not found'); return; }
      response.setHeader('Content-Type', MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(filename).pipe(response);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createStaticServer };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const port = Number(process.env.PORT) || 8765;
  createStaticServer(root, port).then(() => {
    console.log(`TF2 Voice Emulator: http://127.0.0.1:${port}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
