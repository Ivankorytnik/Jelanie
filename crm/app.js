(() => {
  'use strict';

  const seed = window.INTENTRA_CRM_SEED;
  if (!seed) throw new Error('CRM seed data is missing');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const STORAGE_KEY = 'intentraSpace.crm.route1_1.v3';
  const LEGACY_KEYS = ['intentra-space-crm', 'intentraSpaceCRM', 'intentra_crm_v1', 'jelanie_crm_data'];
  const CURRENT_SCHEMA = seed.schemaVersion;
  const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
  const STATUS_LABELS = {
    todo: 'Не начато',
    in_progress: 'В работе',
    waiting: 'Ожидаем',
    done: 'Выполнено',
    cancelled: 'Отменено',
  };
  const PRIORITY_LABELS = {
    critical: 'Критическая',
    high: 'Высокая',
    medium: 'Средняя',
    reserve: 'Резервная',
  };
  const ROUTE_LABELS = {
    A: 'A: РТ-64',
    B: 'B: аренда',
    AB: 'A / B',
    PROJECT: 'Проект / Gate',
    SELECTED: 'Выбранный маршрут',
  };
  const VIEW_META = {
    dashboard: ['Управление проектом', 'Панель менеджера'],
    tasks: ['План 14 дней', 'Задачи'],
    funnel: ['Движение ЛПР', 'Рабочая воронка'],
    contacts: ['Контактная карта', 'ЛПР по очереди'],
    materials: ['Готовые формулировки', 'Материалы'],
  };

  let currentView = 'dashboard';
  let currentMaterialTab = 'letters';
  let draggedContactId = null;
  let toastTimer = null;

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const parseLocalDate = (iso) => {
    if (!iso) return null;
    const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
  };

  const toISODate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const todayISO = () => toISODate(new Date());

  const addDays = (iso, amount) => {
    const date = parseLocalDate(iso) || new Date();
    date.setDate(date.getDate() + Number(amount || 0));
    return toISODate(date);
  };

  const diffDays = (fromIso, toIso) => {
    const from = parseLocalDate(fromIso);
    const to = parseLocalDate(toIso);
    if (!from || !to) return 0;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  };

  const formatDate = (iso, options = {}) => {
    const date = parseLocalDate(iso);
    if (!date) return 'Не указано';
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'short', year: options.year ? 'numeric' : undefined,
    }).format(date).replace('.', '');
  };

  const formatDateTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const nl2br = (value) => escapeHtml(value).replace(/\n/g, '<br>');

  const uid = (prefix) => {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const normaliseStatus = (status) => {
    const aliases = {
      completed: 'done', complete: 'done', finished: 'done', 'выполнено': 'done',
      active: 'in_progress', progress: 'in_progress', 'в работе': 'in_progress',
      waiting: 'waiting', 'ожидаем': 'waiting',
      cancelled: 'cancelled', canceled: 'cancelled', 'отменено': 'cancelled',
      new: 'todo', 'не начато': 'todo',
    };
    const value = String(status || 'todo').toLowerCase();
    return STATUS_LABELS[value] ? value : (aliases[value] || 'todo');
  };

  const normaliseStage = (stage) => {
    if (seed.stages.some((item) => item.id === stage)) return stage;
    const value = String(stage || '').toLowerCase();
    const match = seed.stages.find((item) => item.label.toLowerCase() === value || item.short.toLowerCase() === value);
    return match?.id || 'queued';
  };

  const createInitialState = () => {
    const startDate = seed.project.startDate;
    return {
      schemaVersion: CURRENT_SCHEMA,
      sourceVersion: seed.sourceVersion,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startDate,
      selectedRoute: null,
      contacts: clone(seed.contacts).map((contact) => ({ ...contact, history: contact.history || [], note: contact.note || '' })),
      tasks: clone(seed.tasks).map((task) => ({
        ...task,
        dueDate: addDays(startDate, task.planDay),
        createdAt: `${seed.sourceDate}T09:00:00.000Z`,
        completedAt: null,
        actualDate: null,
        actualResult: '',
        comment: '',
      })),
      meeting: {
        decisionMaker: seed.project.mainDecisionMaker,
        technicalOwner: '',
        date: '',
        time: '',
        place: '',
        participants: '',
        agenda: 'Цель пилота, технические параметры, ответственные, договорная схема и следующий платный этап.',
        confirmed: false,
      },
      letters: clone(seed.letters || []),
      scripts: clone(seed.scripts || []),
      brief: clone(seed.brief || []),
      letterStatus: {},
      activity: [],
    };
  };

  const findContactMatch = (items, seedContact) => items.find((item) =>
    item.id === seedContact.id
    || (item.email && seedContact.email && String(item.email).toLowerCase() === seedContact.email.toLowerCase())
    || String(item.name || '').toLowerCase() === seedContact.name.toLowerCase());

  const findTaskMatch = (items, seedTask) => items.find((item) =>
    item.id === seedTask.id
    || (Number(item.number) === seedTask.number && String(item.title || '').toLowerCase() === seedTask.title.toLowerCase()));

  const migrateState = (raw) => {
    const base = createInitialState();
    if (!raw || typeof raw !== 'object') return base;

    const incomingContacts = Array.isArray(raw.contacts) ? raw.contacts : [];
    const incomingTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const needsSeedMerge = Number(raw.schemaVersion || 0) < CURRENT_SCHEMA;

    let contacts;
    let tasks;

    if (needsSeedMerge) {
      contacts = base.contacts.map((seedContact) => {
        const old = findContactMatch(incomingContacts, seedContact);
        return old ? { ...seedContact, ...old, id: seedContact.id } : seedContact;
      });
      contacts.push(...incomingContacts.filter((old) => !base.contacts.some((item) => findContactMatch([old], item))));

      tasks = base.tasks.map((seedTask) => {
        const old = findTaskMatch(incomingTasks, seedTask);
        return old ? { ...seedTask, ...old, id: seedTask.id, planDay: seedTask.planDay } : seedTask;
      });
      tasks.push(...incomingTasks.filter((old) => !base.tasks.some((item) => findTaskMatch([old], item))));
    } else {
      contacts = incomingContacts.length ? incomingContacts : base.contacts;
      tasks = incomingTasks.length ? incomingTasks : base.tasks;
    }

    const startDate = raw.startDate || base.startDate;
    contacts = contacts.map((contact, index) => ({
      ...contact,
      id: contact.id || uid('contact'),
      order: Number(contact.order || index + 1),
      route: contact.route === 'B' ? 'B' : 'A',
      stage: normaliseStage(contact.stage),
      importance: PRIORITY_LABELS[contact.importance] ? contact.importance : 'medium',
      history: Array.isArray(contact.history) ? contact.history : [],
      note: contact.note || '',
    }));
    tasks = tasks.map((task, index) => ({
      ...task,
      id: task.id || uid('task'),
      number: Number(task.number || index + 1),
      status: normaliseStatus(task.status),
      importance: ['critical', 'high', 'medium'].includes(task.importance) ? task.importance : 'medium',
      dueDate: task.dueDate || (Number.isFinite(Number(task.planDay)) ? addDays(startDate, Number(task.planDay)) : todayISO()),
      createdAt: task.createdAt || new Date().toISOString(),
      actualResult: task.actualResult || task.result || '',
      comment: task.comment || '',
    }));

    return {
      ...base,
      ...raw,
      schemaVersion: CURRENT_SCHEMA,
      sourceVersion: seed.sourceVersion,
      startDate,
      selectedRoute: ['A', 'B'].includes(raw.selectedRoute) ? raw.selectedRoute : null,
      contacts,
      tasks,
      meeting: { ...base.meeting, ...(raw.meeting || {}) },
      letters: Array.isArray(raw.letters) ? raw.letters : base.letters,
      scripts: Array.isArray(raw.scripts) ? raw.scripts : base.scripts,
      brief: Array.isArray(raw.brief) ? raw.brief : base.brief,
      letterStatus: raw.letterStatus && typeof raw.letterStatus === 'object' ? raw.letterStatus : {},
      activity: Array.isArray(raw.activity) ? raw.activity : [],
      updatedAt: new Date().toISOString(),
    };
  };

  const loadState = () => {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (current) return migrateState(JSON.parse(current));
      for (const key of LEGACY_KEYS) {
        const legacy = localStorage.getItem(key);
        if (legacy) {
          const migrated = migrateState(JSON.parse(legacy));
          migrated.activity.unshift({ at: new Date().toISOString(), type: 'migration', text: 'Данные перенесены в маршрут 1.1' });
          return migrated;
        }
      }
    } catch (error) {
      console.warn('CRM state could not be loaded', error);
    }
    return createInitialState();
  };

  let state = loadState();

  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('CRM state could not be saved', error);
      showToast('Не удалось сохранить данные в браузере');
    }
  };

  const getContact = (id) => state.contacts.find((contact) => contact.id === id);
  const getTask = (id) => state.tasks.find((task) => task.id === id);
  const getStage = (id) => seed.stages.find((stage) => stage.id === id) || seed.stages[0];
  const routeLabel = (route) => ROUTE_LABELS[route] || route || 'Без маршрута';
  const statusLabel = (status) => STATUS_LABELS[status] || status;
  const priorityLabel = (priority) => PRIORITY_LABELS[priority] || priority;
  const isActiveTask = (task) => !TERMINAL_STATUSES.has(task.status);
  const isOverdue = (task) => isActiveTask(task) && task.dueDate && task.dueDate < todayISO();

  const taskCounterparty = (task) => {
    const contact = getContact(task.contactId);
    return contact?.shortName || contact?.name || task.counterparty || 'Без контакта';
  };

  const routeChip = (route) => `<span class="route-chip route-${escapeHtml(route)}">${escapeHtml(routeLabel(route))}</span>`;
  const statusBadge = (status) => `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
  const priorityBadge = (priority) => `<span class="priority-badge priority-${escapeHtml(priority)}">${escapeHtml(priorityLabel(priority))}</span>`;

  const relativeDueLabel = (dueDate) => {
    const delta = diffDays(todayISO(), dueDate);
    if (delta === 0) return 'Сегодня';
    if (delta === 1) return 'Завтра';
    if (delta === -1) return 'Просрочено на 1 день';
    if (delta < -1) return `Просрочено на ${Math.abs(delta)} дн.`;
    return `Через ${delta} дн.`;
  };

  const showToast = (message) => {
    const toast = $('#toast');
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  };

  const logActivity = (type, text, relatedId = '') => {
    state.activity.unshift({ at: new Date().toISOString(), type, text, relatedId });
    state.activity = state.activity.slice(0, 300);
  };

  const meetingComplete = () => {
    const meeting = state.meeting;
    return Boolean(
      state.selectedRoute
      && meeting.confirmed
      && meeting.decisionMaker?.trim()
      && meeting.technicalOwner?.trim()
      && meeting.date
      && meeting.time
      && meeting.place?.trim()
    );
  };

  const setView = (view) => {
    if (!VIEW_META[view]) return;
    currentView = view;
    $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === view));
    $$('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    const [eyebrow, title] = VIEW_META[view];
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const taskRowHtml = (task) => {
    const overdue = isOverdue(task);
    return `
      <article class="task-row">
        <div class="task-date ${overdue ? 'overdue' : ''}">
          <strong>${escapeHtml(formatDate(task.dueDate))}</strong>
          ${escapeHtml(relativeDueLabel(task.dueDate))}
        </div>
        <div class="task-main">
          <h3>${escapeHtml(task.title)}</h3>
          <p>${escapeHtml(taskCounterparty(task))}${task.criterion ? ` · Результат: ${escapeHtml(task.criterion)}` : ''}</p>
          <div class="task-tags">${routeChip(task.route)}${priorityBadge(task.importance)}${statusBadge(task.status)}</div>
        </div>
        <div class="task-actions">
          <button class="mini-button" type="button" data-edit-task="${escapeHtml(task.id)}">Изменить</button>
          ${isActiveTask(task) ? `<button class="mini-button complete" type="button" data-complete-task="${escapeHtml(task.id)}">Выполнено</button>` : `<button class="mini-button" type="button" data-next-task="${escapeHtml(task.id)}">+ Следующая</button>`}
        </div>
      </article>`;
  };

  const renderDashboard = () => {
    const tasks = state.tasks.filter((task) => task.status !== 'cancelled');
    const done = tasks.filter((task) => task.status === 'done');
    const active = tasks.filter(isActiveTask);
    const overdue = active.filter(isOverdue);
    const waiting = active.filter((task) => task.status === 'waiting' || task.status === 'in_progress');
    const progress = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
    const deadline = addDays(state.startDate, seed.project.horizonDays);
    const daysToDeadline = diffDays(todayISO(), deadline);
    const currentDay = diffDays(state.startDate, todayISO());
    const kpiDone = meetingComplete();
    const meeting = state.meeting;

    $('#kpi-hero').innerHTML = `
      <div class="kpi-copy">
        <div>
          <p class="eyebrow">Главный KPI спринта</p>
          <h2>${escapeHtml(seed.project.finalKpi)}</h2>
        </div>
        <div class="kpi-meta">
          <span>Старт <strong>${escapeHtml(formatDate(state.startDate, { year: true }))}</strong></span>
          <span>Дедлайн <strong>${escapeHtml(formatDate(deadline, { year: true }))}</strong></span>
          <span>${currentDay < 0 ? 'До старта' : `День ${currentDay}`} <strong>из 14</strong></span>
          <span>Прогресс <strong>${progress}%</strong></span>
        </div>
      </div>
      <div class="kpi-status-card">
        <div class="kpi-state ${kpiDone ? 'complete' : ''}">
          <span class="kpi-state-icon">${kpiDone ? '✓' : '○'}</span>
          <div><strong>${kpiDone ? 'KPI выполнен' : 'Встреча еще не подтверждена'}</strong><small>${kpiDone ? 'Дата, участники и технический ЛПР зафиксированы' : (daysToDeadline >= 0 ? `До дедлайна ${daysToDeadline} дн.` : `Дедлайн просрочен на ${Math.abs(daysToDeadline)} дн.`)}</small></div>
        </div>
        <div class="meeting-summary">
          <span>Маршрут: <b>${state.selectedRoute ? escapeHtml(routeLabel(state.selectedRoute)) : 'не выбран'}</b></span>
          <span>ЛПР: <b>${escapeHtml(meeting.decisionMaker || 'не указан')}</b></span>
          <span>Технический ответственный: <b>${escapeHtml(meeting.technicalOwner || 'не указан')}</b></span>
          <span>Встреча: <b>${meeting.date ? `${escapeHtml(formatDate(meeting.date, { year: true }))}, ${escapeHtml(meeting.time || '')}` : 'не назначена'}</b></span>
        </div>
        <button class="button ${kpiDone ? 'button-soft' : 'button-primary'}" type="button" data-edit-meeting>${kpiDone ? 'Изменить данные встречи' : 'Зафиксировать встречу'}</button>
      </div>
      ${state.contacts.length ? '' : '<div class="private-data-alert"><div><strong>Контакты ЛПР хранятся отдельно</strong><span>Импортируйте персональный JSON-файл один раз. После этого контакты, письма и история будут храниться только в этом браузере.</span></div><button class="button button-small button-primary" type="button" data-import-data>Импортировать данные</button></div>'}`;

    $('#metric-grid').innerHTML = [
      { label: 'Всего действий', value: tasks.length, note: 'Единый план без дублей' },
      { label: 'Завершено', value: done.length, note: `${progress}% плана`, cls: done.length ? 'good' : '' },
      { label: 'Активные', value: active.length, note: `${waiting.length} в работе / ожидаем` },
      { label: 'Просрочено', value: overdue.length, note: overdue.length ? 'Нужна реакция сегодня' : 'Просрочек нет', cls: overdue.length ? 'alert' : 'good' },
      { label: 'ЛПР в движении', value: state.contacts.filter((contact) => contact.stage !== 'queued' && contact.stage !== 'paused').length, note: `из ${state.contacts.length} контактов` },
    ].map((metric) => `<article class="metric-card ${metric.cls || ''}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><small>${escapeHtml(metric.note)}</small></article>`).join('');

    let priorityTasks = active.filter((task) => task.dueDate <= todayISO()).sort(sortTasks);
    const urgent = priorityTasks.length > 0;
    if (!priorityTasks.length) priorityTasks = active.sort(sortTasks).slice(0, 5);
    else priorityTasks = priorityTasks.slice(0, 6);
    $('#today-heading').textContent = urgent ? 'Просрочено и на сегодня' : 'Ближайшие действия';
    $('#today-tasks').innerHTML = priorityTasks.length
      ? priorityTasks.map(taskRowHtml).join('')
      : emptyState('Активных задач нет', 'Создайте следующий шаг, чтобы проект продолжал двигаться.');

    const gates = state.tasks.filter((task) => task.gate).sort((a, b) => a.planDay - b.planDay);
    $('#gate-list').innerHTML = gates.map((task, index) => `
      <article class="gate-card ${task.status === 'done' ? 'done' : ''}">
        <span class="gate-marker">${task.status === 'done' ? '✓' : index}</span>
        <div>
          <h3>${escapeHtml(task.gate)} · День ${escapeHtml(task.planDay)}</h3>
          <p>${escapeHtml(task.criterion)}</p>
          <div class="gate-foot"><span>${escapeHtml(formatDate(task.dueDate))}</span>${task.status === 'done' ? statusBadge('done') : `<button class="text-button" type="button" data-complete-task="${escapeHtml(task.id)}">Принять Gate →</button>`}</div>
        </div>
      </article>`).join('');

    $('#selected-route-label').textContent = state.selectedRoute ? `Выбран: ${routeLabel(state.selectedRoute)}` : 'Маршрут не выбран';
    $('#route-grid').innerHTML = seed.routes.map((route) => {
      const routeTasks = state.tasks.filter((task) => task.route === route.id || task.route === 'AB' || (task.route === 'SELECTED' && state.selectedRoute === route.id));
      const completed = routeTasks.filter((task) => task.status === 'done').length;
      const routeProgress = routeTasks.length ? Math.round((completed / routeTasks.length) * 100) : 0;
      const selected = state.selectedRoute === route.id;
      return `
        <article class="route-card ${selected ? 'selected' : ''}">
          <div class="route-head"><div><h3>${escapeHtml(route.label)}</h3><p>${escapeHtml(route.priority)} · Запуск ${escapeHtml(route.launch)}</p></div>${selected ? '<span class="status-badge status-done">Выбран</span>' : ''}</div>
          <div class="route-progress"><div class="progress-meta"><span>${completed} из ${routeTasks.length} действий</span><strong>${routeProgress}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${routeProgress}%"></div></div></div>
          <div class="route-facts">
            <div class="route-fact"><span>Первый контакт</span><strong>${escapeHtml(route.firstContact)}</strong></div>
            <div class="route-fact"><span>Gate</span><strong>${escapeHtml(route.gate)}</strong></div>
            <div class="route-fact"><span>Цель</span><strong>${escapeHtml(route.goal)}</strong></div>
            <div class="route-fact"><span>Результат</span><strong>${escapeHtml(route.result)}</strong></div>
          </div>
          <div class="route-actions"><button class="button ${selected ? 'button-soft' : 'button-small button-soft'}" type="button" data-select-route="${route.id}">${selected ? 'Основной маршрут выбран' : 'Выбрать по Gate 1'}</button></div>
        </article>`;
    }).join('');

    $('#manager-rules').innerHTML = seed.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
  };

  const sortTasks = (a, b) => {
    const statusRank = { in_progress: 0, waiting: 1, todo: 2, done: 3, cancelled: 4 };
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
      || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
      || Number(a.number || 999) - Number(b.number || 999);
  };

  const taskCardHtml = (task) => {
    const overdue = isOverdue(task);
    const done = task.status === 'done';
    return `
      <article class="task-card ${done ? 'done' : ''}">
        <div class="task-number ${task.gate ? 'gate' : ''}">${task.gate ? escapeHtml(task.gate.replace('Gate ', 'G')) : escapeHtml(task.number)}</div>
        <div>
          <h3 class="task-title">${escapeHtml(task.title)}</h3>
          <p class="task-subtitle">${escapeHtml(taskCounterparty(task))} · ${escapeHtml(task.channel || 'Канал не указан')}</p>
          <div class="task-tags">${routeChip(task.route)}${priorityBadge(task.importance)}${statusBadge(task.status)}</div>
        </div>
        <div class="task-detail"><strong>Критерий результата</strong>${escapeHtml(task.criterion || 'Не задан')}</div>
        <div class="task-deadline ${overdue ? 'overdue' : ''}"><span>${escapeHtml(relativeDueLabel(task.dueDate))}</span><strong>${escapeHtml(formatDate(task.dueDate))}</strong>${task.actualDate ? `<small>Факт: ${escapeHtml(formatDate(task.actualDate))}</small>` : ''}</div>
        <div class="task-card-actions">
          ${isActiveTask(task) ? `<button class="mini-button complete" type="button" data-complete-task="${escapeHtml(task.id)}" title="Закрыть задачу">✓</button>` : ''}
          <button class="mini-button" type="button" data-next-task="${escapeHtml(task.id)}" title="Создать следующий шаг">+ След.</button>
          <button class="mini-button" type="button" data-edit-task="${escapeHtml(task.id)}" title="Изменить">Изм.</button>
          <button class="mini-button" type="button" data-delete-task="${escapeHtml(task.id)}" title="Удалить">×</button>
        </div>
      </article>`;
  };

  const renderTasks = () => {
    const search = ($('#task-search')?.value || '').trim().toLowerCase();
    const status = $('#task-status-filter')?.value || 'active';
    const route = $('#task-route-filter')?.value || 'all';
    const priority = $('#task-priority-filter')?.value || 'all';
    const tasks = state.tasks.filter((task) => {
      const haystack = [task.title, task.action, task.goal, task.criterion, taskCounterparty(task), task.comment].join(' ').toLowerCase();
      const statusMatch = status === 'all' || (status === 'active' ? isActiveTask(task) : task.status === status);
      const routeMatch = route === 'all'
        || (route === 'PROJECT' ? ['PROJECT', 'SELECTED'].includes(task.route) : task.route === route || task.route === 'AB');
      return (!search || haystack.includes(search)) && statusMatch && routeMatch && (priority === 'all' || task.importance === priority);
    }).sort(sortTasks);
    $('#task-count-label').textContent = `${tasks.length} из ${state.tasks.length}`;
    $('#task-list').innerHTML = tasks.length ? tasks.map(taskCardHtml).join('') : emptyState('Задачи не найдены', 'Измените фильтры или создайте новую задачу.');
  };

  const contactActiveTasks = (contactId) => state.tasks.filter((task) => task.contactId === contactId && isActiveTask(task)).sort(sortTasks);

  const kanbanCardHtml = (contact) => {
    const activeTasks = contactActiveTasks(contact.id);
    const nextTask = activeTasks[0];
    const nextIndex = seed.stages.findIndex((stage) => stage.id === contact.stage);
    return `
      <article class="contact-kanban-card" draggable="true" data-contact-id="${escapeHtml(contact.id)}">
        <div class="kanban-card-top"><span class="order-badge">${escapeHtml(contact.order)}</span>${routeChip(contact.route)}</div>
        <h3 data-edit-contact="${escapeHtml(contact.id)}">${escapeHtml(contact.shortName || contact.name)}</h3>
        <p>${escapeHtml(contact.organization)}<br>${escapeHtml(contact.role)}</p>
        <div class="kanban-task-info ${nextTask && isOverdue(nextTask) ? 'overdue' : ''}">${nextTask ? `<strong>${escapeHtml(relativeDueLabel(nextTask.dueDate))}:</strong> ${escapeHtml(nextTask.title)}` : 'Нет активной задачи'}</div>
        <div class="stage-controls">
          <button type="button" data-shift-contact="${escapeHtml(contact.id)}" data-direction="-1" ${nextIndex <= 0 ? 'disabled' : ''} aria-label="Предыдущий этап">←</button>
          <select data-stage-contact="${escapeHtml(contact.id)}" aria-label="Этап контакта">${seed.stages.map((stage) => `<option value="${stage.id}" ${stage.id === contact.stage ? 'selected' : ''}>${escapeHtml(stage.short)}</option>`).join('')}</select>
          <button type="button" data-shift-contact="${escapeHtml(contact.id)}" data-direction="1" ${nextIndex >= seed.stages.length - 1 ? 'disabled' : ''} aria-label="Следующий этап">→</button>
        </div>
      </article>`;
  };

  const renderFunnel = () => {
    const search = ($('#funnel-search')?.value || '').trim().toLowerCase();
    const route = $('#funnel-route-filter')?.value || 'all';
    const contacts = state.contacts.filter((contact) => {
      const haystack = [contact.name, contact.organization, contact.role].join(' ').toLowerCase();
      return (!search || haystack.includes(search)) && (route === 'all' || contact.route === route);
    });
    $('#kanban').innerHTML = seed.stages.map((stage) => {
      const columnContacts = contacts.filter((contact) => contact.stage === stage.id).sort((a, b) => a.order - b.order);
      return `
        <section class="kanban-column" data-drop-stage="${stage.id}">
          <div class="column-head"><h2>${escapeHtml(stage.label)}</h2><span class="column-count">${columnContacts.length}</span></div>
          <div class="kanban-cards">${columnContacts.map(kanbanCardHtml).join('')}</div>
        </section>`;
    }).join('');
  };

  const phoneHref = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
    return digits ? `+${digits}` : '';
  };

  const contactCardHtml = (contact) => {
    const letter = state.letters.find((item) => item.contactId === contact.id);
    return `
      <article class="contact-card ${contact.isMainDecisionMaker ? 'main-lpr' : ''}">
        <div class="contact-order">${escapeHtml(contact.order)}</div>
        <div>
          <h3 class="contact-name">${escapeHtml(contact.name)}${contact.isMainDecisionMaker ? ' · Главный ЛПР' : ''}</h3>
          <p class="contact-org">${escapeHtml(contact.organization)} · ${escapeHtml(contact.position)}</p>
          <div class="task-tags">${routeChip(contact.route)}${priorityBadge(contact.importance)}<span class="status-badge status-${contact.stage === 'paused' ? 'cancelled' : 'in_progress'}">${escapeHtml(getStage(contact.stage).short)}</span></div>
        </div>
        <div class="contact-role"><strong>Роль в решении</strong>${escapeHtml(contact.role)}<br><br><strong>Цель</strong>${escapeHtml(contact.goal)}</div>
        <div class="contact-channels"><strong>Контакты</strong>${contact.phone ? `<a href="tel:${escapeHtml(phoneHref(contact.phone))}">${escapeHtml(contact.phone)}</a>` : '<span>Телефон не указан</span>'}${contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : '<span>E-mail не указан</span>'}</div>
        <div class="contact-actions">
          <button class="mini-button" type="button" data-contact-task="${escapeHtml(contact.id)}">+ Задача</button>
          ${letter ? `<button class="mini-button" type="button" data-copy-letter="${letter.id}">Письмо</button>` : ''}
          <button class="mini-button" type="button" data-edit-contact="${escapeHtml(contact.id)}">Карточка</button>
        </div>
      </article>`;
  };

  const renderContacts = () => {
    const search = ($('#contact-search')?.value || '').trim().toLowerCase();
    const route = $('#contact-route-filter')?.value || 'all';
    const importance = $('#contact-importance-filter')?.value || 'all';
    const contacts = state.contacts.filter((contact) => {
      const haystack = [contact.name, contact.organization, contact.position, contact.role, contact.goal, contact.email, contact.phone].join(' ').toLowerCase();
      return (!search || haystack.includes(search)) && (route === 'all' || contact.route === route) && (importance === 'all' || contact.importance === importance);
    }).sort((a, b) => a.order - b.order);
    $('#contact-count-label').textContent = `${contacts.length} из ${state.contacts.length}`;
    $('#contact-list').innerHTML = contacts.length ? contacts.map(contactCardHtml).join('') : emptyState('Контакты еще не загружены', 'Импортируйте персональный JSON-файл через меню или добавьте ЛПР вручную.');
  };

  const renderLetters = () => state.letters.length ? `
    <div class="letter-list">
      ${state.letters.map((letter) => {
        const sentAt = state.letterStatus[letter.id]?.sentAt;
        return `
          <details class="material-card">
            <summary>
              <span class="material-index">${String(letter.order).padStart(2, '0')}</span>
              <div><h3>${escapeHtml(letter.recipient)}</h3><p>${escapeHtml(letter.contact)}</p></div>
              <div class="material-subject">${escapeHtml(letter.subject)}</div>
              <span class="status-badge ${sentAt ? 'status-done' : 'status-todo'}">${sentAt ? 'Отправлено' : 'Не отправлено'}</span>
            </summary>
            <div class="material-body">
              <pre class="letter-text">${escapeHtml(letter.body)}</pre>
              <aside class="material-side">
                <div class="material-info"><span>Когда отправлять</span><p>${escapeHtml(letter.when)}</p></div>
                <div class="material-info"><span>Вложение</span><p>${escapeHtml(letter.attachment)}</p></div>
                ${sentAt ? `<div class="material-info"><span>Статус</span><p class="sent-state">Отправлено ${escapeHtml(formatDateTime(sentAt))}</p></div>` : ''}
                <div class="material-buttons">
                  <button class="button button-small button-primary" type="button" data-copy-letter="${letter.id}">Копировать письмо</button>
                  <button class="button button-small button-soft" type="button" data-copy-subject="${letter.id}">Копировать тему</button>
                  <button class="button button-small button-soft" type="button" data-toggle-letter-sent="${letter.id}">${sentAt ? 'Вернуть в неотправленные' : 'Отметить отправленным'}</button>
                </div>
              </aside>
            </div>
          </details>`;
      }).join('')}
    </div>` : `<section class="panel">${emptyState('Письма хранятся в персональном файле', 'Импортируйте JSON-файл CRM, чтобы загрузить адресатов, контакты и готовые тексты писем.')}</section>`;

  const renderScripts = () => `
    <div class="script-list">
      ${state.scripts.map((script, index) => `
        <article class="material-card script-grid">
          <div class="script-meta"><span class="material-index">${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(script.situation)}</h3><p>${escapeHtml(script.goal)}</p></div>
          <div><pre class="script-wording">${escapeHtml(script.wording)}</pre><button class="button button-small button-soft" type="button" data-copy-script="${index}">Копировать формулировку</button></div>
          <div class="script-notes"><div class="material-info"><span>Что учитывать</span><p>${escapeHtml(script.note)}</p></div><div class="material-info"><span>Обязательный следующий шаг</span><p>${escapeHtml(script.next)}</p></div></div>
        </article>`).join('')}
    </div>`;

  const renderBrief = () => `
    <section class="panel brief-panel">
      <div class="brief-intro"><p class="section-label">Единый вопросник для обоих маршрутов</p><h2>Технический бриф первого обсуждения</h2><p>Бриф для одного пилотного сеанса на действующей инфраструктуре. Частоту, мощность и режим определяет оператор после инженерной и радиочастотной оценки.</p></div>
      <div class="brief-table-wrap"><table class="brief-table"><thead><tr><th>Раздел</th><th>Параметр</th><th>Предварительное требование</th><th>Что подтвердить</th></tr></thead><tbody>${state.brief.map((row) => `<tr><td>${escapeHtml(row.section)}</td><td>${escapeHtml(row.parameter)}</td><td>${escapeHtml(row.requirement)}</td><td>${escapeHtml(row.confirm)}</td></tr>`).join('')}</tbody></table></div>
      <div class="brief-success"><strong>Успешный ответ партнера:</strong> партнер подтверждает доступность готовой передающей инфраструктуры, называет ответственного инженера, предлагает платный пилот и дает перечень данных, необходимых для расчета.</div>
    </section>`;

  const renderMaterials = () => {
    $$('[data-material-tab]').forEach((button) => button.classList.toggle('active', button.dataset.materialTab === currentMaterialTab));
    $('#letters-count').textContent = state.letters.length;
    const content = currentMaterialTab === 'letters' ? renderLetters() : currentMaterialTab === 'scripts' ? renderScripts() : renderBrief();
    $('#materials-content').innerHTML = content;
  };

  const emptyState = (title, text) => `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div></div>`;

  const renderAll = () => {
    renderDashboard();
    renderTasks();
    renderFunnel();
    renderContacts();
    renderMaterials();
  };

  const closeDialog = (dialog) => {
    if (dialog?.open) dialog.close();
  };

  const openDialog = (dialog) => {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  };

  const updateTaskContactOptions = (selected = '') => {
    $('#task-contact-select').innerHTML = `<option value="">Без одного ЛПР / группа</option>${state.contacts.slice().sort((a, b) => a.order - b.order).map((contact) => `<option value="${escapeHtml(contact.id)}" ${contact.id === selected ? 'selected' : ''}>${escapeHtml(contact.order)}. ${escapeHtml(contact.name)}</option>`).join('')}`;
  };

  const stageOptions = (selected = '', includeNoChange = false) => `${includeNoChange ? '<option value="">Не менять этап</option>' : ''}${seed.stages.map((stage) => `<option value="${stage.id}" ${stage.id === selected ? 'selected' : ''}>${escapeHtml(stage.label)}</option>`).join('')}`;

  const setFormValue = (form, name, value) => {
    const field = form.elements.namedItem(name);
    if (!field) return;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  };

  const openTaskModal = ({ taskId = '', contactId = '', parentTaskId = '' } = {}) => {
    const form = $('#task-form');
    form.reset();
    const task = taskId ? getTask(taskId) : null;
    const parent = parentTaskId ? getTask(parentTaskId) : null;
    const selectedContact = task?.contactId || contactId || parent?.contactId || '';
    updateTaskContactOptions(selectedContact);
    $('#task-modal-title').textContent = task ? 'Изменить задачу' : (parent ? 'Следующий шаг' : 'Новая задача');

    const values = task || {
      id: '',
      parentTaskId: parent?.id || '',
      title: '',
      contactId: selectedContact,
      counterparty: parent?.counterparty || (selectedContact ? getContact(selectedContact)?.shortName : ''),
      dueDate: addDays(todayISO(), parent ? 2 : 0),
      route: parent?.route || getContact(selectedContact)?.route || 'A',
      importance: parent?.importance || 'high',
      status: 'todo',
      channel: parent?.channel || getContact(selectedContact)?.channel || '',
      action: '', goal: '', criterion: '', nextStep: '', comment: '',
    };
    ['id', 'parentTaskId', 'title', 'contactId', 'counterparty', 'dueDate', 'route', 'importance', 'status', 'channel', 'action', 'goal', 'criterion', 'nextStep', 'comment'].forEach((name) => setFormValue(form, name, values[name]));
    openDialog($('#task-modal'));
    window.setTimeout(() => form.elements.namedItem('title')?.focus(), 60);
  };

  const openCompleteModal = (taskId) => {
    const task = getTask(taskId);
    if (!task || !isActiveTask(task)) return;
    const form = $('#complete-form');
    form.reset();
    setFormValue(form, 'taskId', task.id);
    setFormValue(form, 'actualDate', todayISO());
    const contact = getContact(task.contactId);
    const currentIndex = contact ? seed.stages.findIndex((stage) => stage.id === contact.stage) : -1;
    const suggestedStage = currentIndex >= 0 && currentIndex < seed.stages.length - 2 ? seed.stages[currentIndex + 1].id : '';
    $('#complete-stage-select').innerHTML = stageOptions(suggestedStage, true);
    $('#complete-stage-select').disabled = !contact;
    openDialog($('#complete-modal'));
  };

  const renderContactHistory = (contact) => {
    const block = $('#contact-history-block');
    if (!contact || !contact.history?.length) {
      block.hidden = true;
      block.innerHTML = '';
      return;
    }
    block.hidden = false;
    block.innerHTML = `<h3>История движения по этапам</h3><div class="history-list">${contact.history.slice().reverse().slice(0, 12).map((item) => `<div class="history-item"><span>${escapeHtml(getStage(item.from).label)} → ${escapeHtml(getStage(item.to).label)}${item.reason ? ` · ${escapeHtml(item.reason)}` : ''}</span><time>${escapeHtml(formatDateTime(item.at))}</time></div>`).join('')}</div>`;
  };

  const openContactModal = (contactId = '') => {
    const form = $('#contact-form');
    form.reset();
    const contact = contactId ? getContact(contactId) : null;
    $('#contact-modal-title').textContent = contact ? 'Карточка ЛПР' : 'Новый ЛПР';
    $('#contact-stage-select').innerHTML = stageOptions(contact?.stage || 'queued');
    const values = contact || {
      id: '', name: '', organization: '', position: '', role: '', route: 'A', importance: 'medium', stage: 'queued',
      order: Math.max(0, ...state.contacts.map((item) => Number(item.order) || 0)) + 1,
      phone: '', email: '', channel: '', whyNow: '', goal: '', expected: '', condition: '', note: '',
    };
    ['id', 'name', 'organization', 'position', 'role', 'route', 'importance', 'stage', 'order', 'phone', 'email', 'channel', 'whyNow', 'goal', 'expected', 'condition', 'note'].forEach((name) => setFormValue(form, name, values[name]));
    renderContactHistory(contact);
    openDialog($('#contact-modal'));
  };

  const openMeetingModal = () => {
    const form = $('#meeting-form');
    form.reset();
    Object.entries(state.meeting).forEach(([name, value]) => setFormValue(form, name, value));
    openDialog($('#meeting-modal'));
  };

  const openSettingsModal = () => {
    const form = $('#settings-form');
    setFormValue(form, 'startDate', state.startDate);
    openDialog($('#settings-modal'));
  };

  const setContactStage = (contactId, newStage, { reason = 'Изменено вручную', silent = false } = {}) => {
    const contact = getContact(contactId);
    if (!contact || !seed.stages.some((stage) => stage.id === newStage) || contact.stage === newStage) return false;
    const from = contact.stage;
    contact.stage = newStage;
    contact.history = Array.isArray(contact.history) ? contact.history : [];
    contact.history.push({ from, to: newStage, at: new Date().toISOString(), reason });
    logActivity('stage', `${contact.name}: ${getStage(from).label} → ${getStage(newStage).label}`, contact.id);
    if (!silent) {
      saveState();
      renderAll();
      showToast(`${contact.shortName || contact.name}: ${getStage(newStage).label}`);
    }
    return true;
  };

  const selectRoute = (routeId) => {
    if (!['A', 'B'].includes(routeId)) return;
    state.selectedRoute = routeId;
    logActivity('route', `Выбран маршрут ${routeLabel(routeId)}`, routeId);
    saveState();
    renderAll();
    showToast(`Основной маршрут: ${routeLabel(routeId)}`);
  };

  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      showToast('Скопировано');
    } catch (error) {
      console.warn('Copy failed', error);
      showToast('Не удалось скопировать');
    }
  };

  const exportData = () => {
    const payload = { ...state, exportedAt: new Date().toISOString(), product: 'INTENTRA SPACE CRM' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `INTENTRA_SPACE_CRM_backup_${todayISO()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Резервная копия скачана');
  };

  const handleImport = async (file) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.contacts) || !Array.isArray(parsed.tasks)) throw new Error('Invalid CRM structure');
      state = migrateState(parsed);
      logActivity('import', `Импортирована резервная копия ${file.name}`);
      saveState();
      renderAll();
      showToast('Данные восстановлены');
    } catch (error) {
      console.warn('Import failed', error);
      showToast('Файл не похож на резервную копию CRM');
    } finally {
      $('#import-file').value = '';
    }
  };

  const deleteTask = (taskId) => {
    const task = getTask(taskId);
    if (!task) return;
    if (!window.confirm(`Удалить задачу «${task.title}»? Историю удаления восстановить нельзя без резервной копии.`)) return;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    logActivity('task_delete', `Удалена задача: ${task.title}`, taskId);
    saveState();
    renderAll();
    showToast('Задача удалена');
  };

  $('#task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const existing = data.id ? getTask(data.id) : null;
    const task = {
      ...(existing || {}),
      id: existing?.id || uid('task'),
      number: existing?.number || Math.max(0, ...state.tasks.map((item) => Number(item.number) || 0)) + 1,
      parentTaskId: data.parentTaskId || existing?.parentTaskId || '',
      planDay: existing?.planDay ?? null,
      gate: existing?.gate || '',
      title: data.title.trim(),
      contactId: data.contactId || '',
      counterparty: data.counterparty.trim(),
      dueDate: data.dueDate,
      route: data.route,
      importance: data.importance,
      status: normaliseStatus(data.status),
      channel: data.channel.trim(),
      action: data.action.trim() || data.title.trim(),
      goal: data.goal.trim(),
      criterion: data.criterion.trim(),
      nextStep: data.nextStep.trim(),
      comment: data.comment.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      completedAt: data.status === 'done' ? (existing?.completedAt || new Date().toISOString()) : null,
      actualDate: data.status === 'done' ? (existing?.actualDate || todayISO()) : existing?.actualDate || null,
      actualResult: existing?.actualResult || '',
    };
    if (existing) Object.assign(existing, task);
    else state.tasks.push(task);
    logActivity(existing ? 'task_edit' : 'task_create', `${existing ? 'Изменена' : 'Создана'} задача: ${task.title}`, task.id);
    saveState();
    closeDialog($('#task-modal'));
    renderAll();
    showToast(existing ? 'Задача обновлена' : 'Задача создана');
  });

  $('#complete-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const task = getTask(data.taskId);
    if (!task) return;
    task.status = 'done';
    task.actualDate = data.actualDate;
    task.actualResult = data.actualResult.trim();
    task.completedAt = new Date().toISOString();
    if (data.nextStage && task.contactId) setContactStage(task.contactId, data.nextStage, { reason: `Завершена задача: ${task.title}`, silent: true });
    logActivity('task_complete', `Выполнена задача: ${task.title}`, task.id);
    saveState();
    closeDialog($('#complete-modal'));
    renderAll();
    showToast('Задача закрыта и перенесена в историю');
    if (data.createNext === 'on') window.setTimeout(() => openTaskModal({ parentTaskId: task.id }), 80);
  });

  $('#contact-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const existing = data.id ? getContact(data.id) : null;
    const previousStage = existing?.stage;
    const contact = {
      ...(existing || {}),
      id: existing?.id || uid('contact'),
      order: Number(data.order) || state.contacts.length + 1,
      name: data.name.trim(),
      shortName: existing?.shortName || data.name.trim().split(/\s+/).slice(0, 2).reverse().join(' '),
      organization: data.organization.trim(),
      position: data.position.trim(),
      role: data.role.trim(),
      route: data.route,
      importance: data.importance,
      stage: data.stage,
      phone: data.phone.trim(),
      email: data.email.trim(),
      channel: data.channel.trim(),
      whyNow: data.whyNow.trim(),
      goal: data.goal.trim(),
      expected: data.expected.trim(),
      condition: data.condition.trim(),
      note: data.note.trim(),
      sources: existing?.sources || [],
      history: existing?.history || [],
    };
    if (existing) {
      Object.assign(existing, contact);
      if (previousStage !== contact.stage) {
        existing.history.push({ from: previousStage, to: contact.stage, at: new Date().toISOString(), reason: 'Изменено в карточке' });
      }
    } else state.contacts.push(contact);
    logActivity(existing ? 'contact_edit' : 'contact_create', `${existing ? 'Изменен' : 'Создан'} контакт: ${contact.name}`, contact.id);
    saveState();
    closeDialog($('#contact-modal'));
    renderAll();
    showToast(existing ? 'Карточка ЛПР обновлена' : 'ЛПР добавлен');
  });

  $('#meeting-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.meeting = {
      decisionMaker: String(formData.get('decisionMaker') || '').trim(),
      technicalOwner: String(formData.get('technicalOwner') || '').trim(),
      date: String(formData.get('date') || ''),
      time: String(formData.get('time') || ''),
      place: String(formData.get('place') || '').trim(),
      participants: String(formData.get('participants') || '').trim(),
      agenda: String(formData.get('agenda') || '').trim(),
      confirmed: formData.get('confirmed') === 'on',
    };
    if (state.meeting.confirmed) {
      const mainContact = state.contacts.find((contact) => contact.isMainDecisionMaker);
      const targetIndex = seed.stages.findIndex((stage) => stage.id === 'meeting_scheduled');
      const currentIndex = mainContact ? seed.stages.findIndex((stage) => stage.id === mainContact.stage) : -1;
      if (mainContact && currentIndex >= 0 && currentIndex < targetIndex) setContactStage(mainContact.id, 'meeting_scheduled', { reason: 'Встреча подтверждена', silent: true });
    }
    logActivity('meeting', state.meeting.confirmed ? 'Встреча подтверждена' : 'Данные встречи обновлены');
    saveState();
    closeDialog($('#meeting-modal'));
    renderAll();
    showToast(meetingComplete() ? 'Финальный KPI выполнен' : 'Данные встречи сохранены');
  });

  $('#settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const oldStart = state.startDate;
    state.startDate = data.startDate;
    state.tasks.forEach((task) => {
      if (Number.isFinite(Number(task.planDay)) && task.planDay !== null && isActiveTask(task)) task.dueDate = addDays(state.startDate, Number(task.planDay));
    });
    logActivity('replan', `Дата старта изменена: ${oldStart} → ${state.startDate}`);
    saveState();
    closeDialog($('#settings-modal'));
    renderAll();
    showToast('Сроки незавершенных задач пересчитаны');
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    const viewButton = target.closest('[data-view]');
    if (viewButton) setView(viewButton.dataset.view);

    const jumpButton = target.closest('[data-view-jump]');
    if (jumpButton) setView(jumpButton.dataset.viewJump);

    if (target.closest('[data-new-task]')) openTaskModal();
    if (target.closest('[data-import-data]')) $('#import-file').click();
    if (target.closest('#new-contact')) openContactModal();
    if (target.closest('[data-edit-meeting]')) openMeetingModal();
    if (target.closest('#open-settings') || target.closest('#menu-settings')) {
      $('#action-menu').hidden = true;
      openSettingsModal();
    }

    const editTask = target.closest('[data-edit-task]');
    if (editTask) openTaskModal({ taskId: editTask.dataset.editTask });
    const completeTask = target.closest('[data-complete-task]');
    if (completeTask) openCompleteModal(completeTask.dataset.completeTask);
    const nextTask = target.closest('[data-next-task]');
    if (nextTask) openTaskModal({ parentTaskId: nextTask.dataset.nextTask });
    const deleteTaskButton = target.closest('[data-delete-task]');
    if (deleteTaskButton) deleteTask(deleteTaskButton.dataset.deleteTask);

    const editContact = target.closest('[data-edit-contact]');
    if (editContact) openContactModal(editContact.dataset.editContact);
    const contactTask = target.closest('[data-contact-task]');
    if (contactTask) openTaskModal({ contactId: contactTask.dataset.contactTask });

    const shift = target.closest('[data-shift-contact]');
    if (shift && !shift.disabled) {
      const contact = getContact(shift.dataset.shiftContact);
      const index = seed.stages.findIndex((stage) => stage.id === contact?.stage);
      const newIndex = index + Number(shift.dataset.direction);
      if (contact && seed.stages[newIndex]) setContactStage(contact.id, seed.stages[newIndex].id, { reason: 'Сдвиг стрелкой' });
    }

    const routeButton = target.closest('[data-select-route]');
    if (routeButton) selectRoute(routeButton.dataset.selectRoute);

    const materialTab = target.closest('[data-material-tab]');
    if (materialTab) {
      currentMaterialTab = materialTab.dataset.materialTab;
      renderMaterials();
    }

    const copyLetterButton = target.closest('[data-copy-letter]');
    if (copyLetterButton) {
      const letter = state.letters.find((item) => item.id === copyLetterButton.dataset.copyLetter);
      if (letter) copyText(`Тема: ${letter.subject}\n\n${letter.body}`);
    }
    const copySubjectButton = target.closest('[data-copy-subject]');
    if (copySubjectButton) {
      const letter = state.letters.find((item) => item.id === copySubjectButton.dataset.copySubject);
      if (letter) copyText(letter.subject);
    }
    const copyScriptButton = target.closest('[data-copy-script]');
    if (copyScriptButton) {
      const script = state.scripts[Number(copyScriptButton.dataset.copyScript)];
      if (script) copyText(script.wording);
    }
    const sentButton = target.closest('[data-toggle-letter-sent]');
    if (sentButton) {
      const id = sentButton.dataset.toggleLetterSent;
      if (state.letterStatus[id]?.sentAt) delete state.letterStatus[id];
      else state.letterStatus[id] = { sentAt: new Date().toISOString() };
      saveState();
      renderMaterials();
      showToast(state.letterStatus[id] ? 'Письмо отмечено отправленным' : 'Письмо возвращено в неотправленные');
    }

    const close = target.closest('[data-close-modal]');
    if (close) closeDialog(close.closest('dialog'));
  });

  document.addEventListener('change', (event) => {
    const stageSelect = event.target.closest('[data-stage-contact]');
    if (stageSelect) setContactStage(stageSelect.dataset.stageContact, stageSelect.value, { reason: 'Выбрано в воронке' });
  });

  ['task-search', 'task-status-filter', 'task-route-filter', 'task-priority-filter'].forEach((id) => {
    $(`#${id}`).addEventListener(id.includes('search') ? 'input' : 'change', renderTasks);
  });
  ['funnel-search', 'funnel-route-filter'].forEach((id) => {
    $(`#${id}`).addEventListener(id.includes('search') ? 'input' : 'change', renderFunnel);
  });
  ['contact-search', 'contact-route-filter', 'contact-importance-filter'].forEach((id) => {
    $(`#${id}`).addEventListener(id.includes('search') ? 'input' : 'change', renderContacts);
  });

  $('#kanban').addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-contact-id]');
    if (!card) return;
    draggedContactId = card.dataset.contactId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedContactId);
  });
  $('#kanban').addEventListener('dragend', (event) => {
    event.target.closest('[data-contact-id]')?.classList.remove('dragging');
    $$('.kanban-column.drag-over').forEach((column) => column.classList.remove('drag-over'));
    draggedContactId = null;
  });
  $('#kanban').addEventListener('dragover', (event) => {
    const column = event.target.closest('[data-drop-stage]');
    if (!column) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    $$('.kanban-column.drag-over').forEach((item) => item !== column && item.classList.remove('drag-over'));
    column.classList.add('drag-over');
  });
  $('#kanban').addEventListener('dragleave', (event) => {
    const column = event.target.closest('[data-drop-stage]');
    if (column && !column.contains(event.relatedTarget)) column.classList.remove('drag-over');
  });
  $('#kanban').addEventListener('drop', (event) => {
    const column = event.target.closest('[data-drop-stage]');
    if (!column) return;
    event.preventDefault();
    const contactId = draggedContactId || event.dataTransfer.getData('text/plain');
    column.classList.remove('drag-over');
    if (contactId) setContactStage(contactId, column.dataset.dropStage, { reason: 'Перетаскивание в воронке' });
  });

  $('#menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#action-menu');
    menu.hidden = !menu.hidden;
    $('#menu-button').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.topbar-actions')) {
      $('#action-menu').hidden = true;
      $('#menu-button').setAttribute('aria-expanded', 'false');
    }
  });
  $('#export-data').addEventListener('click', () => { $('#action-menu').hidden = true; exportData(); });
  $('#import-data').addEventListener('click', () => { $('#action-menu').hidden = true; $('#import-file').click(); });
  $('#import-file').addEventListener('change', (event) => handleImport(event.target.files?.[0]));
  $('#reset-data').addEventListener('click', () => {
    $('#action-menu').hidden = true;
    if (!window.confirm('Сбросить CRM к исходному маршруту 1.1? Текущие задачи, статусы и история будут удалены. Сначала можно скачать экспорт JSON.')) return;
    state = createInitialState();
    saveState();
    renderAll();
    showToast('CRM возвращена к маршруту 1.1');
  });

  $$('dialog.modal').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  });

  saveState();
  renderAll();
  setView(currentView);
})();
