'use strict';
/**
 * keys.js - parse and verify Solana ed25519 secret keys.
 *
 * Accepted formats:
 *   - base58 string of a 64-byte secret key (Phantom / Solflare "export private key");
 *   - JSON byte array of 64 numbers (solana-keygen id.json format);
 *   - 32-byte seeds in either format are also accepted and expanded.
 */
const nacl = require('tweetnacl');
const bs58 = require('bs58');

function parseSecretKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Private key is empty.');

  let bytes;
  if (raw.startsWith('[')) {
    let arr;
    try { arr = JSON.parse(raw); } catch { throw new Error('Invalid JSON byte array.'); }
    if (!Array.isArray(arr) || !arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('JSON array must contain integers between 0 and 255.');
    }
    bytes = Uint8Array.from(arr);
  } else {
    try { bytes = bs58.decode(raw); } catch { throw new Error('Invalid base58 string.'); }
  }

  let keyPair;
  if (bytes.length === 64) {
    // Verify the public half matches the seed so corrupted keys are rejected early.
    const fromSeed = nacl.sign.keyPair.fromSeed(bytes.slice(0, 32));
    const pubOk = Buffer.from(fromSeed.publicKey).equals(Buffer.from(bytes.slice(32)));
    fromSeed.secretKey.fill(0);
    if (!pubOk) {
      bytes.fill(0);
      throw new Error('Secret key is inconsistent (public half does not match). Check that you copied it completely.');
    }
    keyPair = nacl.sign.keyPair.fromSecretKey(bytes);
  } else if (bytes.length === 32) {
    keyPair = nacl.sign.keyPair.fromSeed(bytes);
  } else {
    bytes.fill(0);
    throw new Error(`Private key must be 64 bytes (got ${bytes.length}).`);
  }
  const secretKey = Uint8Array.from(keyPair.secretKey);
  bytes.fill(0);
  keyPair.secretKey.fill(0);
  return { secretKey, address: bs58.encode(keyPair.publicKey) };
}

function addressFromSecretKey(secretKey) {
  return bs58.encode(secretKey.slice(32, 64));
}

function isValidAddress(addr) {
  if (typeof addr !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return false;
  try { return bs58.decode(addr).length === 32; } catch { return false; }
}

module.exports = { parseSecretKey, addressFromSecretKey, isValidAddress };
