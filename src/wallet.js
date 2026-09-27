'use strict';
/**
 * wallet.js - an in-memory signer that can ONLY sign the Jev Brain login message.
 *
 * There is deliberately no generic `sign(bytes)` method and no transaction
 * support. The secret key lives in a closure; it is never exposed, logged or
 * serialised. Call destroy() to wipe it from memory.
 */
const nacl = require('tweetnacl');
const { validateLoginMessage } = require('./messageGuard');
const { addressFromSecretKey } = require('./keys');

function createLoginSigner(secretKeyInput) {
  let secretKey = Uint8Array.from(secretKeyInput);
  const address = addressFromSecretKey(secretKey);

  return Object.freeze({
    address,
    /**
     * Sign a Jev Brain login challenge. Throws if the message is anything else.
     * @returns {string} hex-encoded detached ed25519 signature
     */
    signLoginMessage(message, expectedNonce) {
      if (!secretKey) throw new Error('Wallet is locked.');
      const check = validateLoginMessage(message, address, { expectedNonce });
      if (!check.ok) {
        throw new Error(`Refusing to sign: ${check.reason}`);
      }
      const sig = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
      return Buffer.from(sig).toString('hex');
    },
    get unlocked() { return !!secretKey; },
    destroy() {
      if (secretKey) secretKey.fill(0);
      secretKey = null;
    },
  });
}

module.exports = { createLoginSigner };
