(() => {
  'use strict';

  const CRM_STORAGE_KEY = 'intentraSpace.crm.route1_1.v3';
  const CLIENT_ID_KEY = 'intentraSpace.gmail.clientId';
  const SYNC_ENABLED_KEY = 'intentraSpace.cloudSync.enabled';
  const FILE_ID_KEY = 'intentraSpace.cloudSync.fileId';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const CLOUD_FILE_NAME = 'INTENTRA_SPACE_CRM_SYNC.json';
  const POLL_MS = 20000;
  const LOCAL_SCAN_MS = 1800;

  let tokenClient = null;
  let accessToken = '';
  let gisPromise = null;
  let fileId = localStorage.getItem(FILE_ID_KEY) || '';
  let connected = false;
  let busy = false;
  let applyingRemote = false;
  let lastLocalFingerprint = '';
  let lastCloudFingerprint = '';
  let lastSyncAt = '';
  let localTimer = null;
  let remoteTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);

  function parseState(text) {
    try {
      const value = JSON.parse(text || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function getLocalState() {
    return parseState(localStorage.getItem(CRM_STORAGE_KEY));
  }

  function stateFingerprint(state) {
    if (!state) return '';
    const clone = JSON.parse(JSON.stringify(state));
    delete clone.updatedAt;
    delete clone.cloudSyncedAt;
    delete clone.cloudSyncSource;
    return JSON.stringify(clone);
  }

  function isPristineState(state) {
    if (!state) return true;
    const contactsClean = Array.isArray(state.contacts) && state.contacts.every((contact) =>
      (contact.stage === 'queued' || !contact.stage)
      && (!Array.isArray(contact.history) || contact.history.length === 0)
      && !contact.note
      && !contact.lastContactAt
    );
    const tasksClean = Array.isArray(state.tasks) && state.tasks.every((task) =>
      (task.status === 'todo' || !task.status)
      && !task.actualDate
      && !task.actualResult
      && !task.completedAt
      && !task.lastEmailAt
      && !task.comment
    );
    const lettersClean = !state.letterStatus || Object.keys(state.letterStatus).length === 0;
    const meetingClean = !state.meeting?.confirmed && !state.meeting?.date && !state.meeting?.time && !state.meeting?.technicalOwner;
    const activityClean = !Array.isArray(state.activity) || state.activity.length === 0;
    return contactsClean && tasksClean && lettersClean && meetingClean && activityClean && !state.selectedRoute;
  }

  function timestamp(state) {
    const value = Date.parse(state?.updatedAt || state?.createdAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function getClientId() {
    return localStorage.getItem(CLIENT_ID_KEY) || '';
  }

  function setStatus(label, mode = 'idle', title = '') {
    let button = $('#cloud-sync-button');
    if (!button) {
      const actions = $('.topbar-actions');
      if (!actions) return;
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'cloud-sync-button';
      button.className = 'button button-soft';
      button.addEventListener('click', () => connectAndSync(true));
      actions.prepend(button);
    }
    button.textContent = label;
    button.dataset.syncMode = mode;
    button.title = title || 'Синхронизация CRM между устройствами через скрытое хранилище Google Drive';
  }

  function showToast(text) {
    const old = $('#cloud-sync-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'cloud-sync-toast';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', right: '20px', bottom: '64px', zIndex: 10000,
      background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: '10px',
      font: '12px Arial, sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.22)', maxWidth: '360px'
    });
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4200);
  }

  function loadGoogleIdentity() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existing) {
        const wait = () => {
          if (window.google?.accounts?.oauth2) resolve();
          else window.setTimeout(wait, 100);
        };
        wait();
        return;
      }
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

  async function requestToken(interactive) {
    const clientId = getClientId();
    if (!clientId) throw new Error('CLIENT_ID_MISSING');
    await loadGoogleIdentity();
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
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
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  }

  async function driveFetch(url, options = {}, allowRetry = true) {
    const token = accessToken || await requestToken(false);
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401 && allowRetry) {
      accessToken = '';
      await requestToken(false);
      return driveFetch(url, options, false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`DRIVE_${response.status}`);
      error.status = response.status;
      error.details = text;
      throw error;
    }
    return response;
  }

  async function findCloudFile() {
    if (fileId) return fileId;
    const q = encodeURIComponent(`name = '${CLOUD_FILE_NAME}' and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=10`;
    const response = await driveFetch(url);
    const json = await response.json();
    const found = json.files?.[0]?.id || '';
    if (found) {
      fileId = found;
      localStorage.setItem(FILE_ID_KEY, fileId);
    }
    return fileId;
  }

  async function readCloudState() {
    const id = await findCloudFile();
    if (!id) return null;
    try {
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      return parseState(await response.text());
    } catch (error) {
      if (error.status === 404) {
        fileId = '';
        localStorage.removeItem(FILE_ID_KEY);
        return null;
      }
      throw error;
    }
  }

  async function createCloudState(state) {
    const boundary = `intentra_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({
      name: CLOUD_FILE_NAME,
      parents: ['appDataFolder'],
      mimeType: 'application/json',
    });
    const content = JSON.stringify(state);
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const json = await response.json();
    fileId = json.id || '';
    if (fileId) localStorage.setItem(FILE_ID_KEY, fileId);
    return json;
  }

  async function updateCloudState(state) {
    const id = await findCloudFile();
    if (!id) return createCloudState(state);
    const response = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(state),
    });
    return response.json();
  }

  function prepareForCloud(state) {
    const copy = JSON.parse(JSON.stringify(state));
    copy.cloudSyncedAt = new Date().toISOString();
    copy.cloudSyncSource = 'google-drive-appdata';
    return copy;
  }

  async function uploadLocal(force = false) {
    if (!connected || busy || applyingRemote) return false;
    const local = getLocalState();
    if (!local) return false;
    const fingerprint = stateFingerprint(local);
    if (!force && fingerprint === lastCloudFingerprint) return false;
    busy = true;
    setStatus('Облако: сохраняем...', 'syncing');
    try {
      const cloudState = prepareForCloud(local);
      await updateCloudState(cloudState);
      lastCloudFingerprint = fingerprint;
      lastLocalFingerprint = fingerprint;
      lastSyncAt = new Date().toISOString();
      setStatus('Облако ✓', 'connected', `Синхронизировано ${new Date(lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
      return true;
    } finally {
      busy = false;
    }
  }

  function applyRemoteState(remote) {
    if (!remote) return false;
    applyingRemote = true;
    const fingerprint = stateFingerprint(remote);
    lastCloudFingerprint = fingerprint;
    lastLocalFingerprint = fingerprint;
    localStorage.setItem(CRM_STORAGE_KEY, JSON.stringify(remote));
    window.setTimeout(() => window.location.reload(), 180);
    return true;
  }

  async function reconcile({ forceCloudCheck = false } = {}) {
    if (!connected || busy) return;
    busy = true;
    setStatus('Облако: проверяем...', 'syncing');
    try {
      const local = getLocalState();
      const remote = await readCloudState();
      if (!remote) {
        if (local) {
          const cloudState = prepareForCloud(local);
          await createCloudState(cloudState);
          lastCloudFingerprint = stateFingerprint(local);
          lastLocalFingerprint = lastCloudFingerprint;
          lastSyncAt = new Date().toISOString();
          setStatus('Облако ✓', 'connected', 'Создана облачная копия CRM');
          if (forceCloudCheck) showToast('Облачная синхронизация включена. Текущая CRM сохранена в Google Drive.');
        }
        return;
      }

      const localFingerprint = stateFingerprint(local);
      const remoteFingerprint = stateFingerprint(remote);
      lastCloudFingerprint = remoteFingerprint;
      lastLocalFingerprint = localFingerprint;

      if (localFingerprint === remoteFingerprint) {
        lastSyncAt = new Date().toISOString();
        setStatus('Облако ✓', 'connected', 'Данные на устройстве и в облаке совпадают');
        if (forceCloudCheck) showToast('CRM синхронизирована. Данные совпадают.');
        return;
      }

      if (!local || isPristineState(local)) {
        showToast('Найдены рабочие данные в облаке. Загружаю их на это устройство...');
        applyRemoteState(remote);
        return;
      }

      if (timestamp(remote) > timestamp(local)) {
        showToast('В облаке есть более новая версия CRM. Обновляю это устройство...');
        applyRemoteState(remote);
        return;
      }

      const cloudState = prepareForCloud(local);
      await updateCloudState(cloudState);
      lastCloudFingerprint = localFingerprint;
      lastSyncAt = new Date().toISOString();
      setStatus('Облако ✓', 'connected', 'Локальные изменения отправлены в облако');
      if (forceCloudCheck) showToast('Последняя версия с этого устройства сохранена в облаке.');
    } finally {
      busy = false;
    }
  }

  async function connectAndSync(interactive = true) {
    if (busy) return;
    let clientId = getClientId();
    if (!clientId && interactive) {
      clientId = window.prompt(
        'Для синхронизации используется тот же Google OAuth Client ID, что и для Gmail.\n\nВставьте Client ID вида *.apps.googleusercontent.com:',
        ''
      )?.trim() || '';
      if (clientId) localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    if (!clientId) {
      setStatus('Облако: настроить', 'setup', 'Нужен Google OAuth Client ID');
      if (interactive) showToast('Сначала укажите Google OAuth Client ID.');
      return;
    }

    busy = true;
    setStatus('Облако: вход...', 'syncing');
    try {
      await requestToken(interactive);
      connected = true;
      localStorage.setItem(SYNC_ENABLED_KEY, '1');
      setStatus('Облако ✓', 'connected');
    } catch (error) {
      console.warn('Cloud sync auth failed', error);
      connected = false;
      setStatus('Облако: войти', 'error', 'Нажмите для входа в Google и синхронизации');
      if (interactive) showToast('Не удалось подключить Google Drive. Проверьте OAuth и доступ к Drive API.');
      busy = false;
      return;
    }
    busy = false;

    try {
      await reconcile({ forceCloudCheck: interactive });
      startLoops();
    } catch (error) {
      console.warn('Cloud sync failed', error);
      connected = false;
      const apiHint = error.status === 403 ? ' В Google Cloud нужно включить Google Drive API.' : '';
      setStatus('Облако: ошибка', 'error', `Синхронизация не выполнена.${apiHint}`);
      if (interactive) showToast(`Не удалось синхронизировать CRM.${apiHint}`);
    }
  }

  async function checkLocalChanges() {
    if (!connected || busy || applyingRemote) return;
    const local = getLocalState();
    const fingerprint = stateFingerprint(local);
    if (!fingerprint) return;
    if (!lastLocalFingerprint) lastLocalFingerprint = fingerprint;
    if (fingerprint !== lastLocalFingerprint) {
      lastLocalFingerprint = fingerprint;
      try {
        await uploadLocal(false);
      } catch (error) {
        console.warn('Auto upload failed', error);
        setStatus('Облако: ошибка', 'error', 'Автосохранение в облако не выполнено. Нажмите для повторной синхронизации.');
      }
    }
  }

  async function checkRemoteChanges() {
    if (!connected || busy || applyingRemote || document.hidden) return;
    try {
      await reconcile();
    } catch (error) {
      console.warn('Remote sync check failed', error);
      if (error.status === 401) {
        connected = false;
        setStatus('Облако: войти', 'error');
      }
    }
  }

  function startLoops() {
    if (!localTimer) localTimer = window.setInterval(checkLocalChanges, LOCAL_SCAN_MS);
    if (!remoteTimer) remoteTimer = window.setInterval(checkRemoteChanges, POLL_MS);
  }

  function init() {
    setStatus(getClientId() ? 'Облако: подключить' : 'Облако: настроить', 'setup');
    const enabled = localStorage.getItem(SYNC_ENABLED_KEY) === '1';
    if (enabled && getClientId()) {
      window.setTimeout(() => connectAndSync(false), 700);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && connected) checkRemoteChanges();
    });
    window.addEventListener('online', () => {
      if (connected) checkRemoteChanges();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
