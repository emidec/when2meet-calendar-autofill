// Runs in the when2meet page's own JavaScript world so it can read the page's globals
// (TimeOfSlot, AvailableAtSlot, UserID) and save availability the same way the grid does.
// The isolated content script talks to it with CustomEvents carrying JSON strings.

(() => {
  if (window.__w2mAutofillBridge) return;
  window.__w2mAutofillBridge = true;

  const REQUEST = 'w2m-autofill:request';
  const RESPONSE = 'w2m-autofill:response';

  function eventInfo() {
    const m = /^\?(\d+)-([A-Za-z0-9]+)/.exec(location.search);
    return m ? { id: m[1], code: m[2] } : null;
  }

  function userId() {
    return Number(window.UserID) || 0;
  }

  function slots() {
    return Array.isArray(window.TimeOfSlot) ? window.TimeOfSlot.map(Number) : [];
  }

  function isMine(i, uid) {
    const list = window.AvailableAtSlot && window.AvailableAtSlot[i];
    return Boolean(uid) && Array.isArray(list) && list.includes(uid);
  }

  function repaint() {
    try {
      window.ReColorIndividual();
    } catch {}
    try {
      window.ReColorGroup();
    } catch {}
  }

  // Re-downloads the event page and checks the server has the availability we sent.
  async function verify(uid, times, finalState) {
    try {
      const res = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' });
      const html = await res.text();
      const timeAt = new Map();
      for (const m of html.matchAll(/TimeOfSlot\[(\d+)\]\s*=\s*(\d+)\s*;/g)) timeAt.set(m[1], Number(m[2]));
      if (!timeAt.size) return null;
      const saved = new Set();
      for (const m of html.matchAll(new RegExp(`AvailableAtSlot\\[(\\d+)\\]\\.push\\(${uid}\\)`, 'g'))) {
        saved.add(timeAt.get(m[1]));
      }
      const mismatches = times.filter((t, i) => saved.has(t) !== finalState[i]).length;
      return { ok: mismatches === 0, mismatches };
    } catch {
      return null;
    }
  }

  const commands = {
    state() {
      const uid = userId();
      const times = slots();
      return {
        event: eventInfo(),
        userId: uid,
        signedIn: uid > 0,
        slots: times,
        mine: times.map((_, i) => isMine(i, uid)),
      };
    },

    // Sets the signed-in user's availability to `desired` (one boolean per slot), using the same
    // SaveTimes.php request the grid sends after a drag.
    async apply({ desired }) {
      const uid = userId();
      if (!uid) throw new Error('Sign in to this when2meet event first.');
      const event = eventInfo();
      if (!event) throw new Error("This doesn't look like a when2meet event page.");
      const times = slots();
      if (!Array.isArray(desired) || desired.length !== times.length) {
        throw new Error('The event changed since it was read. Reload the page and try again.');
      }

      const add = [];
      const remove = [];
      const finalState = [];
      let bits = '';
      times.forEach((t, i) => {
        const hasCell = Boolean(document.getElementById(`YouTime${t}`));
        const current = isMine(i, uid);
        const want = hasCell ? Boolean(desired[i]) : current;
        if (want && !current) add.push(t);
        if (!want && current) remove.push(t);
        finalState.push(want);
        if (hasCell) bits += want ? '1' : '0';
      });

      const password = document.getElementById('password')?.value ?? '';
      const save = async (slotTimes, changeToAvailable) => {
        const body = new URLSearchParams();
        body.append('person', uid);
        body.append('event', event.id);
        body.append('slots', slotTimes.join(','));
        body.append('availability', bits);
        body.append('password', password);
        body.append('ChangeToAvailable', changeToAvailable);
        const res = await fetch('SaveTimes.php', { method: 'POST', body });
        if (!res.ok) throw new Error(`when2meet couldn't save (HTTP ${res.status}).`);
        return (await res.text()).trim();
      };
      // Sequential on purpose: every request carries the full availability string.
      if (add.length) await save(add, true);
      if (remove.length) await save(remove, false);

      times.forEach((t, i) => {
        const list = window.AvailableAtSlot[i];
        const idx = list.indexOf(uid);
        if (finalState[i] && idx === -1) list.push(uid);
        if (!finalState[i] && idx !== -1) list.splice(idx, 1);
      });
      repaint();

      const verified = add.length || remove.length ? await verify(uid, times, finalState) : { ok: true, mismatches: 0 };
      return {
        added: add.length,
        removed: remove.length,
        available: finalState.filter(Boolean).length,
        total: times.length,
        verified,
      };
    },
  };

  document.addEventListener(REQUEST, async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== 'string' || !Object.hasOwn(commands, msg.cmd)) return;
    let reply;
    try {
      reply = { id: msg.id, ok: true, result: await commands[msg.cmd](msg.args || {}) };
    } catch (err) {
      reply = { id: msg.id, ok: false, error: String(err?.message || err) };
    }
    document.dispatchEvent(new CustomEvent(RESPONSE, { detail: JSON.stringify(reply) }));
  });
})();
