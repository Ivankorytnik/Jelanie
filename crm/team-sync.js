(() => {
  'use strict';

  const CRM_STORAGE_KEY = 'intentraSpace.crm.route1_1.v3';
  const FIREBASE_CONFIG_KEY = 'intentraSpace.firebase.config';
  const FIREBASE_SESSION_KEY = 'intentraSpace.firebase.enabled';
  const DEFAULT_WORKSPACE = 'intentra-space-main';
  const LOCAL_SCAN_MS = 1500;

  let fb = null;
  let app = null;
  let auth = null;
  let db = null;
  let user = null;
  let workspaceRef = null;
  let unsubscribeSnapshot = null;
  let lastFingerprint = '';
  let applyingRemote = false;
  let writing = false;
  let localTimer = null;
  let workspaceMeta = null;

  const $ = (selector, root = document) => root.querySelector(selector);

  function toast(text) {
    const old = $('#team-sync-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'team-sync-toast';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', right: '20px', bottom: '64px', zIndex: 10001,
      background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: '10px',
      font: '12px Arial, sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.22)', maxWidth: '420px'
    });
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4500);
  }

  function parseJson(value) {
    try {
      const parsed = JSON.parse(value || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function getLocalState() {
    return parseJson(localStorage.getItem(CRM_STORAGE_KEY));
  }

  function fingerprint(state) {
    if (!state) return '';
    const copy = JSON.parse(JSON.stringify(state));
    delete copy.updatedAt;
    delete copy.cloudSyncedAt;
    delete copy.cloudSyncSource;
    delete copy.lastEditedBy;
    delete copy.lastEditedByEmail;
    return JSON.stringify(copy);
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function getBootstrap() {
    const fromFile = window.INTENTRA_FIREBASE || {};
    const fromLocal = parseJson(localStorage.getItem(FIREBASE_CONFIG_KEY));
    return {
      workspaceId: fromFile.workspaceId || DEFAULT_WORKSPACE,
      config: fromLocal || fromFile.config || null,
    };
  }

  function validConfig(config) {
    return Boolean(config?.apiKey && config?.authDomain && config?.projectId && config?.appId);
  }

  function setButton(label, mode = 'idle', title = '') {
    let button = $('#team-sync-button');
    if (!button) {
      const actions = $('.topbar-actions');
      if (!actions) return;
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'team-sync-button';
      button.className = 'button button-soft';
      button.addEventListener('click', handleTeamButton);
      actions.prepend(button);
    }
    button.textContent = label;
    button.dataset.teamMode = mode;
    button.title = title || 'Общая CRM для нескольких менеджеров';
  }

  async function loadFirebase() {
    if (fb) return fb;
    const [appMod, authMod, fsMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
    ]);
    fb = { ...appMod, ...authMod, ...fsMod };
    return fb;
  }

  function promptFirebaseConfig() {
    const current = localStorage.getItem(FIREBASE_CONFIG_KEY) || '';
    const value = window.prompt(
      'Вставьте Firebase Web App config в формате JSON.\n\nПример:\n{"apiKey":"...","authDomain":"...firebaseapp.com","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}',
      current
    );
    if (value === null) return null;
    const parsed = parseJson(value);
    if (!validConfig(parsed)) {
      toast('Конфигурация Firebase не распознана. Нужны apiKey, authDomain, projectId и appId.');
      return null;
    }
    localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(parsed));
    return parsed;
  }

  async function initFirebase(config) {
    await loadFirebase();
    if (!app) app = fb.initializeApp(config);
    if (!auth) auth = fb.getAuth(app);
    if (!db) db = fb.getFirestore(app);
    await fb.setPersistence(auth, fb.browserLocalPersistence);
  }

  async function signIn(interactive = true) {
    const bootstrap = getBootstrap();
    let config = bootstrap.config;
    if (!validConfig(config) && interactive) config = promptFirebaseConfig();
    if (!validConfig(config)) {
      setButton('Команда: настроить', 'setup', 'Нужно один раз вставить Firebase Web App config');
      return false;
    }

    await initFirebase(config);
    user = auth.currentUser;
    if (!user && interactive) {
      const provider = new fb.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await fb.signInWithPopup(auth, provider);
      user = result.user;
    }
    if (!user) return false;

    localStorage.setItem(FIREBASE_SESSION_KEY, '1');
    return true;
  }

  function workspaceId() {
    return getBootstrap().workspaceId || DEFAULT_WORKSPACE;
  }

  async function ensureWorkspace() {
    workspaceRef = fb.doc(db, 'workspaces', workspaceId());
    const snap = await fb.getDoc(workspaceRef);
    const localState = getLocalState();
    const email = normalizeEmail(user.email);

    if (!snap.exists()) {
      if (!localState) throw new Error('LOCAL_STATE_MISSING');
      const now = fb.serverTimestamp();
      await fb.setDoc(workspaceRef, {
        name: 'INTENTRA SPACE CRM',
        ownerEmail: email,
        members: [email],
        state: localState,
        createdAt: now,
        updatedAt: now,
        updatedBy: user.displayName || email,
        updatedByEmail: email,
      });
      workspaceMeta = { ownerEmail: email, members: [email] };
      toast('Общая CRM создана. Вы стали владельцем рабочей области.');
      return;
    }

    const data = snap.data();
    const members = Array.isArray(data.members) ? data.members.map(normalizeEmail) : [];
    if (!members.includes(email)) {
      const error = new Error('NOT_A_MEMBER');
      error.ownerEmail = data.ownerEmail || '';
      throw error;
    }
    workspaceMeta = { ownerEmail: normalizeEmail(data.ownerEmail), members };

    const remoteState = data.state || null;
    if (remoteState) {
      const remoteFingerprint = fingerprint(remoteState);
      const localFingerprint = fingerprint(localState);
      lastFingerprint = remoteFingerprint;
      if (remoteFingerprint !== localFingerprint) {
        applyingRemote = true;
        localStorage.setItem(CRM_STORAGE_KEY, JSON.stringify(remoteState));
        window.setTimeout(() => window.location.reload(), 120);
        return;
      }
    }
  }

  function subscribeRealtime() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = fb.onSnapshot(workspaceRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      workspaceMeta = {
        ownerEmail: normalizeEmail(data.ownerEmail),
        members: Array.isArray(data.members) ? data.members.map(normalizeEmail) : [],
      };
      const remoteState = data.state || null;
      if (!remoteState) return;
      const remoteFingerprint = fingerprint(remoteState);
      if (remoteFingerprint === lastFingerprint) return;
      const localFingerprint = fingerprint(getLocalState());
      lastFingerprint = remoteFingerprint;
      if (remoteFingerprint !== localFingerprint) {
        applyingRemote = true;
        localStorage.setItem(CRM_STORAGE_KEY, JSON.stringify(remoteState));
        toast(`CRM обновлена: ${data.updatedBy || data.updatedByEmail || 'другой участник'}`);
        window.setTimeout(() => window.location.reload(), 250);
      }
    }, (error) => {
      console.warn('Realtime sync failed', error);
      setButton('Команда: ошибка', 'error', 'Нет доступа к общей CRM или ошибка Firestore');
    });
  }

  async function pushLocalState() {
    if (!user || !workspaceRef || applyingRemote || writing) return;
    const state = getLocalState();
    if (!state) return;
    const nextFingerprint = fingerprint(state);
    if (!nextFingerprint || nextFingerprint === lastFingerprint) return;

    writing = true;
    try {
      const email = normalizeEmail(user.email);
      const copy = JSON.parse(JSON.stringify(state));
      copy.lastEditedBy = user.displayName || email;
      copy.lastEditedByEmail = email;
      await fb.updateDoc(workspaceRef, {
        state: copy,
        updatedAt: fb.serverTimestamp(),
        updatedBy: user.displayName || email,
        updatedByEmail: email,
      });
      lastFingerprint = nextFingerprint;
      setButton(`Команда ✓ ${user.displayName?.split(' ')[0] || 'онлайн'}`, 'connected', `Вход: ${email}. Изменения синхронизируются автоматически.`);
    } catch (error) {
      console.warn('Team upload failed', error);
      setButton('Команда: ошибка', 'error', 'Не удалось сохранить изменения в общей CRM');
    } finally {
      writing = false;
    }
  }

  function startLocalWatcher() {
    if (localTimer) return;
    localTimer = window.setInterval(() => {
      if (applyingRemote) return;
      pushLocalState();
    }, LOCAL_SCAN_MS);
  }

  async function manageMembers() {
    const email = normalizeEmail(user?.email);
    if (!workspaceMeta || email !== workspaceMeta.ownerEmail) {
      const members = workspaceMeta?.members?.join(', ') || '';
      const logout = window.confirm(`Вы вошли как ${email}.\n\nУчастники CRM:\n${members}\n\nНажмите OK, чтобы выйти из командной CRM.`);
      if (logout) await logoutTeam();
      return;
    }

    const current = workspaceMeta.members.join(', ');
    const value = window.prompt(
      'Участники общей CRM.\n\nУкажите e-mail Google-аккаунтов через запятую. Ваш адрес владельца удалить нельзя:',
      current
    );
    if (value === null) return;
    const members = [...new Set(value.split(/[;,\n]+/).map(normalizeEmail).filter(Boolean))];
    if (!members.includes(email)) members.unshift(email);
    await fb.updateDoc(workspaceRef, {
      members,
      updatedAt: fb.serverTimestamp(),
      updatedBy: user.displayName || email,
      updatedByEmail: email,
    });
    workspaceMeta.members = members;
    toast(`Доступ обновлен. Участников: ${members.length}`);
  }

  async function logoutTeam() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = null;
    if (auth) await fb.signOut(auth);
    user = null;
    workspaceRef = null;
    workspaceMeta = null;
    lastFingerprint = '';
    localStorage.removeItem(FIREBASE_SESSION_KEY);
    setButton('Команда: войти', 'signed-out');
    toast('Вы вышли из общей CRM. Локальные данные на этом устройстве сохранены.');
  }

  async function connectTeam(interactive = true) {
    setButton('Команда: вход...', 'syncing');
    try {
      const ok = await signIn(interactive);
      if (!ok) return;
      setButton('Команда: синхронизация...', 'syncing');
      await ensureWorkspace();
      if (applyingRemote) return;
      lastFingerprint = fingerprint(getLocalState());
      subscribeRealtime();
      startLocalWatcher();
      setButton(`Команда ✓ ${user.displayName?.split(' ')[0] || 'онлайн'}`, 'connected', `Вход: ${normalizeEmail(user.email)}. Нажмите для управления командой.`);
      if (interactive) toast('Командная CRM подключена. Изменения будут видны всем участникам.');
    } catch (error) {
      console.warn('Team connect failed', error);
      if (error.message === 'NOT_A_MEMBER') {
        setButton('Команда: нет доступа', 'denied');
        toast(`Этот Google-аккаунт не приглашен в CRM. Попросите владельца ${error.ownerEmail || ''} добавить ваш e-mail.`);
      } else if (/auth\/unauthorized-domain/i.test(error.code || error.message || '')) {
        setButton('Команда: домен', 'error');
        toast('В Firebase Authentication добавьте ivankorytnik.github.io в Authorized domains.');
      } else {
        setButton('Команда: ошибка', 'error');
        toast('Не удалось подключить командную CRM. Проверьте Firebase Authentication, Firestore и правила доступа.');
      }
    }
  }

  async function handleTeamButton() {
    if (user && workspaceRef) {
      await manageMembers();
      return;
    }
    await connectTeam(true);
  }

  async function init() {
    const bootstrap = getBootstrap();
    setButton(validConfig(bootstrap.config) ? 'Команда: войти' : 'Команда: настроить', 'setup');
    if (!validConfig(bootstrap.config)) return;

    try {
      await initFirebase(bootstrap.config);
      fb.onAuthStateChanged(auth, async (currentUser) => {
        user = currentUser;
        if (user && localStorage.getItem(FIREBASE_SESSION_KEY) === '1') await connectTeam(false);
        else if (!user) setButton('Команда: войти', 'signed-out');
      });
    } catch (error) {
      console.warn('Firebase init failed', error);
      setButton('Команда: ошибка', 'error');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
