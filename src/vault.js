'use strict';
/**
 * vault.js - encrypted local storage for the wallet secret key.
 *
 * Format (data/vault.json):
 *   { version, address, kdf: { name: 'scrypt', N, r, p, salt }, cipher: { name: 'aes-256-gcm', iv, tag }, ciphertext }
 *
 * - The encryption key is derived from the user's password with scrypt.
 * - AES-256-GCM authenticates the ciphertext; the public address is bound as
 *   additional authenticated data (AAD) so the file cannot be silently edited.
 * - Only the PUBLIC address is stored in clear text (so the unlock screen can
 *   show which wallet it is).
 */
const crypto = require('crypto');
const fs = require('fs');
const { FILES, writeFileSecure, readJson } = require('./config');
const { addressFromSecretKey } = require('./keys');

const VERSION = 1;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSWORD_LENGTH = 8;

function deriveKey(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function aadFor(address) {
  return Buffer.from(`jevbrain-desk:v${VERSION}:${address}`, 'utf8');
}

async function encryptSecretKey(secretKey, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const address = addressFromSecretKey(secretKey);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt, SCRYPT);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aadFor(address));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
    return {
      version: VERSION,
      address,
      kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
      createdAt: new Date().toISOString(),
    };
  } finally {
    key.fill(0);
  }
}

async function decryptSecretKey(vault, password) {
  if (!vault || vault.version !== VERSION || vault.kdf?.name !== 'scrypt' || vault.cipher?.name !== 'aes-256-gcm') {
    throw new Error('Unsupported or corrupted vault file.');
  }
  const key = await deriveKey(password, Buffer.from(vault.kdf.salt, 'base64'), vault.kdf);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(vault.cipher.iv, 'base64'));
    decipher.setAAD(aadFor(vault.address));
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Wrong password (or the vault file was modified).');
  } finally {
    key.fill(0);
  }
  const secretKey = Uint8Array.from(plain);
  plain.fill(0);
  if (secretKey.length !== 64 || addressFromSecretKey(secretKey) !== vault.address) {
    secretKey.fill(0);
    throw new Error('Vault integrity check failed.');
  }
  return secretKey;
}

function loadVault() { return readJson(FILES.vault, null); }
function vaultExists() { return fs.existsSync(FILES.vault); }
function saveVault(vault) { writeFileSecure(FILES.vault, JSON.stringify(vault, null, 2)); }

/** Best-effort wipe: overwrite with random bytes, then delete. */
function deleteVault() {
  if (!fs.existsSync(FILES.vault)) return;
  try {
    const size = fs.statSync(FILES.vault).size;
    fs.writeFileSync(FILES.vault, crypto.randomBytes(Math.max(size, 256)));
  } catch { /* ignore */ }
  fs.unlinkSync(FILES.vault);
}

module.exports = {
  encryptSecretKey, decryptSecretKey, loadVault, saveVault, vaultExists, deleteVault, MIN_PASSWORD_LENGTH,
};
