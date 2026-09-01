(() => {
  'use strict';

  const CLIENT_ID_KEY = 'intentraSpace.gmail.clientId';
  const CRM_STORAGE_KEY = 'intentraSpace.crm.route1_1.v3';
  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
  const SIGNATURE = 'С уважением,\nРуководитель проекта - Корытник Иван Анатольевич\nINTENTRA SPACE';
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const TERMINAL_TASKS = new Set(['done', 'cancelled']);
  const STAGES = ['queued', 'contacted', 'waiting', 'connected', 'technical', 'meeting_proposed', 'meeting_scheduled', 'decision', 'paused'];
  const LETTER_STAGE_MAP = {
    l1: 'waiting',
    l2: 'waiting',
    l3: 'waiting',
    l4: 'meeting_proposed',
    l5: 'meeting_proposed',
    l6: 'waiting',
    l7: 'waiting',
    l8: 'waiting',
    l9: 'waiting',
    l10: 'waiting',
  };
  const LETTER_TASK_MAP = {
    l1: 't2',
    l2: 't3',
    l3: 't4',
    l4: 't7',
    l5: 't9',
  };

  let tokenClient = null;
  let accessToken = '';
  let gisPromise = null;
  let observer = null;
  let composeContext = null;
  let selectedAttachments = [];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function todayISO() {
    const date = new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function toast(text) {
    const old = $('#gmail-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'gmail-toast';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: '9999',
      background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: '10px',
      font: '12px Arial, sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.22)'
    });
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 3200);
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
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function encodeHeader(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `=?UTF-8?B?${btoa(binary)}?=`;
  }

  function wrapBase64(value) {
    return String(value || '').replace(/(.{76})/g, '$1\r\n');
  }

  function safeMimeName(value) {
    return String(value || 'attachment')
      .replace(/[\r\n]/g, ' ')
      .replace(/["\\]/g, '_');
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        resolve(value.includes(',') ? value.split(',').pop() : value);
      };
      reader.onerror = () => reject(reader.error || new Error('FILE_READ_FAILED'));
      reader.readAsDataURL(file);
    });
  }

  async function buildRawMessage(to, subject, body, attachments = []) {
    if (!attachments.length) {
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

    const boundary = `intentra_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const parts = [
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ];

    for (const file of attachments) {
      const encoded = await fileToBase64(file);
      const mimeType = file.type || 'application/octet-stream';
      const safeName = safeMimeName(file.name);
      const encodedName = encodeURIComponent(file.name || 'attachment');
      parts.push(
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${safeName}"; name*=UTF-8''${encodedName}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
        '',
        wrapBase64(encoded),
      );
    }

    parts.push(`--${boundary}--`, '');
    return utf8ToBase64Url(parts.join('\r\n'));
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
    if (summary) contactText = $$('p', summary).map((p) => p.textContent || '').join(' ');

    let to = extractEmail(contactText);
    if (!to && id) {
      const seedLetter = window.INTENTRA_CRM_SEED?.letters?.find((item) => item.id === id);
      if (seedLetter) to = extractEmail(seedLetter.contact);
    }
    return { id, to, subject, body, bodyEl, card };
  }

  async function postMessage(token, data) {
    const raw = await buildRawMessage(data.to, data.subject, data.body, data.attachments || []);
    return fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  }

  function attachmentMeta(data) {
    return (data.attachments || []).map((file) => ({
      name: file.name,
      size: Number(file.size || 0),
      type: file.type || 'application/octet-stream',
    }));
  }

  function pushActivity(state, type, text, relatedId = '', at = new Date().toISOString()) {
    state.activity = Array.isArray(state.activity) ? state.activity : [];
    state.activity.unshift({ at, type, text, relatedId });
    state.activity = state.activity.slice(0, 300);
  }

  function findLetterAndContact(state, data) {
    const stateLetter = Array.isArray(state.letters)
      ? state.letters.find((item) => item.id === data.id)
      : null;
    const seedLetter = window.INTENTRA_CRM_SEED?.letters?.find((item) => item.id === data.id);
    const contactId = stateLetter?.contactId || seedLetter?.contactId || '';
    let contact = Array.isArray(state.contacts) ? state.contacts.find((item) => item.id === contactId) : null;
    if (!contact && data.to) {
      contact = state.contacts?.find((item) => String(item.email || '').toLowerCase() === data.to.toLowerCase()) || null;
    }
    return { stateLetter, seedLetter, contact };
  }

  function moveContactForward(state, contact, targetStage, reason, at) {
    if (!contact || !targetStage || contact.stage === 'paused') return false;
    const currentIndex = STAGES.indexOf(contact.stage);
    const targetIndex = STAGES.indexOf(targetStage);
    if (targetIndex < 0 || currentIndex < 0 || currentIndex >= targetIndex) return false;
    const from = contact.stage;
    contact.stage = targetStage;
    contact.history = Array.isArray(contact.history) ? contact.history : [];
    contact.history.push({ from, to: targetStage, at, reason });
    pushActivity(state, 'stage', `${contact.name}: ${from} → ${targetStage}. ${reason}`, contact.id, at);
    return true;
  }

  function findLinkedTask(state, data, contact) {
    const mappedId = LETTER_TASK_MAP[data.id];
    if (mappedId) {
      const mapped = state.tasks?.find((task) => task.id === mappedId);
      if (mapped && !TERMINAL_TASKS.has(mapped.status)) return mapped;
    }
    if (!contact) return null;
    const candidates = (state.tasks || [])
      .filter((task) => task.contactId === contact.id && !TERMINAL_TASKS.has(task.status))
      .filter((task) => /письм|отправ|e-mail|email|интро|встреч/i.test([task.title, task.action, task.channel].join(' ')))
      .sort((a, b) => Number(a.number || 999) - Number(b.number || 999));
    return candidates[0] || null;
  }

  function syncEmailToCRM(data, options = {}) {
    let state;
    try {
      state = JSON.parse(localStorage.getItem(CRM_STORAGE_KEY) || 'null');
    } catch (_) {
      state = null;
    }
    if (!state || typeof state !== 'object') return null;

    const at = options.at || new Date().toISOString();
    const { contact } = findLetterAndContact(state, data);
    const task = findLinkedTask(state, data, contact);
    const targetStage = LETTER_STAGE_MAP[data.id] || 'waiting';
    const method = options.method || 'gmail';
    const methodLabel = method === 'gmail' ? 'Gmail' : 'вручную';
    const attachments = attachmentMeta(data);
    const attachmentNames = attachments.map((item) => item.name);
    const attachmentText = attachmentNames.length ? ` Вложения: ${attachmentNames.join(', ')}.` : '';

    state.letterStatus = state.letterStatus && typeof state.letterStatus === 'object' ? state.letterStatus : {};
    state.letterStatus[data.id] = {
      ...(state.letterStatus[data.id] || {}),
      sentAt: at,
      method,
      to: data.to,
      subject: data.subject,
      sentBody: data.body,
      attachments,
      gmailMessageId: options.gmailMessageId || state.letterStatus[data.id]?.gmailMessageId || '',
    };

    state.emailHistory = Array.isArray(state.emailHistory) ? state.emailHistory : [];
    state.emailHistory.unshift({
      at,
      letterId: data.id,
      contactId: contact?.id || '',
      taskId: task?.id || '',
      method,
      to: data.to,
      subject: data.subject,
      attachments,
      gmailMessageId: options.gmailMessageId || '',
    });
    state.emailHistory = state.emailHistory.slice(0, 300);

    if (contact) {
      contact.lastContactAt = at;
      contact.lastContactChannel = method === 'gmail' ? 'Gmail' : 'E-mail';
      contact.lastContactEmail = data.to;
      contact.lastContactSubject = data.subject;
      contact.lastContactAttachments = attachmentNames;
      moveContactForward(state, contact, targetStage, `Письмо отправлено ${methodLabel}: «${data.subject}».${attachmentText}`, at);
    }

    if (task && !TERMINAL_TASKS.has(task.status)) {
      task.status = 'waiting';
      task.lastActivityAt = at;
      task.lastEmailAt = at;
      task.lastEmailSubject = data.subject;
      task.lastEmailTo = data.to;
      task.lastEmailAttachments = attachmentNames;
      const note = `${todayISO()}: письмо отправлено ${methodLabel} на ${data.to}. Ожидаем ответ. Тема: ${data.subject}.${attachmentText}`;
      task.comment = task.comment ? `${task.comment}\n${note}` : note;
      pushActivity(state, 'task_waiting', `Задача переведена в «Ожидаем»: ${task.title}`, task.id, at);
    }

    pushActivity(
      state,
      'email_sent',
      `Отправлено письмо ${methodLabel}: ${data.to}. Тема: ${data.subject}.${attachmentText}`,
      contact?.id || data.id,
      at
    );
    state.updatedAt = at;
    localStorage.setItem(CRM_STORAGE_KEY, JSON.stringify(state));

    return {
      contactName: contact?.shortName || contact?.name || '',
      taskTitle: task?.title || '',
      targetStage,
      attachmentNames,
    };
  }

  function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return `${size} Б`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
    return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function attachmentKey(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  function renderAttachments() {
    const list = $('#gmail-attachment-list');
    const total = $('#gmail-attachment-total');
    if (!list || !total) return;
    const totalBytes = selectedAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0);
    total.textContent = selectedAttachments.length
      ? `${selectedAttachments.length} файл(а), ${formatBytes(totalBytes)}`
      : 'Файлы не выбраны';
    list.innerHTML = selectedAttachments.map((file, index) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(120,130,150,.22);border-radius:10px;margin-top:7px">
        <div style="min-width:0;flex:1">
          <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${String(file.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</strong>
          <span style="font-size:11px;color:#697386">${formatBytes(file.size)}</span>
        </div>
        <button type="button" class="button button-soft" data-remove-attachment="${index}" style="padding:6px 9px">Удалить</button>
      </div>`).join('');
  }

  function resetAttachments() {
    selectedAttachments = [];
    const input = $('#gmail-attachments');
    if (input) input.value = '';
    renderAttachments();
  }

  function addAttachments(files) {
    const current = new Map(selectedAttachments.map((file) => [attachmentKey(file), file]));
    Array.from(files || []).forEach((file) => current.set(attachmentKey(file), file));
    const next = Array.from(current.values());
    const totalBytes = next.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      toast('Суммарный размер вложений не должен превышать 20 МБ');
      return;
    }
    selectedAttachments = next;
    renderAttachments();
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
          <label class="field field-wide"><span>Текст письма *</span><textarea name="body" rows="15" required style="min-height:300px;line-height:1.5;resize:vertical"></textarea></label>
          <div class="field field-wide">
            <span>Вложения</span>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:7px">
              <label class="button button-soft" style="cursor:pointer;margin:0">
                + Прикрепить файл
                <input id="gmail-attachments" type="file" multiple hidden>
              </label>
              <span id="gmail-attachment-total" style="font-size:11px;color:#697386">Файлы не выбраны</span>
            </div>
            <div id="gmail-attachment-list"></div>
            <small style="display:block;margin-top:7px;color:#697386">Можно выбрать несколько файлов. До 20 МБ суммарно.</small>
          </div>
        </div>
        <div style="padding:0 22px 4px;color:#697386;font-size:11px">После отправки CRM зафиксирует письмо и названия вложений, переведет связанную задачу в «Ожидаем» и обновит этап ЛПР. Письмо уйдет только после нажатия менеджером кнопки ниже.</div>
        <div class="modal-actions">
          <button class="button button-soft" type="button" data-gmail-close>Отмена</button>
          <button class="button button-primary" type="submit" id="gmail-send-confirm">Отправить письмо</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);

    $('#gmail-attachments', dialog).addEventListener('change', (event) => {
      addAttachments(event.target.files);
      event.target.value = '';
    });

    $('#gmail-attachment-list', dialog).addEventListener('click', (event) => {
      const removeButton = event.target.closest('[data-remove-attachment]');
      if (!removeButton) return;
      const index = Number(removeButton.dataset.removeAttachment);
      if (!Number.isInteger(index) || index < 0 || index >= selectedAttachments.length) return;
      selectedAttachments.splice(index, 1);
      renderAttachments();
    });

    $$('[data-gmail-close]', dialog).forEach((button) => {
      button.addEventListener('click', () => {
        composeContext = null;
        resetAttachments();
        if (dialog.open) dialog.close();
      });
    });
    dialog.addEventListener('cancel', () => {
      composeContext = null;
      resetAttachments();
    });

    $('#gmail-compose-form', dialog).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!composeContext) return;
      const form = event.currentTarget;
      const subject = form.elements.subject.value.trim();
      const body = form.elements.body.value.trim();
      if (!subject || !body) return toast('Заполните тему и текст письма');

      const totalBytes = selectedAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0);
      if (totalBytes > MAX_ATTACHMENT_BYTES) return toast('Суммарный размер вложений не должен превышать 20 МБ');

      const sendButton = $('#gmail-send-confirm', dialog);
      sendButton.disabled = true;
      sendButton.textContent = selectedAttachments.length ? 'Готовим вложения...' : 'Отправляем...';

      try {
        const message = {
          ...composeContext.data,
          subject,
          body,
          attachments: selectedAttachments.slice(),
        };
        let token = accessToken || await ensureToken();
        sendButton.textContent = 'Отправляем...';
        let response = await postMessage(token, message);
        if (response.status === 401) {
          accessToken = '';
          token = await ensureToken();
          response = await postMessage(token, message);
        }
        if (!response.ok) throw new Error(`GMAIL_API_${response.status}`);
        let gmailResult = {};
        try { gmailResult = await response.json(); } catch (_) {}

        const syncResult = syncEmailToCRM(message, {
          method: 'gmail',
          gmailMessageId: gmailResult.id || '',
        });

        if (dialog.open) dialog.close();
        composeContext = null;
        resetAttachments();
        const attachmentInfo = syncResult?.attachmentNames?.length
          ? ` Вложений: ${syncResult.attachmentNames.length}.`
          : '';
        const processText = syncResult?.taskTitle
          ? ' Задача переведена в «Ожидаем», воронка и история обновлены.'
          : ' Воронка и история CRM обновлены.';
        toast(`Письмо отправлено: ${message.to}.${attachmentInfo}${processText}`);
        window.setTimeout(() => window.location.reload(), 1400);
      } catch (error) {
        console.error('Gmail send failed', error);
        if (error.message === 'GMAIL_NOT_CONFIGURED') {
          openSettings();
          toast('Сначала укажите Google OAuth Client ID');
        } else if (error.message === 'FILE_READ_FAILED') {
          toast('Не удалось прочитать один из прикрепленных файлов');
        } else toast('Не удалось отправить письмо через Gmail');
      } finally {
        sendButton.disabled = false;
        sendButton.textContent = 'Отправить письмо';
      }
    });
    return dialog;
  }

  function openCompose(card) {
    const data = getLetterDataFromCard(card);
    if (!data) return toast('Не удалось прочитать письмо');
    if (!data.to) return toast('У этого письма нет e-mail получателя');
    const dialog = ensureComposeDialog();
    const form = $('#gmail-compose-form', dialog);
    form.elements.to.value = data.to;
    form.elements.subject.value = data.subject;
    form.elements.body.value = data.body;
    resetAttachments();
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
    button.textContent = !getClientId() ? 'Подключить Gmail' : accessToken ? 'Gmail подключен' : 'Gmail настроен';
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
    button.title = data?.to ? `Открыть редактор письма для ${data.to}` : 'В карточке письма не найден e-mail';
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

  document.addEventListener('click', (event) => {
    const sentButton = event.target.closest?.('[data-toggle-letter-sent]');
    if (!sentButton || !/Отметить отправленным/i.test(sentButton.textContent || '')) return;
    const card = sentButton.closest('.material-card');
    if (!card) return;
    const data = getLetterDataFromCard(card);
    if (!data) return;
    window.setTimeout(() => {
      const result = syncEmailToCRM(data, { method: 'manual' });
      if (result) {
        toast('Отправка зафиксирована: задача, воронка и история обновлены');
        window.setTimeout(() => window.location.reload(), 900);
      }
    }, 120);
  });

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
