import { planFill } from './lib/fill.js';
import { getToken } from './lib/google.js';
import { getSettings } from './lib/settings.js';
import { collectBusy, listSources } from './lib/sources.js';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const handlers = {
  async status() {
    const [settings, sources] = await Promise.all([getSettings(), listSources()]);
    return { sources, autoFillOnSignIn: settings.autoFillOnSignIn, prefillName: settings.prefillName };
  },

  async fill({ slots }) {
    if (!(await listSources()).length) return { needsSetup: true };
    return planFill({ slots, settings: await getSettings(), getBusy: collectBusy });
  },

  async reconnectGoogle({ email }) {
    await getToken(email, { interactive: true });
    return { ok: true };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(sendResponse, (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
