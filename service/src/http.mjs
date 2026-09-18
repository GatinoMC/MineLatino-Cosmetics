import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, relative, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const cspHash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;

function staticSecurityHeaders(publicDir) {
  const scriptHashes = new Set(), styleHashes = new Set();
  const indexPath = publicDir ? join(publicDir, 'index.html') : '';
  if (indexPath && existsSync(indexPath)) {
    // HTML parsing normalizes CRLF and lone CR to LF before inline script/style
    // execution. Hash that browser-visible text, not the raw Windows file bytes.
    const html = readFileSync(indexPath, 'utf8').replace(/\r\n?/g, '\n');
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1]) scriptHashes.add(cspHash(match[1]));
    }
    for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      if (match[1]) styleHashes.add(cspHash(match[1]));
    }
    // CSP3's unsafe-hashes permits only these exact, developer-controlled
    // handler/style attributes; arbitrary injected inline code remains blocked.
    for (const match of html.matchAll(/\son[a-z]+\s*=\s*(["'])(.*?)\1/gis)) scriptHashes.add(cspHash(match[2]));
    for (const match of html.matchAll(/\sstyle\s*=\s*(["'])(.*?)\1/gis)) styleHashes.add(cspHash(match[2]));
  }
  const scriptSources = ["'self'", ...(scriptHashes.size ? ["'unsafe-hashes'", ...scriptHashes] : [])];
  const styleSources = ["'self'", ...(styleHashes.size ? ["'unsafe-hashes'", ...styleHashes] : [])];
  return {
    'Content-Security-Policy': `default-src 'self'; script-src ${scriptSources.join(' ')}; style-src ${styleSources.join(' ')}; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** Transport only; injectable API keeps HTTP smoke tests network-isolated. */
export function createHttpServer(api, origin, publicDir = null, { trustRailwayProxy = false, trustedProxyAddresses = [] } = {}) {
  const staticHeaders = staticSecurityHeaders(publicDir);
  return createServer({ maxHeaderSize: 8192, requestTimeout: 180_000, headersTimeout: 10_000 }, async (req, res) => {
    // Serve static files for the admin panel (only GET, only from publicDir)
    if (publicDir && req.method === 'GET' && !req.url.startsWith('/v1/') && !req.url.startsWith('/health')) {
      const requestedPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      let filePath = resolve(publicDir, `.${requestedPath}`);
      const relativePath = relative(publicDir, filePath);
      // Prevent path traversal
      if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        filePath = join(publicDir, 'index.html');
      }
      if (existsSync(filePath)) {
        const ext = extname(filePath);
        res.writeHead(200, { ...staticHeaders, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(readFileSync(filePath));
        return;
      }
    }
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const requestAbort = new AbortController();
      req.once('aborted', () => requestAbort.abort());
      res.once('close', () => { if (!res.writableEnded) requestAbort.abort(); });
      const request = new Request(`${origin}${req.url}`, {
        method: req.method, headers, signal: requestAbort.signal,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      });
      // Railway terminates TLS at its edge and supplies the original address in
      // X-Real-IP. Trust it only when the deployment explicitly says it is
      // running behind Railway; direct/local deployments keep using the socket.
      const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const trustForwarded = trustRailwayProxy || trustedProxyAddresses.includes(peer);
      const forwarded = trustForwarded ? req.headers['x-real-ip'] : undefined;
      const remoteAddress = typeof forwarded === 'string' && isIP(forwarded.trim())
        ? forwarded.trim()
        : req.socket.remoteAddress;
      const response = await api(request, remoteAddress);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Solicitud inválida"}'); }
  });
}
