// Adds the "Calendar Autofill" panel to when2meet event pages and drives the fill.
// Page data and saving go through bridge.js (page world); calendar work happens in the background worker.

(() => {
  if (window.__w2mAutofillContent) return;
  window.__w2mAutofillContent = true;
  if (!/^\?\d+-[A-Za-z0-9]+/.test(location.search)) return;
  if (!document.getElementById('YouGrid') && !document.getElementById('SignIn')) return;

  // ---- Messaging -----------------------------------------------------------------------------

  const pending = new Map();
  document.addEventListener('w2m-autofill:response', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    const waiter = pending.get(msg?.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error));
  });

  function callPage(cmd, args = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The when2meet page didn't respond. Reload it and try again."));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      document.dispatchEvent(new CustomEvent('w2m-autofill:request', { detail: JSON.stringify({ id, cmd, args }) }));
    });
  }

  async function pageState() {
    // The page-world bridge can load a moment after this script.
    for (let attempt = 0; ; attempt++) {
      try {
        return await callPage('state', {}, 1000);
      } catch (err) {
        if (attempt >= 5) throw err;
      }
    }
  }

  async function background(message) {
    let res;
    try {
      res = await chrome.runtime.sendMessage(message);
    } catch {
      throw new Error('The extension was updated. Reload this page to keep using it.');
    }
    if (res?.error) throw new Error(res.error);
    return res;
  }

  // ---- Panel -----------------------------------------------------------------------------------

  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3" fill="#2e7d32"/><rect x="3" y="4.5" width="18" height="5" rx="2" fill="#1b5e20"/><rect x="7" y="2.5" width="2" height="4" rx="1" fill="#1b5e20"/><rect x="15" y="2.5" width="2" height="4" rx="1" fill="#1b5e20"/><path d="M8 15l2.6 2.6L16.5 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card {
      width: 290px; background: #fff; color: #1f2328; border: 1px solid #d8dde3; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(16, 24, 40, .18); padding: 12px 14px 10px; font-size: 13px; line-height: 1.4;
    }
    header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    header svg { width: 20px; height: 20px; flex: none; }
    .title { font-weight: 650; font-size: 13px; flex: 1; }
    .status { margin: 0 0 4px; font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: flex-start; }
    .status.warn { color: #9a4f00; }
    .status.error { color: #b42318; }
    .status.ok { color: #1b5e20; }
    .detail { margin: 0 0 10px; color: #57606a; font-size: 12px; }
    .detail:empty { display: none; }
    .actions { display: flex; gap: 8px; }
    button { font: inherit; cursor: pointer; border-radius: 8px; }
    button:disabled { cursor: default; opacity: .55; }
    button:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
    .primary { flex: 1; background: #2e7d32; color: #fff; border: 1px solid #2e7d32; padding: 7px 10px; font-weight: 600; }
    .primary:hover:not(:disabled) { background: #256b29; }
    .secondary { background: #fff; color: #1f2328; border: 1px solid #c9d1d9; padding: 7px 10px; }
    .secondary:hover:not(:disabled) { background: #f3f5f7; }
    .icon { background: none; border: none; color: #57606a; width: 24px; height: 24px; padding: 0; font-size: 18px; line-height: 1; }
    .icon:hover { background: #f0f2f4; }
    footer { margin-top: 8px; display: flex; justify-content: flex-end; }
    .link { background: none; border: none; color: #57606a; padding: 2px 0; font-size: 12px; text-decoration: underline; }
    .link:hover { color: #1f2328; }
    .spinner {
      width: 14px; height: 14px; margin-top: 3px; flex: none; border-radius: 50%;
      border: 2px solid #c8e6c9; border-top-color: #2e7d32; animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pill {
      display: flex; align-items: center; gap: 6px; background: #fff; color: #1f2328; border: 1px solid #d8dde3;
      border-radius: 999px; padding: 6px 12px 6px 8px; box-shadow: 0 4px 14px rgba(16, 24, 40, .16);
      font-size: 13px; font-weight: 600;
    }
    .pill svg { width: 18px; height: 18px; }
    [hidden] { display: none !important; }
  `;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS}</style>
    <section class="card" aria-label="Calendar Autofill">
      <header>${ICON}<span class="title">Calendar Autofill</span>
        <button class="icon" data-action="collapse" title="Minimize" aria-label="Minimize">&minus;</button>
      </header>
      <p class="status" role="status"><span class="spinner" hidden></span><span class="message"></span></p>
      <p class="detail"></p>
      <div class="actions">
        <button class="primary" data-action="primary"></button>
        <button class="secondary" data-action="undo" hidden>Undo</button>
      </div>
      <footer><button class="link" data-action="settings">Settings</button></footer>
    </section>
    <button class="pill" data-action="expand" hidden title="Calendar Autofill">${ICON}Autofill</button>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const card = $('.card');
  const pill = $('.pill');
  const statusEl = $('.status');
  const primaryBtn = $('[data-action="primary"]');
  const undoBtn = $('[data-action="undo"]');

  let status = { sources: [], autoFillOnSignIn: false, prefillName: '' };
  let signedIn = false;
  let working = false;
  let autoFillDone = false;
  let undoState = null;
  let primaryAction = null;

  function view({ message, detail = '', tone = '', spinner = false, primary = null, undo = false }) {
    statusEl.className = `status ${tone}`;
    $('.message').textContent = message;
    $('.spinner').hidden = !spinner;
    $('.detail').textContent = detail;
    primaryAction = primary?.action || null;
    primaryBtn.hidden = !primary;
    primaryBtn.textContent = primary?.label || '';
    primaryBtn.disabled = Boolean(primary?.disabled) || working;
    undoBtn.hidden = !undo;
    undoBtn.disabled = working;
  }

  function sourceSummary() {
    const n = status.sources.length;
    if (!n) return '';
    const names = status.sources.map((s) => (s.kind === 'google' ? `Google (${s.name})` : s.name));
    return `Using ${n === 1 ? names[0] : `${n} calendars: ${names.join(', ')}`}.`;
  }

  function showIdle() {
    if (!status.sources.length) {
      view({
        message: 'Connect a calendar to autofill this event.',
        detail: 'Google Calendar or any iCal (.ics) link works.',
        primary: { label: 'Connect a calendar', action: 'settings' },
      });
    } else if (!signedIn) {
      view({
        message: 'Sign in to this event, then fill your availability from your calendar.',
        detail: sourceSummary(),
        primary: { label: 'Fill from my calendar', action: 'fill', disabled: true },
      });
    } else {
      view({
        message: 'Ready to fill your availability.',
        detail: `${sourceSummary()} This replaces what's currently selected in your grid.`,
        primary: { label: 'Fill from my calendar', action: 'fill' },
        undo: Boolean(undoState),
      });
    }
  }

  const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  function showDone(result, plan, auto) {
    const verified = result.verified;
    const parts = [`${plan.busyCount} busy ${plan.busyCount === 1 ? 'block' : 'blocks'} on your calendar in this range.`];
    if (plan.daysOfWeek) {
      parts.push(`Weekly event: used your calendar for ${shortDate(plan.range.start)} – ${shortDate(plan.range.end - 1)}.`);
    }
    if (verified && !verified.ok) {
      view({
        message: "when2meet didn't keep all of the changes.",
        detail: `${verified.mismatches} slots differ from what was sent. Reload the page and check your grid, or try again.`,
        tone: 'warn',
        primary: { label: 'Try again', action: 'fill' },
        undo: true,
      });
      return;
    }
    parts.push(verified ? 'Saved to when2meet.' : 'Sent to when2meet.');
    view({
      message: `${auto ? 'Autofilled' : 'Filled'}: available for ${result.available} of ${result.total} slots.`,
      detail: parts.join(' '),
      tone: 'ok',
      primary: { label: 'Fill again', action: 'fill' },
      undo: true,
    });
  }

  function showFailed(failed) {
    const reauth = failed.find((f) => f.needsReauth);
    view({
      message: `Couldn't read ${failed.length === 1 ? failed[0].name : `${failed.length} calendars`}.`,
      detail: `${failed.map((f) => `${f.name}: ${f.error}`).join(' • ')} Nothing was changed on when2meet.`,
      tone: 'error',
      primary: reauth
        ? { label: 'Reconnect Google', action: `reconnect:${reauth.id}` }
        : { label: 'Try again', action: 'fill' },
    });
  }

  function showError(message) {
    view({ message, tone: 'error', primary: { label: 'Try again', action: 'fill', disabled: !signedIn } });
  }

  // ---- Actions -------------------------------------------------------------------------------

  function eventIsPast(state) {
    const last = Math.max(...state.slots);
    return last >= Date.UTC(1980, 0, 1) / 1000 && last * 1000 < Date.now();
  }

  async function fill({ auto = false } = {}) {
    if (working) return;
    working = true;
    try {
      view({ message: 'Checking your calendar…', spinner: true });
      const state = await pageState();
      if (!state.signedIn) {
        signedIn = false;
        working = false;
        showIdle();
        return;
      }
      const plan = await background({ type: 'fill', slots: state.slots });
      if (plan.needsSetup) {
        working = false;
        showIdle();
        return;
      }
      if (plan.failed) {
        working = false;
        showFailed(plan.failed);
        return;
      }
      view({ message: 'Saving to when2meet…', spinner: true });
      const result = await callPage('apply', { desired: plan.desired });
      undoState = state.mine;
      working = false;
      showDone(result, plan, auto);
    } catch (err) {
      working = false;
      showError(err.message);
    }
  }

  async function undo() {
    if (working || !undoState) return;
    working = true;
    try {
      view({ message: 'Restoring your previous availability…', spinner: true });
      await callPage('apply', { desired: undoState });
      undoState = null;
      working = false;
      view({
        message: 'Restored your previous availability.',
        tone: 'ok',
        primary: { label: 'Fill from my calendar', action: 'fill' },
      });
    } catch (err) {
      working = false;
      showError(err.message);
    }
  }

  async function reconnect(email) {
    try {
      view({ message: `Reconnecting ${email}…`, spinner: true });
      await background({ type: 'reconnectGoogle', email });
      await fill();
    } catch (err) {
      showError(err.message);
    }
  }

  root.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'primary') {
      if (primaryAction === 'fill') fill();
      else if (primaryAction === 'settings') background({ type: 'openOptions' }).catch(() => {});
      else if (primaryAction?.startsWith('reconnect:')) reconnect(primaryAction.slice('reconnect:'.length));
    } else if (action === 'undo') undo();
    else if (action === 'settings') background({ type: 'openOptions' }).catch(() => {});
    else if (action === 'collapse' || action === 'expand') setCollapsed(action === 'collapse');
  });

  function setCollapsed(collapsed, persist = true) {
    card.hidden = collapsed;
    pill.hidden = !collapsed;
    if (persist) chrome.storage.local.set({ panelCollapsed: collapsed }).catch(() => {});
  }

  // ---- Page watching -------------------------------------------------------------------------

  const prefilled = new WeakSet();
  function prefillName() {
    const name = (status.prefillName || '').trim();
    const input = document.getElementById('name');
    if (!name || !input || prefilled.has(input) || input.value) return;
    prefilled.add(input);
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function yourGridVisible() {
    const grid = document.getElementById('YouGrid');
    return Boolean(grid) && grid.style.display !== 'none';
  }

  async function onSignedIn() {
    let state;
    try {
      state = await pageState();
    } catch (err) {
      showError(err.message);
      return;
    }
    if (!state.signedIn) return;
    signedIn = true;
    if (working) return;
    const empty = !state.mine.some(Boolean);
    if (status.autoFillOnSignIn && status.sources.length && empty && !autoFillDone && !eventIsPast(state)) {
      autoFillDone = true;
      await fill({ auto: true });
    } else {
      showIdle();
      if (eventIsPast(state)) $('.detail').textContent = 'Heads up: the dates in this event have already passed.';
    }
  }

  let checkTimer = null;
  let checkingSignIn = false;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      prefillName();
      const visible = yourGridVisible();
      if (visible && !signedIn && !checkingSignIn) {
        checkingSignIn = true;
        onSignedIn().finally(() => (checkingSignIn = false));
      } else if (!visible && signedIn) {
        signedIn = false;
        if (!working) showIdle();
      }
    }, 120);
  }

  async function refreshStatus() {
    try {
      status = await background({ type: 'status' });
    } catch (err) {
      showError(err.message);
      return false;
    }
    return true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.settings || changes.googleAccounts)) return;
    refreshStatus().then((ok) => {
      if (!ok) return;
      prefillName();
      if (!working) showIdle();
    });
  });

  (async () => {
    view({ message: 'Loading…', spinner: true });
    const { panelCollapsed } = await chrome.storage.local.get('panelCollapsed').catch(() => ({}));
    setCollapsed(Boolean(panelCollapsed), false);
    if (!(await refreshStatus())) return;
    showIdle();
    new MutationObserver(scheduleCheck).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    scheduleCheck();
  })();
})();
