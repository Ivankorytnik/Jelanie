(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const header = $('.site-header');
  const navToggle = $('.nav-toggle');
  const mainNav = $('.main-nav');
  const modal = $('#signal-modal');
  const form = $('#signal-form');
  const giftMode = $('#gift-mode');
  const giftField = $('.gift-field');
  const messageField = $('#participant-message');
  const messageCount = $('#message-count');
  const consent = $('#consent');
  const startEegButton = $('#start-eeg');
  const generateButton = $('#generate-signal');
  const eegCanvas = $('#eeg-canvas');
  const eegStatus = $('#eeg-status');
  const eegStatusDot = $('.eeg-status-dot');
  const eegTimer = $('#eeg-timer');
  const toast = $('#toast');

  let currentStep = 1;
  let eegComplete = false;
  let eegRunning = false;
  let eegAnimationFrame = null;
  let currentSignal = null;
  let toastTimer = null;

  const packageNames = {
    signal: 'SIGNAL',
    personal: 'PERSONAL',
    deep: 'DEEP SPACE'
  };

  const scrollState = () => {
    if (window.scrollY > 20) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
  };

  window.addEventListener('scroll', scrollState, { passive: true });
  scrollState();

  if (navToggle && mainNav) {
    navToggle.addEventListener('click', () => {
      const open = !mainNav.classList.contains('active');
      mainNav.classList.toggle('active', open);
      navToggle.classList.toggle('active', open);
      navToggle.setAttribute('aria-expanded', String(open));
    });

    $$('.main-nav a').forEach((link) => {
      link.addEventListener('click', () => {
        mainNav.classList.remove('active');
        navToggle.classList.remove('active');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 })
    : null;

  $$('.reveal').forEach((element) => {
    if (revealObserver) revealObserver.observe(element);
    else element.classList.add('visible');
  });

  const showToast = (message) => {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  };

  const setStep = (step) => {
    currentStep = step;
    $$('.builder-step', form).forEach((panel) => {
      panel.classList.toggle('active', Number(panel.dataset.step) === step);
    });
    $$('[data-progress]').forEach((point) => {
      point.classList.toggle('active', Number(point.dataset.progress) <= step);
    });
    const builder = $('.builder');
    if (builder) builder.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openModal = ({ gift = false, packageValue = null } = {}) => {
    if (!modal) return;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    if (giftMode) {
      giftMode.checked = gift;
      updateGiftField();
    }

    if (packageValue) selectPackage(packageValue);
    setTimeout(() => $('#participant-name')?.focus(), 120);
  };

  const closeModal = () => {
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  };

  $$('.js-open-builder').forEach((button) => {
    button.addEventListener('click', () => {
      openModal({ gift: button.dataset.gift === 'true' });
    });
  });

  $$('.js-package').forEach((button) => {
    button.addEventListener('click', () => {
      openModal({ packageValue: button.dataset.package });
      setStep(2);
    });
  });

  $$('[data-close-modal]').forEach((element) => element.addEventListener('click', closeModal));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal?.classList.contains('active')) closeModal();
  });

  const updateGiftField = () => {
    if (!giftMode || !giftField) return;
    giftField.hidden = !giftMode.checked;
    const recipient = $('#recipient-name');
    if (recipient) recipient.required = giftMode.checked;
  };

  giftMode?.addEventListener('change', updateGiftField);

  messageField?.addEventListener('input', () => {
    if (messageCount) messageCount.textContent = String(messageField.value.length);
  });

  const setFieldError = (input, message = '') => {
    const field = input.closest('.field');
    if (!field) return;
    field.classList.toggle('invalid', Boolean(message));
    const error = $('.field-error', field);
    if (error) error.textContent = message;
  };

  const validateStepOne = () => {
    const name = $('#participant-name');
    const email = $('#participant-email');
    const message = $('#participant-message');
    const recipient = $('#recipient-name');
    let valid = true;

    if (!name.value.trim()) {
      setFieldError(name, 'Укажите имя или псевдоним');
      valid = false;
    } else setFieldError(name);

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email.value.trim())) {
      setFieldError(email, 'Проверьте адрес электронной почты');
      valid = false;
    } else setFieldError(email);

    if (message.value.trim().length < 3) {
      setFieldError(message, 'Добавьте послание длиной не менее 3 символов');
      valid = false;
    } else setFieldError(message);

    if (giftMode.checked && !recipient.value.trim()) {
      setFieldError(recipient, 'Укажите имя получателя');
      valid = false;
    } else setFieldError(recipient);

    if (!valid) showToast('Заполните обязательные поля');
    return valid;
  };

  $$('[data-next]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = Number(button.dataset.next);
      if (currentStep === 1 && !validateStepOne()) return;
      setStep(next);
      if (next === 3) drawIdleWave();
    });
  });

  $$('[data-prev]').forEach((button) => {
    button.addEventListener('click', () => setStep(Number(button.dataset.prev)));
  });

  const selectPackage = (value) => {
    const radio = $(`input[name="package"][value="${value}"]`, form);
    if (!radio) return;
    radio.checked = true;
    $$('.builder-packages label', form).forEach((label) => label.classList.remove('selected'));
    radio.closest('label')?.classList.add('selected');
  };

  $$('.target-card', form).forEach((card) => {
    card.addEventListener('click', () => {
      $$('.target-card', form).forEach((item) => item.classList.remove('selected'));
      card.classList.add('selected');
      const input = $('input', card);
      if (input) input.checked = true;
    });
  });

  $$('.builder-packages label', form).forEach((card) => {
    card.addEventListener('click', () => {
      $$('.builder-packages label', form).forEach((item) => item.classList.remove('selected'));
      card.classList.add('selected');
      const input = $('input', card);
      if (input) input.checked = true;
    });
  });

  const getCanvasContext = () => {
    if (!eegCanvas) return null;
    const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const rect = eegCanvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width * ratio));
    const height = Math.max(160, Math.round(rect.height * ratio));
    if (eegCanvas.width !== width || eegCanvas.height !== height) {
      eegCanvas.width = width;
      eegCanvas.height = height;
    }
    const context = eegCanvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height };
  };

  const drawWave = (phase = 0, intensity = 0.25) => {
    const drawing = getCanvasContext();
    if (!drawing) return;
    const { context, width, height } = drawing;
    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(84, 176, 255, 0.1)');
    gradient.addColorStop(0.5, 'rgba(104, 231, 255, 0.95)');
    gradient.addColorStop(1, 'rgba(126, 109, 255, 0.2)');

    context.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const base = Math.sin((x * 0.055) + phase) * 8;
      const beta = Math.sin((x * 0.145) + phase * 1.7) * 4;
      const micro = Math.sin((x * 0.42) + phase * 2.3) * 2;
      const pulseWindow = Math.pow(Math.abs(Math.sin((x * 0.018) + phase * 0.5)), 8);
      const spike = Math.sin((x * 0.31) + phase * 2.8) * 24 * pulseWindow;
      const y = (height / 2) + (base + beta + micro + spike) * intensity;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = gradient;
    context.lineWidth = 1.55;
    context.shadowColor = 'rgba(104, 231, 255, 0.55)';
    context.shadowBlur = 9;
    context.stroke();
    context.shadowBlur = 0;
  };

  const drawIdleWave = () => drawWave(0.5, 0.32);
  window.addEventListener('resize', () => {
    if (currentStep === 3 && !eegRunning) drawIdleWave();
  });

  const setMetrics = (progress = 0) => {
    const ease = Math.min(1, progress * 1.2);
    $('#metric-alpha').textContent = (2.4 + Math.random() * 2.2 * ease).toFixed(2);
    $('#metric-beta').textContent = (1.8 + Math.random() * 2.6 * ease).toFixed(2);
    $('#metric-theta').textContent = (2.1 + Math.random() * 1.9 * ease).toFixed(2);
    $('#metric-focus').textContent = `${Math.round(42 + Math.random() * 45 * ease)}%`;
  };

  const updateGenerateState = () => {
    if (generateButton) generateButton.disabled = !(eegComplete && consent?.checked);
  };

  consent?.addEventListener('change', updateGenerateState);

  startEegButton?.addEventListener('click', () => {
    if (eegRunning) return;
    eegRunning = true;
    eegComplete = false;
    updateGenerateState();
    startEegButton.disabled = true;
    startEegButton.textContent = 'EEG-демо выполняется';
    eegStatus.textContent = 'Запись EEG-отпечатка';
    eegStatusDot.classList.add('active');

    const duration = 8000;
    const startedAt = performance.now();

    const animate = (now) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / duration);
      const seconds = Math.max(0, Math.ceil((duration - elapsed) / 1000));
      eegTimer.textContent = `00:${String(seconds).padStart(2, '0')}`;
      drawWave(elapsed / 250, 0.55 + progress * 0.65);
      setMetrics(progress);

      if (progress < 1) {
        eegAnimationFrame = requestAnimationFrame(animate);
      } else {
        eegRunning = false;
        eegComplete = true;
        startEegButton.disabled = false;
        startEegButton.textContent = 'Записать EEG повторно';
        eegStatus.textContent = 'EEG-отпечаток готов';
        eegTimer.textContent = 'ГОТОВО';
        updateGenerateState();
        showToast('Демонстрационный EEG-отпечаток сформирован');
      }
    };

    if (eegAnimationFrame) cancelAnimationFrame(eegAnimationFrame);
    eegAnimationFrame = requestAnimationFrame(animate);
  });

  const randomHex = (length) => {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length).toUpperCase();
  };

  const createUniverseId = () => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replaceAll('-', '');
    return `UNV-${date}-${randomHex(8)}`;
  };

  const sha256 = async (value) => {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const collectSignal = async () => {
    const now = new Date();
    const name = $('#participant-name').value.trim();
    const recipient = $('#recipient-name').value.trim();
    const target = $('input[name="target"]:checked', form)?.value || 'HD 20794';
    const packageValue = $('input[name="package"]:checked', form)?.value || 'personal';
    const universeId = createUniverseId();

    const signal = {
      universeId,
      status: 'PREPARED',
      protocol: 'Universe 1.0 MVP',
      createdAt: now.toISOString(),
      participant: {
        name,
        email: $('#participant-email').value.trim(),
        gift: giftMode.checked,
        recipient: giftMode.checked ? recipient : null
      },
      message: $('#participant-message').value.trim(),
      target,
      package: packageValue,
      eeg: {
        mode: 'demonstration',
        durationSeconds: 8,
        alpha: $('#metric-alpha').textContent,
        beta: $('#metric-beta').textContent,
        theta: $('#metric-theta').textContent,
        focus: $('#metric-focus').textContent
      },
      transmission: {
        status: 'not_scheduled',
        plannedAntennaClass: 'RT-64',
        operator: 'to_be_confirmed'
      }
    };

    signal.sha256 = await sha256(JSON.stringify(signal));
    return signal;
  };

  const renderResult = (signal) => {
    $('#result-id').textContent = signal.universeId;
    $('#result-target').textContent = signal.target;
    $('#result-package').textContent = packageNames[signal.package] || signal.package;
    $('#result-hash').textContent = signal.sha256;

    const certificateName = signal.participant.gift && signal.participant.recipient
      ? signal.participant.recipient
      : signal.participant.name;
    $('#certificate-person').textContent = certificateName.toUpperCase();
    $('#certificate-id').textContent = signal.universeId;
    $('#certificate-target').textContent = signal.target;
    $('#certificate-hash').textContent = signal.sha256;
  };

  generateButton?.addEventListener('click', async () => {
    if (!eegComplete || !consent.checked) return;
    generateButton.disabled = true;
    generateButton.textContent = 'Формирование...';

    try {
      currentSignal = await collectSignal();
      const saved = JSON.parse(localStorage.getItem('universeSignals') || '[]');
      saved.unshift(currentSignal);
      localStorage.setItem('universeSignals', JSON.stringify(saved.slice(0, 20)));
      renderResult(currentSignal);
      setStep(4);
      showToast('Сигнал сохранен в этом браузере');
    } catch (error) {
      console.error(error);
      showToast('Не удалось сформировать сигнал. Попробуйте еще раз');
    } finally {
      generateButton.textContent = 'Сформировать сигнал';
      updateGenerateState();
    }
  });

  $('#download-signal')?.addEventListener('click', () => {
    if (!currentSignal) return;
    const blob = new Blob([JSON.stringify(currentSignal, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${currentSignal.universeId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Файл сигнала скачан');
  });

  const resetBuilder = () => {
    form.reset();
    updateGiftField();
    messageCount.textContent = '0';
    eegComplete = false;
    eegRunning = false;
    if (eegAnimationFrame) cancelAnimationFrame(eegAnimationFrame);
    startEegButton.disabled = false;
    startEegButton.textContent = 'Начать EEG-демо';
    eegStatus.textContent = 'Готово к записи';
    eegStatusDot.classList.remove('active');
    eegTimer.textContent = '00:08';
    ['#metric-alpha', '#metric-beta', '#metric-theta'].forEach((selector) => $(selector).textContent = '0.00');
    $('#metric-focus').textContent = '0%';
    $$('.field').forEach((field) => field.classList.remove('invalid'));
    $$('.field-error').forEach((error) => error.textContent = '');
    $$('.target-card').forEach((card, index) => card.classList.toggle('selected', index === 0));
    selectPackage('personal');
    currentSignal = null;
    setStep(1);
  };

  $('#create-another')?.addEventListener('click', resetBuilder);

  form?.addEventListener('submit', (event) => event.preventDefault());
  drawIdleWave();
})();
