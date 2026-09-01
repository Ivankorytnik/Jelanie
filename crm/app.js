(() => {
  'use strict';

  const load = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${src}?v=20260901-1`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${src} failed to load`));
    document.body.appendChild(script);
  });

  load('app-core.js')
    .then(() => Promise.all([
      load('email.js'),
      load('sync.js'),
    ]))
    .catch((error) => console.error('CRM module failed to load', error));
})();
