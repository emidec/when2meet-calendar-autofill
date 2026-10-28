// Fake chrome.* APIs with sample data so the settings page can be previewed in a normal tab
// (served at /tests/options-preview by tests/server.py).
(() => {
  const local = {
    settings: {
      googleClientId: '1234567890-example.apps.googleusercontent.com',
      prefillName: 'Alex',
      bufferMinutes: 10,
      icsFeeds: [
        { id: 'a', name: 'Fixture calendar', url: 'http://localhost:8765/tests/fixtures/sample.ics', enabled: true },
      ],
    },
    googleAccounts: [
      {
        email: 'alex@example.com',
        calendars: [
          { id: 'alex@example.com', summary: 'alex@example.com', color: '#039be5', primary: true, selected: true },
          { id: 'classes@group.calendar.google.com', summary: 'Classes', color: '#33b679', selected: true },
          { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', color: '#0b8043', selected: false },
          { id: 'roommate@example.com', summary: 'Roommate', color: '#f4511e', selected: false },
        ],
      },
    ],
  };
  const session = {};
  const area = (data) => ({
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  });
  window.chrome = {
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
    identity: {
      getRedirectURL: () => 'https://dghijeiihogpggohcckfaofkmifnbkgi.chromiumapp.org/',
      launchWebAuthFlow: async () => {
        throw new Error('Google sign-in is not available in the preview.');
      },
    },
    permissions: { contains: async () => true, request: async () => true, remove: async () => true },
  };
})();
