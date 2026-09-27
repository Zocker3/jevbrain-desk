'use strict';
/**
 * logger.js - small in-memory ring buffer + file log with secret scrubbing.
 *
 * Defence in depth: anything that looks like a private key, signature or
 * session token is redacted before it reaches the UI or the log file.
 * (Public wallet addresses are 32-44 chars and are left intact.)
 */
const fs = require('fs');
const { FILES, ensureDataDir } = require('./config');

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function scrub(text) {
  return String(text)
    // JSON byte arrays that could be a secret key
    .replace(/\[(\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, '[REDACTED_BYTES]')
    // long base58 strings (private keys are ~87-88 chars)
    .replace(/[1-9A-HJ-NP-Za-km-z]{60,}/g, '[REDACTED]')
    // long hex strings (signatures, raw keys)
    .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED_HEX]')
    // any very long opaque token (base64 / base64url)
    .replace(/[A-Za-z0-9+\/=_\-]{100,}/g, '[REDACTED_TOKEN]')
    // bearer / session style tokens (JWT-like)
    .replace(/[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.?[A-Za-z0-9_\-]*/g, '[REDACTED_TOKEN]');
}

class Logger {
  constructor() {
    this.entries = [];
    this.seq = 0;
    this.listeners = new Set();
  }

  log(level, message) {
    const entry = { id: ++this.seq, ts: new Date().toISOString(), level, message: scrub(message) };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    const line = `${entry.ts} [${level.toUpperCase()}] ${entry.message}`;
    if (process.env.JEVDESK_QUIET !== '1') console.log(line);
    this.appendFile(line + '\n');
    for (const fn of this.listeners) { try { fn(entry); } catch { /* ignore */ } }
    return entry;
  }

  info(m) { return this.log('info', m); }
  success(m) { return this.log('success', m); }
  warn(m) { return this.log('warn', m); }
  error(m) { return this.log('error', m); }

  since(id = 0) { return this.entries.filter(e => e.id > id); }

  appendFile(line) {
    try {
      ensureDataDir();
      try {
        if (fs.statSync(FILES.log).size > MAX_FILE_BYTES) fs.renameSync(FILES.log, FILES.log + '.1');
      } catch { /* no file yet */ }
      fs.appendFileSync(FILES.log, line, { mode: 0o600 });
    } catch { /* logging must never crash the app */ }
  }
}

module.exports = { Logger, scrub };
