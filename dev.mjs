/* Local preview: static files with clean URLs plus the api/ functions, storage in memory (INFERNO_MEMORY=1).
   node dev.mjs [port] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

process.env.INFERNO_MEMORY = process.env.INFERNO_MEMORY || '1';
const root = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.argv[2] || 8797);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const handlers = {};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      const name = p.slice(5).replace(/[^a-z0-9-]/g, '');
      const file = path.join(root, 'api', name + '.js');
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      handlers[name] = handlers[name] || (await import(file)).default;
      req.query = Object.fromEntries(url.searchParams);
      req.body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      return await handlers[name](req, res);
    }
    if (/^\/m\/0x[0-9a-fA-F]{40}$/.test(p)) p = '/token.html';
    if (p === '/') p = '/index.html';
    let file = path.join(root, p);
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.statusCode = 500;
    res.end(String(e.message || e));
  }
}).listen(port, () => console.log('inferno preview on http://localhost:' + port));
