// Stand-in for the chrome.* APIs used by content.js on the mock when2meet page. Messages are answered
// with the extension's real planning code, using tests/fixtures/sample.ics as the only calendar.
(() => {
  const TZ = 'America/Los_Angeles';
  const store = {
    settings: {
      autoFillOnSignIn: true,
      prefillName: 'Test User',
      icsFeeds: [{ id: 'fixture', name: 'Fixture calendar', url: '/tests/fixtures/sample.ics', enabled: true }],
    },
  };
  const changeListeners = [];
  window.__shim = { store, openedOptions: 0, messages: [] };

  async function answer(msg) {
    const [{ planFill }, { busyFromIcs }, { DEFAULT_SETTINGS }] = await Promise.all([
      import('/extension/lib/fill.js'),
      import('/extension/lib/ical.js'),
      import('/extension/lib/settings.js'),
    ]);
    const settings = { ...DEFAULT_SETTINGS, ...store.settings };
    const sources = settings.icsFeeds.filter((f) => f.enabled).map((f) => ({ kind: 'ics', id: f.id, name: f.name }));
    switch (msg.type) {
      case 'status':
        return { sources, autoFillOnSignIn: settings.autoFillOnSignIn, prefillName: settings.prefillName };
      case 'fill': {
        if (!sources.length) return { needsSetup: true };
        const text = await (await fetch('/tests/fixtures/sample.ics')).text();
        return planFill({
          slots: msg.slots,
          settings,
          timeZone: TZ,
          getBusy: async (timeMin, timeMax) => {
            const { busy } = busyFromIcs(text, { rangeStart: timeMin, rangeEnd: timeMax, localTz: TZ });
            return { busy, sources: [{ kind: 'ics', id: 'fixture', name: 'Fixture calendar', ok: true, count: busy.length }] };
          },
        });
      }
      case 'openOptions':
        window.__shim.openedOptions += 1;
        return { ok: true };
      default:
        return { error: `Unknown message ${msg.type}` };
    }
  }

  window.chrome = {
    runtime: {
      async sendMessage(msg) {
        window.__shim.messages.push(msg.type);
        try {
          return await answer(msg);
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: store[key] } : {};
        },
        async set(obj) {
          Object.assign(store, obj);
          const changes = Object.fromEntries(Object.keys(obj).map((k) => [k, { newValue: obj[k] }]));
          changeListeners.forEach((fn) => fn(changes, 'local'));
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
  };
})();
