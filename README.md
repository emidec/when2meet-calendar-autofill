# Calendar Autofill for When2meet

A Chrome extension that fills in your [when2meet](https://www.when2meet.com) availability from your calendar.
Open an event link, sign in with your name as usual, and every slot where your calendar is free is marked
available. Busy slots stay unavailable.

- **Calendars:** Google Calendar (several accounts and calendars at once) and any iCal (`.ics`) link: Google's
  secret iCal address, Outlook/Office 365 published calendars, iCloud public calendars, and so on.
- **Autofill on sign-in:** fills automatically the first time you sign in to an event. If you already have
  availability on that event, it's left alone and the panel gives you a **Fill from my calendar** button.
- **Undo:** puts back exactly what you had before the fill.
- **Preferences:** a buffer around meetings, ignoring short free gaps, only marking hours between X and Y,
  blocking whole weekdays, ignoring all-day events, and pre-typing your name in the sign-in box.
- **Checked saves:** after saving, the extension reloads the event and confirms when2meet stored what it sent.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the [`extension`](extension) folder.
3. The settings page opens. Connect a calendar using one of the two options below.

The manifest pins the extension ID to `dghijeiihogpggohcckfaofkmifnbkgi`, so the Google redirect URI below
stays valid if you move the folder or reload the extension.

## Connect a calendar

### Option A: iCal link (about 1 minute, no setup)

In Google Calendar go to **Settings → (your calendar) → Integrate calendar → Secret address in iCal format**,
copy the link, and paste it into **iCal links** on the extension's settings page. Chrome asks to let the
extension read that one host. Outlook and iCloud publish links (including `webcal://`) work the same way.
Add one link per calendar you want counted.

Some providers serve a cached copy of the feed, and the extension also caches each feed for 5 minutes, so an
event you added moments ago may not count yet. Option B always reads live data.

### Option B: Google Calendar sign-in (one-time setup, about 5 minutes)

Google requires every app that reads calendars to have its own OAuth client, so you create one in your own
Google Cloud project:

1. In the [Google Cloud console](https://console.cloud.google.com/projectcreate), create a project.
2. Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), set up the consent screen with
   audience **External**, and add your Google address(es) under **Test users**. Leave the app in **Testing**.
4. Under [Clients](https://console.cloud.google.com/auth/clients), click **Create client** and pick the type
   **Web application**. Add this **Authorized redirect URI**:
   `https://dghijeiihogpggohcckfaofkmifnbkgi.chromiumapp.org/`
5. Copy the client ID, paste it into the settings page, click **Save**, then **Connect a Google account**.

The extension asks for only two read-only permissions: your list of calendars and their free/busy times. It
never sees event titles or details. You choose which calendars count as busy; by default that's your primary
calendar and other calendars you own, but not holidays, birthdays, or other people's calendars. You can connect
several Google accounts, for example personal and school.

Sign-ins renew in the background. If Google wants you to sign in again (apps in Testing mode need this about
once a week), the panel shows a **Reconnect Google** button.

## Using it

1. Open a when2meet event. A small **Calendar Autofill** panel appears in the bottom-right corner.
2. Sign in to the event with your name, as usual.
3. Your availability fills in and saves. The panel shows how many slots were marked available. You can click
   **Undo**, or adjust any slot by hand on the grid.

**Days-of-the-week events** (generic weekly polls with no dates) are filled from your calendar for the coming
week, starting tomorrow. "Monday 9:00 AM" means 9:00 AM in your own time zone, which matches how when2meet
treats these events. The panel shows which dates were used.

The extension saves through the same `SaveTimes.php` request when2meet's own grid sends when you drag. It
never changes anything until you're signed in to the event.

## How it works

| File | Role |
| --- | --- |
| [`extension/content/content.js`](extension/content/content.js) | The panel on when2meet pages: notices sign-in, runs the fill, undo |
| [`extension/content/bridge.js`](extension/content/bridge.js) | Runs in the page's own JavaScript context to read `TimeOfSlot`, `AvailableAtSlot`, `UserID` and save |
| [`extension/background.js`](extension/background.js) | Service worker that answers the panel's requests |
| [`extension/lib/fill.js`](extension/lib/fill.js), [`availability.js`](extension/lib/availability.js) | Maps slots to real times and decides each one (buffer, hours, gaps) |
| [`extension/lib/google.js`](extension/lib/google.js) | Google OAuth (`chrome.identity.launchWebAuthFlow`) and the FreeBusy API |
| [`extension/lib/ical.js`](extension/lib/ical.js), [`time.js`](extension/lib/time.js) | iCal parser: recurring events, exceptions, time zones (IANA, Windows, embedded `VTIMEZONE`) |
| [`extension/options/`](extension/options) | Settings page |

Access tokens are kept in `chrome.storage.session`, which is memory-only and cleared when Chrome closes.
Everything else stays in `chrome.storage.local` on your machine. The extension only talks to Google (the
Calendar API), your iCal hosts, and when2meet.

## Development

There's no build step. Edit the files, then click the reload icon on `chrome://extensions`.

Tests run in the browser (no Node needed):

```bash
python3 tests/server.py
```

- <http://localhost:8765/tests/unit.html>: unit tests for time zones, recurrence rules, iCal parsing and
  availability rules.
- <http://localhost:8765/w2m/?1234567-AbCdE>: a mock when2meet event with the same page structure, globals and
  save endpoint as the real site. The extension's content scripts are loaded with a `chrome.*` stand-in that
  uses [`tests/fixtures/sample.ics`](tests/fixtures/sample.ics) as the calendar. Sign in to watch it autofill.
  `GET /w2m/state` shows what the mock server saved, and `POST /w2m/reset` clears it.
- <http://localhost:8765/tests/options-preview>: the settings page with sample data.

To regenerate the icons, run `python3 tools/make_icons.py`.

If you publish to the Chrome Web Store, remove the `"key"` field from `manifest.json`. The store assigns its own
ID, so you'll also need to add that ID's `https://<id>.chromiumapp.org/` redirect URI to your OAuth client.
