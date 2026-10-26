import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from './src/decision.js';
import { GameSession } from './src/session.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export function createApp(config = loadConfig(), { decide } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400).end('Invalid request URL'); return; }
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, configured: config.configured }));
      return;
    }
    const file = FILES.get(pathname);
    if (!file) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(path.join(PUBLIC_DIR, file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500).end('Could not load the app.');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const sessions = new Map();
  server.on('upgrade', (request, socket, head) => {
    let allowed = request.url === '/ws';
    // Browsers may only connect from the same origin as this server.
    if (request.headers.origin) {
      try { allowed &&= new URL(request.headers.origin).host === request.headers.host; }
      catch { allowed = false; }
    }
    if (!allowed || wss.clients.size >= 20) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    const send = (payload) => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(JSON.stringify(payload));
    };
    const session = new GameSession(config, send, decide);
    sessions.set(ws, session);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let windowStart = Date.now();
    let messages = 0;
    ws.on('message', (raw, binary) => {
      if (binary) return;
      if (Date.now() - windowStart > 1000) { windowStart = Date.now(); messages = 0; }
      if (++messages > 80) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message && typeof message === 'object' && !Array.isArray(message)) session.command(message);
      } catch { send({ type: 'notice', message: 'Invalid game command.' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { session.close(); sessions.delete(ws); });
    session.publish();
  });
  const ticker = setInterval(() => {
    for (const session of sessions.values()) { session.tick(); session.publish(); }
  }, 50);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  server.on('close', () => { clearInterval(ticker); clearInterval(heartbeat); });
  const close = async () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    for (const session of sessions.values()) session.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return { server, wss, sessions, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number.');
    const app = createApp(config);
    app.server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Change PORT in .env.` : 'The HTTP server could not start.');
      void app.close().finally(() => { process.exitCode = 1; });
    });
    app.server.listen(port, host, () => {
      console.log(`Decision Tetris: http://${host}:${app.server.address().port}`);
      console.log(config.configured ? 'Foundry configured. Model mode is available.' : 'Local demo ready. Add your Foundry credentials to .env for model mode.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  } catch (error) {
    console.error(`Startup error: ${error.message}`);
    process.exitCode = 1;
  }
}
