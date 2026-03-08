import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 5173);
const dryRun = process.argv.includes('--dry-run');

const mimeTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.gs': 'text/plain; charset=utf-8',
});

function detectEntryFile() {
  const explicit = String(process.env.ENTRY_FILE || '').trim();
  if (explicit) {
    const fullPath = path.resolve(rootDir, explicit);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return explicit.replaceAll('\\', '/');
    }
    throw new Error(`ENTRY_FILE was provided but not found: ${explicit}`);
  }

  const files = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name);

  const cameraHtml = files.find((name) => /^camera_[a-z0-9]+\.html$/i.test(name));
  if (cameraHtml) {
    return cameraHtml;
  }

  if (files.includes('index.html')) {
    return 'index.html';
  }

  const firstHtml = files.find((name) => name.toLowerCase().endsWith('.html'));
  if (firstHtml) {
    return firstHtml;
  }

  throw new Error('No HTML entry file was found in the project root.');
}

const entryFile = detectEntryFile();

if (!Number.isFinite(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

if (dryRun) {
  const entryUrl = `http://${host}:${port}/${entryFile}`;
  console.log(`Root directory : ${rootDir}`);
  console.log(`Entry file     : ${entryFile}`);
  console.log(`URL            : http://${host}:${port}/`);
  console.log(`Direct URL     : ${entryUrl}`);
  process.exit(0);
}

function toAbsolutePath(requestPathname) {
  const raw = decodeURIComponent(requestPathname);
  const normalized = raw === '/' ? `/${entryFile}` : raw;
  const joined = path.join(rootDir, normalized);
  const resolved = path.resolve(joined);
  const relative = path.relative(rootDir, resolved);
  const escapesRoot = relative.startsWith('..') || path.isAbsolute(relative);

  if (escapesRoot) {
    return null;
  }

  return resolved;
}

function respondJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const absolutePath = toAbsolutePath(requestUrl.pathname);

    if (requestUrl.pathname === '/health') {
      return respondJson(res, 200, { ok: true });
    }

    if (!absolutePath) {
      respondJson(res, 403, { ok: false, message: 'Forbidden' });
      return;
    }

    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      respondJson(res, 404, { ok: false, message: 'Not Found' });
      return;
    }

    if (!stats.isFile()) {
      respondJson(res, 404, { ok: false, message: 'Not Found' });
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    const stream = fs.createReadStream(absolutePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        respondJson(res, 500, { ok: false, message: 'Read error' });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch {
    respondJson(res, 500, { ok: false, message: 'Server error' });
  }
});

server.listen(port, host, () => {
  console.log(`Local server started: http://${host}:${port}/`);
  console.log(`Entry page          : http://${host}:${port}/${entryFile}`);
  console.log('Stop with Ctrl+C');
});
