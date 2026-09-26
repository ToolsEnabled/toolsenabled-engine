'use strict';

const http = require('node:http');

const body = Buffer.from(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ToolsEnabled sandbox fixture</title></head>
<body>
  <main>
    <h1>ToolsEnabled Playwright sandbox</h1>
    <p id="status">isolated fixture ready</p>
    <button id="check" type="button">Run check</button>
  </main>
  <script>
    document.getElementById('check').addEventListener('click', () => {
      document.getElementById('status').textContent = 'fixture interaction passed';
    });
  </script>
</body>
</html>`, 'utf8');

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
    response.end();
    return;
  }
  if (request.url !== '/' && request.url !== '/healthz') {
    response.writeHead(404, { 'Content-Length': '0' });
    response.end();
    return;
  }
  if (request.url === '/healthz') {
    const health = Buffer.from('ok\n', 'utf8');
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': health.length,
      'Cache-Control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : health);
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'"
  });
  response.end(request.method === 'HEAD' ? undefined : body);
});

server.listen(8080, '0.0.0.0');
