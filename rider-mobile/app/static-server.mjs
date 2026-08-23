import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = 8082;

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const server = createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (path.endsWith('/')) path += 'index.html';
  let file = join(dist, path);
  // Try direct file
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // Try .html fallback for expo-router static routes like /login -> /login.html
    const htmlTry = file + '.html';
    if (existsSync(htmlTry)) file = htmlTry;
    else {
      // SPA fallback to index.html
      file = join(dist, 'index.html');
    }
  }
  // If still not found, fallback to index.html
  if (!existsSync(file)) file = join(dist, 'index.html');
  try {
    const data = readFileSync(file);
    const ext = extname(file);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + file);
  }
});

server.listen(port, () => {
  console.log(`Static server listening on http://localhost:${port} serving ${dist}`);
});
