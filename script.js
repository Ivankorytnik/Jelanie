(() => {
  const path = window.location.pathname;
  const isProductionRoot = path === '/' || path === '/index.html' || path === '/Jelanie/' || path === '/Jelanie/index.html';

  const loadOriginalScript = () => {
    const script = document.createElement('script');
    const base = path.startsWith('/Jelanie/') ? '/Jelanie/' : '/';
    script.src = base + 'script-base.js?v=20260909';
    document.head.appendChild(script);
  };

  if (!isProductionRoot) {
    loadOriginalScript();
    return;
  }

  const renderProductionRelease = () => {
    const base = path.startsWith('/Jelanie/') ? '/Jelanie/' : '/';

    document.title = 'Желание сквозь Вселенную';
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.background = '#05070c';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = '#05070c';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';
    document.body.innerHTML = '';

    const loading = document.createElement('div');
    loading.textContent = 'Загрузка…';
    loading.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#05070c;color:#fff;font:16px system-ui;z-index:1';

    const frame = document.createElement('iframe');
    frame.src = base + 'release-20260909/';
    frame.title = 'Желание сквозь Вселенную';
    frame.setAttribute('aria-label', 'Желание сквозь Вселенную');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#05070c;opacity:0;transition:opacity .15s ease;z-index:2';

    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          doc.title = 'Желание сквозь Вселенную';
          doc.querySelector('.test-stand-badge')?.remove();
          doc.querySelectorAll('.test-inline-label').forEach((node) => node.remove());
          doc.querySelectorAll('link[rel~="icon"]').forEach((node) => {
            node.setAttribute('href', base + 'favicon.svg');
          });

          const cleanProductionText = () => {
            doc.querySelectorAll('.application-success p').forEach((node) => {
              if (node.textContent && node.textContent.includes('тестовом режиме')) {
                node.textContent = 'Контактные данные сохранены в этом браузере. Отправка в CRM или на корпоративную почту пока не подключена.';
              }
            });
          };
          cleanProductionText();
          new MutationObserver(cleanProductionText).observe(doc.body, {subtree:true, childList:true});
        }
      } catch (error) {
        console.warn('Не удалось применить production-оформление release-снимка', error);
      }
      loading.remove();
      frame.style.opacity = '1';
    });

    document.body.appendChild(loading);
    document.body.appendChild(frame);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderProductionRelease, {once:true});
  } else {
    renderProductionRelease();
  }
})();
