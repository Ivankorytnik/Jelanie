(() => {
  'use strict';

  const load = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${src}?v=20260901-3`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${src} failed to load`));
    document.body.appendChild(script);
  });

  load('firebase-config.js')
    .then(() => load('app-core.js'))
    .then(() => Promise.all([
      load('email.js'),
      load('team-sync.js'),
    ]))
    .catch((error) => console.error('CRM module failed to load', error));
})();
