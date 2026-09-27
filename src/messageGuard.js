'use strict';
/**
 * messageGuard.js
 *
 * The ONLY thing this application is ever allowed to sign is the Jev Brain
 * login challenge. This module validates a candidate message against the exact
 * template served by jevbrain.world before any signature is produced.
 *
 * The check is intentionally strict (stricter than a simple "startsWith"):
 *   - the whole message must match the known template, anchored at both ends;
 *   - it must name OUR wallet address;
 *   - it must carry the nonce the server returned alongside it (if provided);
 *   - its timestamp must be reasonably fresh;
 *   - it must explicitly state it will not trigger a blockchain transaction.
 *
 * If jevbrain.world ever changes its login text, signing will be refused until
 * this template is reviewed and updated. That is by design: fail closed.
 */

// Exact template observed from GET /api/wallet/nonce (Solana flow):
//
//   Welcome to Jev Brain!
//
//   Click to sign and authenticate your wallet.
//   This request will not trigger a blockchain transaction or cost any gas fees.
//
//   Wallet: <base58 address>
//   Nonce: <nonce>
//   Timestamp: <ISO-8601 UTC>
const LOGIN_TEMPLATE = new RegExp(
  '^Welcome to Jev Brain!\\n' +
  '\\n' +
  'Click to sign and authenticate your wallet\\.\\n' +
  'This request will not trigger a blockchain transaction or cost any gas fees\\.\\n' +
  '\\n' +
  'Wallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\\n' +
  'Nonce: ([A-Za-z0-9_-]{1,128})\\n' +
  'Timestamp: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z)$'
);

const MAX_MESSAGE_LENGTH = 1024;
// Generous freshness window to tolerate local clock skew.
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

/**
 * Validate a login message.
 * @param {unknown} message        Message text returned by the server.
 * @param {string}  expectedAddress Our own base58 wallet address.
 * @param {object}  [opts]
 * @param {string}  [opts.expectedNonce] Nonce returned next to the message.
 * @param {number}  [opts.now]           Override "now" (ms) for tests.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateLoginMessage(message, expectedAddress, opts = {}) {
  if (typeof message !== 'string') return { ok: false, reason: 'Message is not a string.' };
  if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: 'Message length is outside the allowed range.' };
  }
  const m = LOGIN_TEMPLATE.exec(message);
  if (!m) return { ok: false, reason: 'Message does not match the Jev Brain login template.' };

  const [, wallet, nonce, timestamp] = m;
  if (!expectedAddress || wallet !== expectedAddress) {
    return { ok: false, reason: 'Message names a different wallet address.' };
  }
  if (opts.expectedNonce !== undefined && opts.expectedNonce !== null &&
      String(opts.expectedNonce) !== nonce) {
    return { ok: false, reason: 'Message nonce does not match the nonce returned by the server.' };
  }
  const ts = Date.parse(timestamp);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'Message timestamp is not fresh (check your system clock).' };
  }
  return { ok: true };
}

module.exports = { validateLoginMessage, LOGIN_TEMPLATE, MAX_MESSAGE_LENGTH };
