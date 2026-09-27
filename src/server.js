#!/usr/bin/env node
'use strict';
/**
 * server.js - tiny local HTTP server (127.0.0.1 only) serving the UI and a JSON API.
 *
 * Hardening for a localhost app:
 *   - binds to 127.0.0.1 only;
 *   - rejects requests whose Host header is not our own (DNS-rebinding protection);
 *   - every /api call must carry the custom header `X-JevDesk: 1` and POSTs must be
 *     application/json, so other websites cannot forge requests (no CORS is ever granted);
 *   - strict Content-Security-Policy, no framing, no caching of API responses.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Demo mode (fake data, no wallet, no network): `npm run demo` or JEVDESK_DEMO=1.
// Uses a throwaway data directory in the OS temp folder so real app data is never touched.
const DEMO = process.argv.includes('--demo') || process.env.JEVDESK_DEMO === '1';
if (DEMO && !process.env.JEVDESK_DATA_DIR) {
  process.env.JEVDESK_DATA_DIR = path.join(os.tmpdir(), 'jevbrain-desk-demo');
}

const { App } = require('./app');
const { DemoApp } = require('./demo');
const { PUBLIC_DIR, DATA_DIR } = require('./config');
const pkg = require('../package.json');

const HOST = '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT || process.env.JEVDESK_PORT || 4777);
const NO_OPEN = process.argv.includes('--no-open') || process.env.JEVDESK_NO_OPEN === '1';
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const app = DEMO ? new DemoApp() : new App();
if (DEMO) app.keeper.start();
let port = PREFERRED_PORT;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function allowedHosts() {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function checkRequestOrigin(req) {
  if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) return 'Invalid Host header.';
  const origin = req.headers.origin;
  if (origin && ![...allowedHosts()].some(h => origin === `http://${h}`)) return 'Cross-origin requests are not allowed.';
  return null;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ------------------------------------------------------------------- routes
// Handlers return plain JSON objects. None of them ever returns key material or the session token.
const routes = {
  'GET /api/status': () => ({ ...app.status(), version: pkg.version }),
  'GET /api/state': (req, url) => app.fullState(Number(url.searchParams.get('since') || 0)),

  'POST /api/vault/setup': async (req, url, body) => app.setupVault(body.secretKey, body.password),
  'POST /api/vault/unlock': async (req, url, body) => app.unlock(body.password),
  'POST /api/vault/lock': () => { app.lock(); return { ok: true }; },
  'POST /api/vault/forget': (req, url, body) => {
    if (body.confirm !== 'DELETE') throw Object.assign(new Error('Type DELETE to confirm.'), { status: 400 });
    app.forget();
    return { ok: true };
  },

  'POST /api/refresh': () => app.refresh(),
  'POST /api/session/login': async () => { await app.login(); return app.sessionState(); },
  'POST /api/session/validate': async () => { await app.validateSession(); return app.sessionState(); },

  'POST /api/keeper/start': () => { app.requireClient(); app.keeper.start(); return app.keeper.state(); },
  'POST /api/keeper/stop': () => { app.keeper.stop(); return app.keeper.state(); },
  'POST /api/keeper/run-now': async () => { app.requireClient(); await app.keeper.runCycle({ manual: true }); return app.keeper.state(); },

  'GET /api/ledger': async () => ({ entries: await app.serverLedger() }),
  'GET /api/market/orders': async () => ({ orders: await app.orders() }),
  'POST /api/market/create': async (req, url, body) => {
    if (body.confirm !== true) throw Object.assign(new Error('Explicit confirmation required.'), { status: 400 });
    return app.createListing(body.creditsAmount, body.priceSol);
  },
  'POST /api/market/cancel': async (req, url, body) => {
    if (body.confirm !== true) throw Object.assign(new Error('Explicit confirmation required.'), { status: 400 });
    return app.cancelListing(body.orderId);
  },

  'GET /api/settings': () => app.settings,
  'POST /api/settings': (req, url, body) => app.updateSettings(body || {}),
};

async function handle(req, res) {
  const originError = checkRequestOrigin(req);
  if (originError) return send(res, 403, { error: originError });

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  }

  if (req.headers['x-jevdesk'] !== '1') return send(res, 403, { error: 'Missing X-JevDesk header.' });
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Unknown endpoint' });

  try {
    let body = {};
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Content-Type must be application/json.' });
      }
      body = await readBody(req);
    }
    const result = await handler(req, url, body);
    send(res, 200, result ?? { ok: true });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 && !err.data ? err.status : 400;
    send(res, status, { error: err.message || 'Unexpected error' });
  }
}

function openBrowser(target) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser available; the URL is printed anyway */ }
}

function listen(attempt = 0) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'Internal error' }));
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && attempt < 10) { port += 1; listen(attempt + 1); return; }
    console.error(`Could not start server: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const target = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log(`  Jev Brain Desk v${pkg.version}${DEMO ? '  [DEMO MODE - fake data]' : ''}`);
    console.log(`  Open:  ${target}`);
    console.log(`  Data:  ${DATA_DIR}`);
    console.log('  Press Ctrl+C to quit.');
    console.log('');
    if (!NO_OPEN) openBrowser(target);
  });

  const shutdown = () => { app.shutdown(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

listen();
