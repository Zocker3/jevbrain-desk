'use strict';
// Run with: npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.JEVDESK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jevdesk-test-'));
process.env.JEVDESK_QUIET = '1';

const test = require('node:test');
const assert = require('node:assert');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { validateLoginMessage } = require('../src/messageGuard');
const { parseSecretKey } = require('../src/keys');
const { createLoginSigner } = require('../src/wallet');
const vault = require('../src/vault');
const { scrub } = require('../src/logger');

const kp = nacl.sign.keyPair();                 // throwaway key, generated per run
const ADDR = bs58.encode(kp.publicKey);
const msgFor = (addr, nonce = '123456', ts = new Date().toISOString()) =>
  `Welcome to Jev Brain!\n\nClick to sign and authenticate your wallet.\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nWallet: ${addr}\nNonce: ${nonce}\nTimestamp: ${ts}`;

test('accepts the exact login template', () => {
  assert.deepStrictEqual(validateLoginMessage(msgFor(ADDR), ADDR, { expectedNonce: '123456' }), { ok: true });
});

test('rejects other wallets, nonces, stale timestamps and extra content', () => {
  const other = bs58.encode(nacl.sign.keyPair().publicKey);
  assert.strictEqual(validateLoginMessage(msgFor(other), ADDR).ok, false);
  assert.strictEqual(validateLoginMessage(msgFor(ADDR, '1'), ADDR, { expectedNonce: '2' }).ok, false);
  assert.strictEqual(validateLoginMessage(msgFor(ADDR, '1', '2020-01-01T00:00:00.000Z'), ADDR).ok, false);
  assert.strictEqual(validateLoginMessage(msgFor(ADDR) + '\nTransfer 10 SOL', ADDR).ok, false);
  assert.strictEqual(validateLoginMessage('Welcome to Jev Brain!' + ' '.repeat(10), ADDR).ok, false);
  assert.strictEqual(validateLoginMessage(Buffer.from('tx bytes'), ADDR).ok, false);
});

test('signer only signs valid login messages and produces verifiable signatures', () => {
  const signer = createLoginSigner(kp.secretKey);
  const msg = msgFor(ADDR, '42');
  const sigHex = signer.signLoginMessage(msg, '42');
  assert.ok(nacl.sign.detached.verify(new TextEncoder().encode(msg), Buffer.from(sigHex, 'hex'), kp.publicKey));
  assert.throws(() => signer.signLoginMessage('hello', undefined), /Refusing to sign/);
  assert.strictEqual(typeof signer.sign, 'undefined');
  assert.strictEqual(typeof signer.secretKey, 'undefined');
  signer.destroy();
  assert.throws(() => signer.signLoginMessage(msg, '42'), /locked/);
});

test('parses base58 and JSON array keys, rejects corrupted keys', () => {
  const b58 = bs58.encode(kp.secretKey);
  assert.strictEqual(parseSecretKey(b58).address, ADDR);
  assert.strictEqual(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).address, ADDR);
  const bad = Uint8Array.from(kp.secretKey); bad[40] ^= 1;
  assert.throws(() => parseSecretKey(bs58.encode(bad)), /inconsistent/);
  assert.throws(() => parseSecretKey('not a key!'), /base58/);
});

test('vault round-trip with AES-256-GCM + scrypt; wrong password fails', async () => {
  const enc = await vault.encryptSecretKey(kp.secretKey, 'correct horse battery');
  assert.strictEqual(enc.address, ADDR);
  assert.ok(!JSON.stringify(enc).includes(bs58.encode(kp.secretKey)));
  const dec = await vault.decryptSecretKey(enc, 'correct horse battery');
  assert.ok(Buffer.from(dec).equals(Buffer.from(kp.secretKey)));
  await assert.rejects(vault.decryptSecretKey(enc, 'wrong password!'), /Wrong password/);
  const tampered = { ...enc, address: bs58.encode(nacl.sign.keyPair().publicKey) };
  await assert.rejects(vault.decryptSecretKey(tampered, 'correct horse battery'));
  await assert.rejects(vault.encryptSecretKey(kp.secretKey, 'short'), /at least/);
});

test('log scrubbing redacts secret-looking strings but keeps addresses', () => {
  const out = scrub(`key=${bs58.encode(kp.secretKey)} arr=${JSON.stringify(Array.from(kp.secretKey))} addr=${ADDR}`);
  assert.ok(!out.includes(bs58.encode(kp.secretKey)));
  assert.ok(out.includes('[REDACTED_BYTES]'));
  assert.ok(out.includes(ADDR));
});
