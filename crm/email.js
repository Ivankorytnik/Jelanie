(() => {
  'use strict';

  const CLIENT_ID_KEY = 'intentraSpace.gmail.clientId';
  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
  const SIGNATURE = 'С уважением,\nРуководитель проекта - Корытник Иван Анатольевич\nINTENTRA SPACE';

  let tokenClient = null;
  let accessToken = '';
  let gisPromise = null;
  let observer = null;
  let composeContext = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function toast(text) {
    const old = $('#gmail-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'gmail-toast';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '9999',
      background: '#111827',
      color: '#fff',
      padding: '10px 14px',
      borderRadius: '10px',
      font: '12px Arial, sans-serif',
      boxShadow: '0 12px 30px rgba(0,0,0,.22)'
    });
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 2600);
  }

  function normalizeSignature(body) {
    let clean = String(body || '').trim();
    const markers = ['\nС уважением,', '\r\nС уважением,', 'С уважением,'];
    let cut = -1;
    markers.forEach((marker) => {
      const pos = clean.lastIndexOf(marker);
      if (pos >= 0 && (cut < 0 || pos < cut)) cut = pos;
    });
    if (cut >= 0) clean = clean.slice(0, cut).trimEnd();
    return `${clean}\n\n${SIGNATURE}`;
  }

  function extractEmail(text) {
    const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : '';
  }

  function utf8ToBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function encodeHeader(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return `=?UTF-8?B?${btoa(binary)}?=`;
  }

  function buildRawMessage(to, subject, body) {
    return utf8ToBase64Url([
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n'));
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

  function loadGoogleIdentity() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('GOOGLE_IDENTITY_LOAD_FAILED'));
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  async function ensureToken() {
    const clientId = getClientId();
    if (!clientId) throw new Error('GMAIL_NOT_CONFIGURED');
    await loadGoogleIdentity();
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        callback: () => {},
      });
    }
    return new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        accessToken = response.access_token || '';
        refreshGmailStatus();
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
    });
  }

  function getLetterDataFromCard(card) {
    if (!card) return null;
    const copyButton = $('[data-copy-letter]', card);
    const id = copyButton?.dataset.copyLetter || '';
    const summary = $('summary', card);
    const subject = $('.material-subject', card)?.textContent?.trim() || '';
    const bodyEl = $('.letter-text', card);
    const body = normalizeSignature(bodyEl?.textContent || '');

    let contactText = '';
    if (summary) {
      const paragraphs = $$('p', summary);
      contactText = paragraphs.map((p) => p.textContent || '').join(' ');
    }

    let to = extractEmail(contactText);
    if (!to && id) {
      const seedLetter = window.INTENTRA_CRM_SEED?.letters?.find((item) => item.id === id);
      if (seedLetter) to = extractEmail(seedLetter.contact);
    }

    return { id, to, subject, body, bodyEl, card };
  }

  async function postMessage(token, data) {
    return fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: buildRawMessage(data.to, data.subject, data.body) }),
    });
  }

  function ensureComposeDialog() {
    let dialog = $('#gmail-compose-modal');
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.id = 'gmail-compose-modal';
    dialog.className = 'modal';
    dialog.innerHTML = `
      <form id="gmail-compose-form" class="modal-card modal-large" method="dialog">
        <div class="modal-heading">
          <div><span class="section-label">Проверка перед отправкой</span><h2>Письмо из Gmail</h2></div>
          <button class="modal-close" type="button" data-gmail-close aria-label="Закрыть">×</button>
        </div>
        <div class="form-grid">
          <label class="field field-wide"><span>Кому</span><input name="to" type="email" readonly></label>
          <label class="field field-wide"><span>Тема *</span><input name="subject" required maxlength="300"></label>
          <label class="field field-wide"><span>Текст письма *</span><textarea name="body" rows="18" required style="min-height:360px;line-height:1.5;resize:vertical"></textarea></label>
        </div>
        <div style="padding:0 22px 4px;color:#697386;font-size:11px">Письмо не отправляется автоматически. Оно уйдет только после нажатия кнопки «Отправить письмо» менеджером.</div>
        <div class="modal-actions">
          <button class="button button-soft" type="button" data-gmail-close>Отмена</button>
          <button class="button button-primary" type="submit" id="gmail-send-confirm">Отправить письмо</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);

    $$('[data-gmail-close]', dialog).forEach((button) => {
      button.addEventListener('click', () => {
        composeContext = null;
        if (dialog.open) dialog.close();
      });
    });

    dialog.addEventListener('cancel', () => { composeContext = null; });

    $('#gmail-compose-form', dialog).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!composeContext) return;

      const form = event.currentTarget;
      const subject = form.elements.subject.value.trim();
      const body = form.elements.body.value.trim();
      if (!subject || !body) {
        toast('Заполните тему и текст письма');
        return;
      }

      const sendButton = $('#gmail-send-confirm', dialog);
      sendButton.disabled = true;
      sendButton.textContent = 'Отправляем...';

      try {
        const message = {
          ...composeContext.data,
          subject,
          body,
        };
        let token = accessToken || await ensureToken();
        let response = await postMessage(token, message);
        if (response.status === 401) {
          accessToken = '';
          token = await ensureToken();
          response = await postMessage(token, message);
        }
        if (!response.ok) throw new Error(`GMAIL_API_${response.status}`);

        const sentToggle = $('[data-toggle-letter-sent]', composeContext.card);
        if (sentToggle && /Отметить отправленным/i.test(sentToggle.textContent || '')) sentToggle.click();

        if (dialog.open) dialog.close();
        toast(`Письмо отправлено: ${message.to}`);
        composeContext = null;
      } catch (error) {
        console.error('Gmail send failed', error);
        if (error.message === 'GMAIL_NOT_CONFIGURED') {
          openSettings();
          toast('Сначала укажите Google OAuth Client ID');
        } else {
          toast('Не удалось отправить письмо через Gmail');
        }
      } finally {
        sendButton.disabled = false;
        sendButton.textContent = 'Отправить письмо';
      }
    });

    return dialog;
  }

  function openCompose(card) {
    const data = getLetterDataFromCard(card);
    if (!data) {
      toast('Не удалось прочитать письмо');
      return;
    }
    if (!data.to) {
      toast('У этого письма нет e-mail получателя');
      return;
    }

    const dialog = ensureComposeDialog();
    const form = $('#gmail-compose-form', dialog);
    form.elements.to.value = data.to;
    form.elements.subject.value = data.subject;
    form.elements.body.value = data.body;
    composeContext = { card, data };

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    window.setTimeout(() => form.elements.subject.focus(), 50);
  }

  function openSettings() {
    const value = window.prompt(
      'Google OAuth Client ID для Gmail\n\nТип: Web application\nAuthorized JavaScript origin:\nhttps://ivankorytnik.github.io\n\nВставьте Client ID:',
      getClientId()
    );
    if (value === null) return;
    setClientId(value);
    if (value.trim()) toast('Gmail настроен. Отправка возможна только по кнопке менеджера');
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
    button.textContent = !getClientId()
      ? 'Подключить Gmail'
      : accessToken
        ? 'Gmail подключен'
        : 'Gmail настроен';
    button.title = 'Gmail отправляет письмо только после явного нажатия менеджером';
  }

  function addSendButton(card) {
    if (!card || $('[data-send-gmail]', card)) return;
    const copyButton = $('[data-copy-letter]', card);
    if (!copyButton) return;
    const data = getLetterDataFromCard(card);
    if (data?.bodyEl) data.bodyEl.textContent = data.body;

    const container = copyButton.parentElement;
    if (!container) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-small button-primary';
    button.dataset.sendGmail = data?.id || 'rendered';
    button.textContent = data?.to ? 'Отправить из Gmail' : 'Нет e-mail';
    button.disabled = !data?.to;
    button.title = data?.to
      ? `Открыть редактор письма для ${data.to}`
      : 'В карточке письма не найден e-mail';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openCompose(card);
    });
    container.prepend(button);
  }

  function enhanceLetters() {
    $$('.material-card').forEach((card) => {
      if ($('[data-copy-letter]', card)) addSendButton(card);
    });
  }

  async function copyNormalizedLetter(card) {
    const data = getLetterDataFromCard(card);
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.body);
      toast('Письмо скопировано с новой подписью');
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = data.body;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('Письмо скопировано с новой подписью');
    }
  }

  document.addEventListener('click', (event) => {
    const copy = event.target.closest?.('[data-copy-letter]');
    if (!copy) return;
    const card = copy.closest('.material-card');
    if (!card) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    copyNormalizedLetter(card);
  }, true);

  function init() {
    refreshGmailStatus();
    ensureComposeDialog();
    enhanceLetters();
    const materials = $('#materials-content');
    if (materials) {
      observer = new MutationObserver(() => enhanceLetters());
      observer.observe(materials, { childList: true, subtree: true });
    }
    window.setInterval(enhanceLetters, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
