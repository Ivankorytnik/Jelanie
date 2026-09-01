(() => {
  'use strict';

  const CLIENT_ID_KEY = 'intentraSpace.gmail.clientId';
  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
  const SIGNATURE = 'С уважением,\nРуководитель проекта - Корытник Иван Анатольевич\nINTENTRA SPACE';
  let tokenClient = null;
  let accessToken = '';
  let gisPromise = null;

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  function toast(text) {
    const existing = $('#gmail-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'gmail-toast';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: 9999,
      background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: '10px',
      font: '12px Arial, sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.22)'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function normalizeSignature(body) {
    const clean = String(body || '').trim();
    const marker = clean.lastIndexOf('С уважением,');
    const withoutOldSignature = marker >= 0 ? clean.slice(0, marker).trimEnd() : clean;
    return `${withoutOldSignature}\n\n${SIGNATURE}`;
  }

  function extractEmail(text) {
    const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : '';
  }

  function utf8ToBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildRawMessage(to, subject, body) {
    const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
    const message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');
    return utf8ToBase64Url(message);
  }

  function getClientId() {
    return localStorage.getItem(CLIENT_ID_KEY) || '';
  }

  function setClientId(value) {
    const clean = String(value || '').trim();
    if (clean) localStorage.setItem(CLIENT_ID_KEY, clean);
    else localStorage.removeItem(CLIENT_ID_KEY);
    accessToken = '';
    tokenClient = null;
    refreshGmailStatus();
  }

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Google Identity Services failed to load'));
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  async function ensureToken() {
    const clientId = getClientId();
    if (!clientId) throw new Error('GMAIL_NOT_CONFIGURED');
    await loadGis();
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        callback: () => {},
      });
    }
    return new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        if (response?.error) return reject(new Error(response.error));
        accessToken = response.access_token || '';
        refreshGmailStatus();
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
    });
  }

  async function sendViaGmail(letterId) {
    const seed = window.INTENTRA_CRM_SEED;
    const letter = seed?.letters?.find((item) => item.id === letterId);
    if (!letter) return toast('Письмо не найдено');

    const to = extractEmail(letter.contact);
    if (!to) return toast('У этого письма нет e-mail получателя');
    const subject = letter.subject || '';
    const body = normalizeSignature(letter.body);

    const ok = window.confirm(
      `Отправить письмо из Gmail?\n\nКому: ${to}\nТема: ${subject}\n\nПисьмо будет отправлено только после нажатия ОК.`
    );
    if (!ok) return;

    try {
      const token = accessToken || await ensureToken();
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: buildRawMessage(to, subject, body) }),
      });
      if (response.status === 401) {
        accessToken = '';
        const freshToken = await ensureToken();
        const retry = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: buildRawMessage(to, subject, body) }),
        });
        if (!retry.ok) throw new Error(`Gmail API ${retry.status}`);
      } else if (!response.ok) {
        throw new Error(`Gmail API ${response.status}`);
      }

      const markButton = document.querySelector(`[data-toggle-letter-sent="${CSS.escape(letterId)}"]`);
      if (markButton && /Отметить отправленным/i.test(markButton.textContent)) markButton.click();
      toast(`Письмо отправлено: ${to}`);
    } catch (error) {
      if (error.message === 'GMAIL_NOT_CONFIGURED') {
        openSettings();
      } else {
        console.error(error);
        toast('Не удалось отправить письмо через Gmail');
      }
    }
  }

  function openSettings() {
    const current = getClientId();
    const value = window.prompt(
      'Google OAuth Client ID для Gmail\n\nНужен тип Web application и разрешенный origin:\nhttps://ivankorytnik.github.io\n\nВставьте Client ID:',
      current
    );
    if (value === null) return;
    setClientId(value);
    if (value.trim()) toast('Gmail настроен. При первой отправке Google запросит доступ gmail.send');
  }

  function refreshGmailStatus() {
    let button = $('#gmail-connect');
    if (!button) {
      const actions = $('.topbar-actions');
      if (!actions) return;
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'gmail-connect';
      button.className = 'button button-soft';
      button.addEventListener('click', openSettings);
      actions.prepend(button);
    }
    if (!getClientId()) button.textContent = 'Подключить Gmail';
    else if (accessToken) button.textContent = 'Gmail подключен';
    else button.textContent = 'Gmail настроен';
  }

  function enhanceLetters() {
    const seed = window.INTENTRA_CRM_SEED;
    if (!seed?.letters) return;
    seed.letters.forEach((letter) => {
      const copyButton = document.querySelector(`[data-copy-letter="${CSS.escape(letter.id)}"]`);
      if (!copyButton) return;
      const container = copyButton.parentElement;
      if (!container || container.querySelector(`[data-send-gmail="${CSS.escape(letter.id)}"]`)) return;
      const email = extractEmail(letter.contact);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-small button-primary';
      button.dataset.sendGmail = letter.id;
      button.textContent = email ? 'Отправить из Gmail' : 'Нет e-mail';
      button.disabled = !email;
      button.title = email ? `Отправить менеджером на ${email}` : 'В шаблоне нет e-mail получателя';
      button.addEventListener('click', () => sendViaGmail(letter.id));
      container.prepend(button);

      const pre = copyButton.closest('.material-card')?.querySelector('.letter-text');
      if (pre) pre.textContent = normalizeSignature(letter.body);
    });
  }

  refreshGmailStatus();
  enhanceLetters();
  const observer = new MutationObserver(() => enhanceLetters());
  const materials = $('#materials-content');
  if (materials) observer.observe(materials, { childList: true, subtree: true });
})();
