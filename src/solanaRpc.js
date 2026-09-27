'use strict';
/**
 * solanaRpc.js - read-only Solana JSON-RPC helper.
 * Only `getTokenAccountsByOwner` is used, to cross-check the $JEVBRAIN balance.
 * This module never builds, signs or sends transactions.
 */

async function getTokenBalance(rpcUrl, owner, mint) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message || data.error.code}`);
  let raw = 0n;
  let decimals = 0;
  for (const acc of data.result?.value || []) {
    const ta = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) continue;
    raw += BigInt(ta.amount);
    decimals = ta.decimals;
  }
  const ui = Number(raw) / 10 ** decimals;
  return { raw: raw.toString(), decimals, ui, accounts: (data.result?.value || []).length };
}

module.exports = { getTokenBalance };
