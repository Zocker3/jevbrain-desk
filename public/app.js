/* Jev Brain Desk - browser UI (vanilla JS).
 * Talks only to the local server on 127.0.0.1. All DOM updates use textContent /
 * createElement (no innerHTML with server data) to avoid injection. */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const ui = {
  state: null,
  lastLogId: 0,
  logs: [],
  view: 'dashboard',
  orders: [],
  pollTimer: null,
  farmLogCleared: 0,
};

// ------------------------------------------------------------------ helpers

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-JevDesk': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtInt = n => (n === null || n === undefined || Number.isNaN(Number(n))) ? '–' : Math.round(Number(n)).toLocaleString('en-US');
const fmtNum = (n, d = 2) => (n === null || n === undefined || Number.isNaN(Number(n))) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const fmtSol = n => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`;
const fmtUsd = n => {
  if (n === null || n === undefined) return '–';
  const v = Number(n);
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (v < 0.01) return `$${v.toPrecision(3)}`;
  return `$${v.toFixed(2)}`;
};
const fmtTime = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
const fmtClock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtCountdown(iso) {
  if (!iso) return '--:--';
  let s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  const hh = Math.floor(s / 3600); s -= hh * 3600;
  const mm = Math.floor(s / 60); const ss = s - mm * 60;
  const p = n => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}
function maskAddr(addr, force) {
  if (!addr) return '–';
  const priv = force ?? ui.state?.settings?.privacyMode;
  return priv ? `${addr.slice(0, 4)}••••••••${addr.slice(-4)}` : addr;
}
const shortAddr = a => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '–';

function setText(sel, text) { const el = $(sel); if (el) el.textContent = text; }
function setClass(sel, cls, on) { const el = $(sel); if (el) el.classList.toggle(cls, !!on); }

function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind === 'ok' ? 'toast-ok' : kind === 'err' ? 'toast-err' : ''}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

/** Promise-based confirmation modal. If `typeToConfirm` is set, the user must type it. */
function confirmDialog({ title, body, okText = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise(resolve => {
    const modal = $('#modal'); const ok = $('#modal-ok'); const cancel = $('#modal-cancel'); const input = $('#modal-input');
    $('#modal-title').textContent = title;
    const bodyEl = $('#modal-body'); bodyEl.replaceChildren(body instanceof Node ? body : document.createTextNode(body));
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    input.value = '';
    input.classList.toggle('hidden', !typeToConfirm);
    input.placeholder = typeToConfirm ? `Type ${typeToConfirm} to confirm` : '';
    ok.disabled = !!typeToConfirm;
    const onInput = () => { ok.disabled = input.value.trim() !== typeToConfirm; };
    const close = val => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel);
      input.removeEventListener('input', onInput); document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => close(typeToConfirm ? input.value.trim() : true);
    const onCancel = () => close(false);
    const onKey = e => { if (e.key === 'Escape') onCancel(); };
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
    input.addEventListener('input', onInput); document.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    (typeToConfirm ? input : cancel).focus();
  });
}

function dl(pairs) {
  return h('dl', {}, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------------ auth screens

async function boot() {
  const st = await api('GET', '/api/status');
  setText('#version', st.demo ? `v${st.version} · DEMO MODE` : `v${st.version} · 127.0.0.1 only`);
  if (st.unlocked) return enterMain();
  showAuth(st);
}

function showAuth(st) {
  stopPolling();
  $('#main').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#setup-form').classList.toggle('hidden', st.vaultExists);
  $('#unlock-form').classList.toggle('hidden', !st.vaultExists);
  if (st.vaultExists) { setText('#unlock-address', shortAddr(st.address)); $('#unlock-pass').focus(); }
  else $('#setup-key').focus();
}

$('#setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const key = $('#setup-key').value; const p1 = $('#setup-pass').value; const p2 = $('#setup-pass2').value;
  setText('#setup-error', '');
  if (p1 !== p2) return setText('#setup-error', 'Passwords do not match.');
  if (p1.length < 8) return setText('#setup-error', 'Password must be at least 8 characters.');
  await withBusy($('#setup-submit'), async () => {
    try {
      setText('#setup-submit', 'Encrypting…');
      const r = await api('POST', '/api/vault/setup', { secretKey: key, password: p1 });
      $('#setup-key').value = ''; $('#setup-pass').value = ''; $('#setup-pass2').value = '';
      toast(`Wallet saved: ${shortAddr(r.address)}`, 'ok');
      enterMain();
    } catch (err) { setText('#setup-error', err.message); }
    finally { setText('#setup-submit', 'Encrypt & save'); }
  });
});

$('#unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  setText('#unlock-error', '');
  await withBusy($('#unlock-submit'), async () => {
    try {
      setText('#unlock-submit', 'Unlocking…');
      await api('POST', '/api/vault/unlock', { password: $('#unlock-pass').value });
      $('#unlock-pass').value = '';
      enterMain();
    } catch (err) { setText('#unlock-error', err.message); }
    finally { setText('#unlock-submit', 'Unlock'); }
  });
});

$$('[data-toggle-visibility]').forEach(btn => btn.addEventListener('click', () => {
  const input = document.getElementById(btn.dataset.toggleVisibility);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
}));

async function forgetWallet() {
  const v = await confirmDialog({
    title: 'Forget wallet?',
    body: 'This permanently deletes the encrypted private key from this computer. Make sure you have a backup elsewhere. This cannot be undone.',
    okText: 'Delete key', danger: true, typeToConfirm: 'DELETE',
  });
  if (v !== 'DELETE') return;
  try {
    await api('POST', '/api/vault/forget', { confirm: 'DELETE' });
    toast('Encrypted key deleted.', 'ok');
    ui.state = null; ui.lastLogId = 0; ui.logs = [];
    showAuth(await api('GET', '/api/status'));
  } catch (err) { toast(err.message, 'err'); }
}
$('#unlock-forget').addEventListener('click', forgetWallet);
$('#s-forget').addEventListener('click', forgetWallet);

async function lockWallet() {
  try {
    await api('POST', '/api/vault/lock', {});
    ui.state = null;
    showAuth(await api('GET', '/api/status'));
  } catch (err) { toast(err.message, 'err'); }
}
$('#lock-btn').addEventListener('click', lockWallet);
$('#s-lock').addEventListener('click', lockWallet);

// ------------------------------------------------------------------ main app

function enterMain() {
  $('#auth').classList.add('hidden');
  $('#main').classList.remove('hidden');
  startPolling();
  loadOrders().catch(() => {});
}

function startPolling() {
  stopPolling();
  poll();
  ui.pollTimer = setInterval(poll, 2000);
}
function stopPolling() { clearInterval(ui.pollTimer); ui.pollTimer = null; }

async function poll() {
  try {
    const st = await api('GET', `/api/state?since=${ui.lastLogId}`);
    if (!st.status.unlocked) { showAuth(st.status); return; }
    const firstLoad = !ui.state;
    ui.state = st;
    if (st.logs.length) {
      ui.logs.push(...st.logs);
      if (ui.logs.length > 500) ui.logs.splice(0, ui.logs.length - 500);
      ui.lastLogId = st.logs[st.logs.length - 1].id;
    }
    render(firstLoad);
  } catch { /* server restarting; keep polling */ }
}

function switchView(view) {
  ui.view = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
  const titles = { dashboard: 'Dashboard', farm: 'Auto-farm', credits: 'Credits & history', market: 'Marketplace', settings: 'Settings' };
  setText('#view-title', titles[view]);
  if (view === 'market') loadOrders().catch(() => {});
  if (view === 'settings') fillSettings();
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
$$('[data-goto]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.goto)));

// ------------------------------------------------------------------ rendering

function render(firstLoad) {
  const st = ui.state; if (!st) return;
  const s = st.snapshot; const e = s.eligibility; const b = s.balance; const k = st.keeper;
  const addr = st.status.address;

  // header
  setText('#addr-chip', maskAddr(addr));
  setText('#updated-at', s.updatedAt ? `Last refreshed ${fmtAgo(s.updatedAt)} · ${fmtClock(s.updatedAt)}` : 'Not refreshed yet');
  const nonOfficial = st.settings.baseUrl !== st.officialBaseUrl;
  $('#nonofficial-banner').classList.toggle('hidden', !nonOfficial);
  setText('#nonofficial-url', st.settings.baseUrl);
  $('#demo-banner').classList.toggle('hidden', !st.status.demo);

  // sidebar
  setClass('#side-keeper-dot', 'ok', k.running && !k.consecutiveErrors);
  setClass('#side-keeper-dot', 'warn', k.running && k.consecutiveErrors > 0);
  setClass('#side-keeper-dot', 'pulse', k.busy);
  setText('#side-keeper-text', k.running ? (k.busy ? 'Keeper working…' : `Keeper on · ${fmtCountdown(k.nextRunAt)}`) : 'Keeper stopped');
  setClass('#side-session-dot', 'ok', st.session.valid);
  setClass('#side-session-dot', 'err', !st.session.valid && !!st.session.lastError);
  setText('#side-session-text', st.session.valid ? 'Session active' : (st.session.lastError ? 'Login failed' : 'No session'));

  // dashboard: credits
  setText('#d-credits', b ? fmtInt(b.available) : '–');
  setText('#d-earned', b ? fmtInt(b.earned) : '–');
  setText('#d-used', b ? fmtInt(b.used) : '–');
  setText('#d-redeemed', b ? fmtInt(b.redeemed) : '–');
  setText('#d-transferred', b ? fmtInt(b.transferred) : '–');
  const last = st.history[st.history.length - 1];
  setText('#d-last-accrual', last ? `Last attempt ${fmtAgo(last.ts)}: ${last.ok ? (last.accrued > 0 ? `+${fmtInt(last.accrued)} credits` : 'no new credits yet') : 'failed'}` : '');

  // countdown + keeper
  $('#d-keeper-toggle').checked = k.running;
  $('#f-keeper-toggle').checked = k.running;
  setText('#f-keeper-state', k.running ? (k.busy ? 'Running (working…)' : 'Running') : 'Stopped');
  setText('#d-keeper-line', k.running
    ? (k.consecutiveErrors ? `Retrying after ${k.consecutiveErrors} error(s)` : `Every ${k.intervalMin} min · last run ${fmtAgo(k.lastRunAt)}`)
    : 'Auto-farm is stopped');
  setText('#f-stats', k.running
    ? `Started ${fmtAgo(k.startedAt)} · last run ${fmtAgo(k.lastRunAt)}${k.consecutiveErrors ? ` · ${k.consecutiveErrors} consecutive error(s)` : ''}`
    : (k.lastRunAt ? `Last run ${fmtAgo(k.lastRunAt)}` : 'Not started'));
  tickCountdowns();

  // tier / rate / tokens
  if (e) {
    setText('#d-tier', e.tier || '–');
    setText('#d-tier-sub', `Level ${e.tierLevel ?? '–'} · ${e.eligible ? 'eligible holder' : 'not eligible'}`);
    const mult = b?.boostMultiplier || s.boost?.multiplier || 1;
    const eff = s.boost?.effectiveRatePerHour ?? (e.creditRatePerHour * mult);
    setText('#d-rate', fmtInt(eff));
    setText('#d-rate-sub', `${mult > 1 ? `${mult}x boost active` : 'No boost (1.0x)'} · ~${fmtInt(eff * 24)}/day`);
    setText('#d-tokens', fmtNum(e.balanceUi, 2));
    const usd = e.tokenPriceUsd && e.balanceUi ? e.balanceUi * e.tokenPriceUsd : null;
    const rpc = s.rpcBalance ? `RPC: ${fmtNum(s.rpcBalance.ui, 2)}` : (s.rpcError ? 'RPC check failed' : 'RPC: –');
    setText('#d-tokens-sub', `${usd ? `≈ ${fmtUsd(usd)} · ` : ''}${rpc}`);
    $('#d-tokens-sub').title = s.rpcError || '';
  } else {
    ['#d-tier', '#d-rate', '#d-tokens'].forEach(sel => setText(sel, '–'));
  }

  // session
  const sessEl = $('#d-session');
  sessEl.textContent = st.session.valid ? 'Active' : (st.session.lastError ? 'Login failed' : 'Not logged in');
  sessEl.className = `stat-value ${st.session.valid ? 'ok' : (st.session.lastError ? 'err' : 'warn')}`;
  setText('#d-session-sub', st.session.lastError && !st.session.valid
    ? st.session.lastError
    : (st.session.checkedAt ? `Checked ${fmtAgo(st.session.checkedAt)}` : 'Refresh or start the keeper to log in'));
  $('#d-session-sub').title = st.session.lastError || '';

  // wallet / market / redeem
  setText('#d-address', maskAddr(addr));
  $('#d-solscan').href = `https://solscan.io/account/${encodeURIComponent(addr || '')}`;
  setText('#d-price', s.market ? fmtUsd(s.market.priceUsd) : '–');
  setText('#d-mcap', s.market ? `MC ${fmtUsd(s.market.marketCap)} · 24h ${fmtNum(s.market.priceChange24h, 2)}%` : '\u00a0');
  if (s.redeemQuote) {
    setText('#d-redeem', fmtSol(s.redeemQuote.estimatedRewardSol || 0));
    setText('#d-redeem-sub', s.redeemQuote.warning || `for ${fmtInt(s.redeemQuote.credits)} credits (server quote)`);
  } else {
    setText('#d-redeem', '–'); setText('#d-redeem-sub', '\u00a0');
  }

  // logs
  renderLog('#d-log', ui.logs.slice(-30), true);
  renderLog('#f-log', ui.logs.filter(l => l.id > ui.farmLogCleared), $('#f-autoscroll').checked);

  // credits history
  renderHistory(st.history);

  // market form
  setText('#m-avail', b ? fmtInt(b.available) : '–');
  setText('#m-min-credits', st.limits.minListingCredits);
  setText('#m-min-price', st.limits.minListingPriceSol);

  if (firstLoad) {
    $('#f-interval').value = st.settings.intervalMin;
    fillSettings();
    if (!s.updatedAt) refresh(null, true);
  }
}

function renderLog(sel, entries, autoscroll) {
  const box = $(sel);
  const key = entries.length ? `${entries[0].id}-${entries[entries.length - 1].id}-${ui.state?.settings?.privacyMode}` : 'empty';
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const addr = ui.state?.status?.address;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...(entries.length ? entries.map(l => {
    let msg = l.message;
    if (addr && ui.state.settings.privacyMode) msg = msg.split(addr).join(maskAddr(addr, true));
    return h('div', { class: `log-line log-${l.level}` }, h('span', { class: 'log-ts' }, fmtClock(l.ts)), h('span', {}, msg));
  }) : [h('div', { class: 'log-line log-info' }, 'No log entries yet.')]));
  if (autoscroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderHistory(history) {
  const body = $('#c-hist-body');
  const key = `${history.length}-${history[history.length - 1]?.ts}`;
  if (body.dataset.key === key) return;
  body.dataset.key = key;
  const ok = history.filter(r => r.ok);
  const total = ok.reduce((a, r) => a + (r.accrued || 0), 0);
  setText('#c-hist-summary', history.length ? `${history.length} attempts · +${fmtInt(total)} credits accrued by this app` : '');
  if (!history.length) { body.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No accrual attempts yet.'))); return; }
  body.replaceChildren(...history.slice().reverse().map(r => h('tr', {},
    h('td', {}, fmtTime(r.ts)),
    h('td', {}, h('span', { class: `tag ${!r.ok ? 'tag-err' : r.accrued > 0 ? 'tag-ok' : 'tag-wait'}` }, !r.ok ? 'Error' : r.accrued > 0 ? 'Accrued' : 'Waiting'), r.manual ? ' manual' : ''),
    h('td', { class: 'num' }, r.accrued ? `+${fmtInt(r.accrued)}` : '0'),
    h('td', { class: 'num' }, r.available !== null && r.available !== undefined ? fmtInt(r.available) : '–'),
    h('td', { class: 'muted' }, r.reason || ''),
  )));
}

function tickCountdowns() {
  const k = ui.state?.keeper; if (!k) return;
  const text = k.running ? (k.busy ? 'working…' : fmtCountdown(k.nextRunAt)) : '--:--';
  setText('#d-countdown', text);
  setText('#f-countdown', text);
}
setInterval(tickCountdowns, 1000);

// ------------------------------------------------------------------ actions

async function refresh(btn, silent) {
  await withBusy(btn, async () => {
    try {
      const snap = await api('POST', '/api/refresh', {});
      if (!silent) {
        const errs = Object.keys(snap.errors || {});
        if (errs.length) toast(`Refreshed with issues: ${Object.values(snap.errors)[0]}`, 'err');
        else toast('Credits refreshed.', 'ok');
      }
      poll();
    } catch (err) { if (!silent) toast(err.message, 'err'); }
  });
}
$('#refresh-btn').addEventListener('click', e => refresh(e.currentTarget));

$('#accrue-now').addEventListener('click', e => withBusy(e.currentTarget, async () => {
  try {
    await api('POST', '/api/keeper/run-now', {});
    const last = (await api('GET', '/api/state?since=999999999')).history.slice(-1)[0];
    if (last && !last.ok) toast(`Accrual failed: ${last.reason}`, 'err');
    else if (last) toast(last.accrued > 0 ? `+${fmtInt(last.accrued)} credits` : `No new credits: ${last.reason}`, last.accrued > 0 ? 'ok' : 'info');
    poll();
  } catch (err) { toast(err.message, 'err'); }
}));
$('#f-run-now').addEventListener('click', () => $('#accrue-now').click());

async function setKeeper(on) {
  try { await api('POST', on ? '/api/keeper/start' : '/api/keeper/stop', {}); toast(on ? 'Auto-farm started.' : 'Auto-farm stopped.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
  poll();
}
$('#d-keeper-toggle').addEventListener('change', e => setKeeper(e.target.checked));
$('#f-keeper-toggle').addEventListener('change', e => setKeeper(e.target.checked));

$('#validate-btn').addEventListener('click', e => withBusy(e.currentTarget, async () => {
  try { const s = await api('POST', '/api/session/validate', {}); toast(s.valid ? 'Session is valid.' : 'Session is not valid (will re-login on next action).', s.valid ? 'ok' : 'info'); poll(); }
  catch (err) { toast(err.message, 'err'); }
}));
$('#relogin-btn').addEventListener('click', e => withBusy(e.currentTarget, async () => {
  try { await api('POST', '/api/session/login', {}); toast('Logged in.', 'ok'); poll(); }
  catch (err) { toast(`Login failed: ${err.message}`, 'err'); poll(); }
}));

$('#copy-addr').addEventListener('click', async () => {
  const addr = ui.state?.status?.address; if (!addr) return;
  try { await navigator.clipboard.writeText(addr); toast('Address copied.', 'ok'); } catch { toast('Clipboard not available.', 'err'); }
});

$('#f-interval-save').addEventListener('click', async () => {
  try { await api('POST', '/api/settings', { intervalMin: Number($('#f-interval').value) }); toast('Interval saved.', 'ok'); poll(); }
  catch (err) { toast(err.message, 'err'); }
});
$('#f-clear').addEventListener('click', () => { ui.farmLogCleared = ui.lastLogId; $('#f-log').dataset.key = ''; render(); });

// credits: server ledger
$('#c-ledger-load').addEventListener('click', e => withBusy(e.currentTarget, async () => {
  const body = $('#c-ledger-body');
  try {
    const { entries } = await api('GET', '/api/ledger');
    if (!entries.length) { body.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No ledger entries.'))); return; }
    body.replaceChildren(...entries.map(x => h('tr', {},
      h('td', {}, fmtTime(x.timestamp)),
      h('td', {}, h('span', { class: `tag ${x.amount >= 0 ? 'tag-ok' : 'tag-err'}` }, x.type || '?')),
      h('td', { class: 'num' }, `${x.amount > 0 ? '+' : ''}${fmtInt(x.amount)}`),
      h('td', { class: 'num' }, fmtInt(x.balanceAfter)),
      h('td', { class: 'num' }, x.effectiveRatePerHour !== null ? fmtInt(x.effectiveRatePerHour) : '–'),
    )));
  } catch (err) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, `Could not load ledger: ${err.message}`)));
  }
}));

// ------------------------------------------------------------------ marketplace

async function loadOrders() {
  try {
    const { orders } = await api('GET', '/api/market/orders');
    ui.orders = orders;
  } catch (err) {
    ui.orders = null;
    const row = msg => h('tr', {}, h('td', { colspan: 5, class: 'empty' }, msg));
    $('#m-mine-body').replaceChildren(row(`Could not load orders: ${err.message}`));
    $('#m-all-body').replaceChildren(row(`Could not load orders: ${err.message}`));
    return;
  }
  const mine = ui.orders.filter(o => o.mine);
  const others = ui.orders.slice().sort((a, b) => a.ratePer1k - b.ratePer1k);
  setText('#m-count', `${ui.orders.length} active listing(s)`);
  const best = others.filter(o => !o.mine)[0];
  setText('#m-best', best ? `${fmtNum(best.ratePer1k, 6)} SOL / 1k` : 'no listings');

  $('#m-mine-body').replaceChildren(...(mine.length ? mine.map(o => h('tr', {},
    h('td', { class: 'num' }, fmtInt(o.creditsAmount)),
    h('td', { class: 'num' }, fmtSol(o.priceSol)),
    h('td', { class: 'num' }, fmtNum(o.ratePer1k, 6)),
    h('td', { class: 'mono small' }, String(o.orderId).slice(0, 14)),
    h('td', { class: 'num' }, h('button', { class: 'btn btn-danger btn-xs', onclick: () => cancelOrder(o) }, 'Cancel')),
  )) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'You have no open listings.'))]));

  $('#m-all-body').replaceChildren(...(others.length ? others.map(o => h('tr', {},
    h('td', { class: 'num' }, fmtInt(o.creditsAmount)),
    h('td', { class: 'num' }, fmtSol(o.priceSol)),
    h('td', { class: 'num' }, fmtNum(o.ratePer1k, 6)),
    h('td', { class: 'mono small' }, o.mine ? maskAddr(o.sellerWallet) : shortAddr(o.sellerWallet)),
    h('td', {}, o.mine ? h('span', { class: 'tag tag-mine' }, 'Yours') : ''),
  )) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No active listings right now.'))]));
}
$('#m-refresh').addEventListener('click', e => withBusy(e.currentTarget, loadOrders));

function updateRate() {
  const c = Number($('#m-credits').value); const p = Number($('#m-price').value);
  setText('#m-rate', c > 0 && p > 0 ? `${fmtNum((p / c) * 1000, 6)} SOL / 1k` : '– SOL / 1k');
}
$('#m-credits').addEventListener('input', updateRate);
$('#m-price').addEventListener('input', updateRate);
$('#m-max').addEventListener('click', () => {
  const avail = ui.state?.snapshot?.balance?.available;
  if (avail) { $('#m-credits').value = Math.floor(avail); updateRate(); }
});

$('#m-form').addEventListener('submit', async e => {
  e.preventDefault();
  setText('#m-error', '');
  const credits = Number($('#m-credits').value); const price = Number($('#m-price').value);
  const lim = ui.state.limits; const avail = ui.state.snapshot.balance?.available;
  if (!Number.isInteger(credits) || credits < lim.minListingCredits) return setText('#m-error', `Minimum listing is ${lim.minListingCredits} whole credits.`);
  if (!(price >= lim.minListingPriceSol)) return setText('#m-error', `Minimum price is ${lim.minListingPriceSol} SOL.`);
  if (avail !== undefined && credits > avail) return setText('#m-error', `You only have ${fmtInt(avail)} credits available.`);
  const ok = await confirmDialog({
    title: 'Create listing?',
    body: h('div', {}, 'These credits will be escrowed by jevbrain.world until the listing is bought or cancelled.',
      dl([['Credits', fmtInt(credits)], ['Price', fmtSol(price)], ['Rate', `${fmtNum((price / credits) * 1000, 6)} SOL / 1k`], ['Seller', maskAddr(ui.state.status.address)]])),
    okText: 'Create listing',
  });
  if (!ok) return;
  try {
    await api('POST', '/api/market/create', { creditsAmount: credits, priceSol: price, confirm: true });
    toast(`Listing created: ${fmtInt(credits)} credits for ${fmtSol(price)}.`, 'ok');
    $('#m-credits').value = ''; $('#m-price').value = ''; updateRate();
    loadOrders(); poll();
  } catch (err) { setText('#m-error', err.message); }
});

async function cancelOrder(o) {
  const ok = await confirmDialog({
    title: 'Cancel listing?',
    body: h('div', {}, 'The escrowed credits will be released back to your balance.',
      dl([['Order', String(o.orderId)], ['Credits', fmtInt(o.creditsAmount)], ['Price', fmtSol(o.priceSol)]])),
    okText: 'Cancel listing', danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/market/cancel', { orderId: o.orderId, confirm: true });
    toast('Listing cancelled.', 'ok');
    loadOrders(); poll();
  } catch (err) { toast(`Cancel failed: ${err.message}`, 'err'); }
}

// ------------------------------------------------------------------ settings

function fillSettings() {
  const s = ui.state?.settings; if (!s) return;
  $('#s-interval').value = s.intervalMin;
  $('#s-rpc').value = s.rpcUrl;
  $('#s-base').value = s.baseUrl;
  $('#s-autostart').checked = s.autoStartKeeper;
  $('#s-privacy').checked = s.privacyMode;
}

$('#s-form').addEventListener('submit', async e => {
  e.preventDefault();
  setText('#s-error', ''); setText('#s-saved', '');
  const next = {
    intervalMin: Number($('#s-interval').value),
    rpcUrl: $('#s-rpc').value.trim(),
    baseUrl: $('#s-base').value.trim(),
    autoStartKeeper: $('#s-autostart').checked,
    privacyMode: $('#s-privacy').checked,
  };
  const official = ui.state.officialBaseUrl;
  if (next.baseUrl.replace(/\/+$/, '') !== official && next.baseUrl.replace(/\/+$/, '') !== ui.state.settings.baseUrl) {
    const ok = await confirmDialog({
      title: 'Use a non-official server?',
      body: `You are pointing the app at ${next.baseUrl}. That server will receive your login signature and could use it to act on your jevbrain.world account (e.g. move credits). Only do this if you fully trust it.`,
      okText: 'I understand, use it', danger: true, typeToConfirm: 'TRUST',
    });
    if (ok !== 'TRUST') return;
  }
  try {
    await api('POST', '/api/settings', next);
    setText('#s-saved', 'Saved ✓');
    $('#f-interval').value = next.intervalMin;
    poll();
  } catch (err) { setText('#s-error', err.message); }
});

boot().catch(err => {
  document.body.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h2', {}, 'Cannot reach the local server'), h('p', { class: 'muted' }, err.message))));
});
