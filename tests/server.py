"""Local test server.

Serves the repository (unit tests at /tests/unit.html) and a mock when2meet event at
/w2m/?1234567-AbCdE that mirrors the real page's structure: the TimeOfSlot / AvailableAtSlot globals,
YouTime<timestamp> grid cells, ProcessLogin.php and SaveTimes.php. The extension's content scripts are
loaded into the mock page with a small chrome.* shim (tests/chrome-shim.js).

Usage: python3 tests/server.py [port]     (default port 8765)
Extra endpoints: GET /w2m/state (JSON), POST /w2m/reset
"""
import html
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EVENT_ID = '1234567'
EVENT_CODE = 'AbCdE'

# Mon-Wed Nov 16-18 2026, 9:00-17:00 America/Los_Angeles (UTC-8), 15-minute slots.
FIRST_DAY_9AM = 1794848400
SLOTS = [FIRST_DAY_9AM + day * 86400 + i * 900 for day in range(3) for i in range(32)]
DAY_LABELS = [('Nov 16', 'Mon'), ('Nov 17', 'Tue'), ('Nov 18', 'Wed')]


def fresh_state():
    return {'people': {}, 'availability': {}, 'next_id': 900001, 'log': []}


STATE = fresh_state()


def render_event_page():
    lines = []
    for i, t in enumerate(SLOTS):
        lines.append(f'TimeOfSlot[{i}]={t};')
        lines.append(f'AvailableAtSlot[{i}]=new Array();')
    people = []
    for n, (pid, person) in enumerate(STATE['people'].items()):
        people.append(f"PeopleNames[{n}] = '{html.escape(person['name'], quote=True)}';PeopleIDs[{n}] = {pid};")
    pushes = []
    for pid, times in STATE['availability'].items():
        for i, t in enumerate(SLOTS):
            if t in times:
                pushes.append(f'AvailableAtSlot[{i}].push({pid});')

    def cells(prefix, extra):
        out = []
        for row in range(32):
            for col in range(3):
                t = SLOTS[col * 32 + row]
                out.append(
                    f"<div id='{prefix}{t}' data-col=\"{col}\" data-row=\"{row}\" data-time=\"{t}\" {extra} "
                    f"class='cell'></div>"
                )
            out.append('<br>')
        return '\n'.join(out)

    headers = ''.join(f'<div class="head">{d}<br><b>{w}</b></div>' for d, w in DAY_LABELS)
    template = open(os.path.join(ROOT, 'tests', 'fixtures', 'event-template.html'), encoding='utf-8').read()
    return (
        template.replace('{{SLOT_SCRIPT}}', '\n'.join(lines))
        .replace('{{PEOPLE_SCRIPT}}', '\n'.join(people + pushes))
        .replace('{{EVENT_ID}}', EVENT_ID)
        .replace('{{HEADERS}}', headers)
        .replace('{{YOU_CELLS}}', cells('YouTime', ''))
        .replace('{{GROUP_CELLS}}', cells('GroupTime', ''))
    )


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_text(self, body, ctype='text/html; charset=utf-8', status=200):
        data = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/w2m/':
            return self.send_text(render_event_page())
        if path == '/tests/options-preview':
            # The real settings page with a fake chrome.* API (tests/options-shim.js) for visual checks.
            page = open(os.path.join(ROOT, 'extension', 'options', 'options.html'), encoding='utf-8').read()
            page = page.replace(
                '<head>',
                '<head>\n  <base href="/extension/options/">\n  <script src="/tests/options-shim.js"></script>',
                1,
            )
            return self.send_text(page)
        if path == '/w2m/state':
            body = {
                'people': STATE['people'],
                'availability': {pid: sorted(times) for pid, times in STATE['availability'].items()},
                'log': STATE['log'],
                'slots': SLOTS,
            }
            return self.send_text(json.dumps(body), 'application/json')
        return super().do_GET()

    def do_POST(self):
        global STATE
        path = urlparse(self.path).path
        length = int(self.headers.get('Content-Length') or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode('utf-8'), keep_blank_values=True).items()}

        if path == '/w2m/reset':
            STATE = fresh_state()
            return self.send_text('OK', 'text/plain')

        if path == '/w2m/ProcessLogin.php':
            name = form.get('name', '').strip()
            if not name:
                return self.send_text('Please enter a name.', 'text/plain')
            for pid, person in STATE['people'].items():
                if person['name'] == name:
                    if person['password'] != form.get('password', ''):
                        return self.send_text('Wrong password.', 'text/plain')
                    return self.send_text(str(pid), 'text/plain')
            pid = str(STATE['next_id'])
            STATE['next_id'] += 1
            STATE['people'][pid] = {'name': name, 'password': form.get('password', '')}
            STATE['availability'][pid] = set()
            return self.send_text(pid, 'text/plain')

        if path == '/w2m/SaveTimes.php':
            pid = form.get('person', '')
            entry = {k: form.get(k) for k in ('person', 'event', 'ChangeToAvailable')}
            entry['slotCount'] = len([s for s in form.get('slots', '').split(',') if s])
            person = STATE['people'].get(pid)
            if form.get('event') != EVENT_ID or not person or person['password'] != form.get('password', ''):
                entry['result'] = 'rejected'
                STATE['log'].append(entry)
                return self.send_text('Error', 'text/plain')
            times = STATE['availability'].setdefault(pid, set())
            add = form.get('ChangeToAvailable') == 'true'
            for s in form.get('slots', '').split(','):
                if s:
                    (times.add if add else times.discard)(int(s))
            # Cross-check the full availability string the page sends with every save.
            expected_bits = ''.join('1' if t in times else '0' for t in SLOTS)
            entry['bitsMatchAfterSave'] = form.get('availability') == expected_bits
            entry['result'] = 'ok'
            STATE['log'].append(entry)
            return self.send_text('', 'text/plain')

        self.send_error(404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Serving on http://localhost:{port}/  (mock event: http://localhost:{port}/w2m/?{EVENT_ID}-{EVENT_CODE})')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
