(() => {
  'use strict';
  const core = document.createElement('script');
  core.src = 'app-core.js';
  core.onload = () => {
    const email = document.createElement('script');
    email.src = 'email.js';
    document.body.appendChild(email);
  };
  core.onerror = () => console.error('CRM core failed to load');
  document.body.appendChild(core);
})();
