(() => {
  'use strict';
  const WS = globalThis.WeekendShopping;
  if (!WS) return;

  WS.createController = ({
    root = document, adapter, classify, getState = async () => ({ enabled: true, configured: true }),
    subscribeState, onDiagnostics, demo = false, dwellMs = 250, maxConcurrent = 3
  }) => {
    const doc = root.ownerDocument || root;
    const win = doc.defaultView;
    const records = new Map();
    const observedRecords = new Map();
    const queue = [];
    const pendingScopes = new Set();
    const limit = Math.max(1, Math.min(3, maxConcurrent));
    let enabled = false, configured = false, destroyed = false, active = 0;
    let provider = '';
    let scanTimer = null, generation = 0, unsubscribe = null;
    let diagnosticTimer = null, stateLoaded = false, connectionError = false;

    function getDiagnostics() {
      const counts = { detected: records.size, checked: 0, pass: 0, weekend: 0, failed: 0, running: 0 };
      let missingTitle = 0;
      for (const record of records.values()) {
        if (record.visible && !record.product) missingTitle++;
        if (record.status === 'done') {
          counts.checked++;
          counts[record.choice === 'no_weekend' ? 'pass' : record.choice]++;
        }
        if (record.status === 'error') counts.failed++;
        if (record.status === 'running') counts.running++;
      }
      let message = `已识别 ${counts.detected} 件 · 已判断 ${counts.checked} 件 · 盖章 ${counts.pass} 件 · 不盖章 ${counts.weekend} 件`;
      if (connectionError) message = '扩展连接已断开，请刷新商城页面。';
      else if (!stateLoaded) message = '正在连接扩展…';
      else if (!configured) message = '尚未配置 Key：点浏览器中的「双休购物」填写并测试连接。';
      else if (!enabled) message = '已暂停：点浏览器中的「双休购物」，开启顶部开关。';
      else if (!counts.detected) message = '已开启，尚未识别到商品列表。请滚动到推荐商品，或进入搜索结果页。';
      else if (counts.failed) message += ` · 失败 ${counts.failed} 件：打开插件查看连接错误，修复后刷新页面。`;
      else if (counts.running) message += ` · 正在判断 ${counts.running} 件`;
      else if (missingTitle) message += ` · ${missingTitle} 件可见商品未读到标题，等待页面加载或适配更新`;
      else if (!counts.checked) message += ' · 等待商品进入可见区域';
      return { ...counts, enabled, configured, message };
    }

    function reportDiagnostics() {
      if (!onDiagnostics || destroyed || diagnosticTimer) return;
      diagnosticTimer = setTimeout(() => {
        diagnosticTimer = null;
        onDiagnostics(getDiagnostics());
      }, 100);
    }

    const enabledState = () => !destroyed && enabled && configured;
    const operational = () => enabledState() && !doc.hidden;
    const capacity = () => provider === 'local' ? 1 : limit;
    const inViewport = element => {
      if (!element.isConnected) return false;
      if (element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < win.innerHeight && rect.left < win.innerWidth;
    };

    function removeStamp(record) {
      record.stamp?.remove();
      record.stamp = null;
      record.host?.removeAttribute('data-dw-stamp-host');
      record.host = null;
    }

    function reset(record) {
      clearTimeout(record.timer);
      record.timer = null;
      record.ready = false;
      record.status = 'idle';
      record.choice = null;
      record.version += 1;
      removeStamp(record);
    }

    function refresh(record) {
      observeRecord(record);
      const product = adapter.extract(record.element);
      const key = product ? WS.fingerprint(product) + (adapter.identity?.(record.element) || '') : '';
      if (key !== record.key) {
        reset(record);
        record.product = product;
        record.key = key;
      } else if (operational() && record.status === 'done' && record.choice === 'no_weekend') {
        // Lazy-image/carousel rerenders can replace only the image subtree.
        stamp(record);
      }
      return !!product;
    }

    function stamp(record) {
      const host = adapter.imageHost(record.element);
      if (record.stamp?.isConnected && record.stamp.parentElement === host) return;
      removeStamp(record);
      if (!host) return;
      const overlay = doc.createElement('span');
      overlay.className = 'dw-stamp-overlay';
      overlay.setAttribute('data-dw-owned', '');
      const label = doc.createElement('span');
      label.className = 'dw-stamp';
      label.textContent = 'PASS';
      overlay.append(label);
      if (demo) {
        const note = doc.createElement('span');
        note.className = 'dw-stamp-note';
        note.textContent = '模拟结果 · 非 AI 判断';
        overlay.append(note);
      }
      if (win.getComputedStyle(host).position === 'static') {
        host.setAttribute('data-dw-stamp-host', '');
        record.host = host;
      }
      host.append(overlay);
      record.stamp = overlay;
    }

    function schedule(record) {
      if (!operational() || !record.visible || !record.key || record.status !== 'idle' || record.timer || record.ready) return;
      record.timer = setTimeout(() => {
        record.timer = null;
        if (!operational() || !record.visible || !inViewport(record.observedElement)) return;
        const before = record.key;
        refresh(record);
        if (before !== record.key) { schedule(record); return; }
        if (!record.key) return;
        record.ready = true;
        pump();
      }, dwellMs);
    }

    function fillQueue() {
      for (const record of records.values()) {
        if (queue.length >= capacity()) break;
        if (record.visible && record.ready && record.status === 'idle' && record.key) {
          record.status = 'queued';
          queue.push(record);
        }
      }
    }

    function pump() {
      reportDiagnostics();
      if (!operational()) return;
      fillQueue();
      while (active < capacity()) {
        fillQueue();
        if (!queue.length) break;
        const record = queue.shift();
        // Re-read identity and visibility immediately before any API request.
        if (record.status !== 'queued') continue;
        if (!record.visible || !inViewport(record.observedElement)) {
          record.status = 'idle';
          record.ready = false;
          continue;
        }
        const before = record.key;
        if (!refresh(record) || before !== record.key) {
          schedule(record);
          continue;
        }
        const key = record.key, version = record.version, epoch = generation;
        const input = { ...record.product };
        record.status = 'running';
        active += 1;
        let request;
        try { request = classify(input); }
        catch (error) { request = Promise.reject(error); }
        Promise.resolve(request)
          .then(result => {
            if (!enabledState() || epoch !== generation || record.version !== version || !record.element.isConnected) return;
            if (!doc.hidden) {
              refresh(record);
              if (record.key !== key || record.version !== version) {
                schedule(record);
                return;
              }
            }
            // Fail closed. Errors and unexpected responses stay unmarked and are not auto-retried.
            record.status = result?.ok && ['no_weekend', 'weekend'].includes(result.choice) ? 'done' : 'error';
            record.choice = record.status === 'done' ? result.choice : null;
            if (operational() && result?.ok && result.choice === 'no_weekend') stamp(record);
          })
          .catch(() => {
            if (record.version === version && epoch === generation) {
              record.status = 'error';
              connectionError = true;
            }
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    }

    function observeRecord(record) {
      const target = adapter.visibilityTarget?.(record.element) || record.element;
      if (record.observedElement === target) return;
      if (record.observedElement) {
        intersection.unobserve(record.observedElement);
        observedRecords.delete(record.observedElement);
      }
      record.observedElement = target;
      record.visible = false;
      observedRecords.set(target, record);
      intersection.observe(target);
    }

    const intersection = new win.IntersectionObserver(entries => {
      for (const entry of entries) {
        const record = observedRecords.get(entry.target);
        if (!record) continue;
        record.visible = entry.isIntersecting && entry.intersectionRatio > 0;
        if (record.visible && operational()) {
          refresh(record);
          schedule(record);
        } else {
          clearTimeout(record.timer);
          record.timer = null;
          record.ready = false;
          if (record.status === 'queued') record.status = 'idle';
        }
      }
      pump();
    }, { threshold: 0.01 });

    function scan(scope = root) {
      // Paused/hidden pages neither extract card text nor measure its layout.
      if (!operational()) return;
      if (scope === root) {
        for (const [element, record] of records) {
          if (!element.isConnected || (root !== doc && !root.contains(element))) {
            reset(record);
            intersection.unobserve(record.observedElement);
            observedRecords.delete(record.observedElement);
            records.delete(element);
          }
        }
      }
      for (const element of adapter.findCards(scope)) {
        let record = records.get(element);
        if (!record) {
          record = { element, key: '', product: null, version: 0, visible: false, ready: false, status: 'idle', timer: null, stamp: null, host: null };
          records.set(element, record);
          observeRecord(record);
        } else if (record.visible) {
          refresh(record);
          schedule(record);
        }
      }
      pump();
    }

    const ownNode = node => node?.nodeType === 1 && (node.hasAttribute('data-dw-owned') || !!node.closest('[data-dw-owned]'));
    const mutations = new win.MutationObserver(changes => {
      if (!operational()) return;
      const affected = new Set();
      const removed = new Set();
      const cardsIn = node => node?.nodeType === 1 && !ownNode(node) ? adapter.findCards(node) : [];
      for (const change of changes) {
        if (ownNode(change.target.nodeType === 1 ? change.target : change.target.parentElement)) continue;
        if (change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].every(ownNode)) continue;
        // Coalesce several changed fields of the same card; never rescan unrelated banners/countdowns.
        for (let node = change.target.nodeType === 1 ? change.target : change.target.parentElement; node; node = node.parentElement) {
          const record = records.get(node);
          if (record) {
            affected.add(record);
            break;
          }
        }
        if (change.type === 'childList') {
          for (const node of change.addedNodes) {
            if (cardsIn(node).length) pendingScopes.add(node);
          }
          for (const node of change.removedNodes) {
            for (const card of cardsIn(node)) {
              const record = records.get(card);
              if (record && !card.isConnected) removed.add(record);
            }
          }
        } else if (change.type === 'attributes' &&
          ['class', 'style', 'hidden', 'href', 'data-sku', 'data-nid', 'data-item-id', 'data-product-id'].includes(change.attributeName)) {
          // Visibility can change without an IO threshold; lazy cards can acquire their identity after insertion.
          for (const card of cardsIn(change.target)) {
            const record = records.get(card);
            if (record) affected.add(record);
            else pendingScopes.add(card);
          }
        }
      }
      for (const record of removed) {
        reset(record);
        intersection.unobserve(record.observedElement);
        observedRecords.delete(record.observedElement);
        records.delete(record.element);
        affected.delete(record);
      }
      // Changed offscreen cards lose stale marks immediately, without reading layout/text.
      for (const record of affected) {
        const wasVisible = record.visible;
        observeRecord(record);
        if (record.visible || wasVisible) { refresh(record); schedule(record); }
        else reset(record);
      }
      if (pendingScopes.size && !scanTimer) scanTimer = setTimeout(() => {
        scanTimer = null;
        const scopes = [...pendingScopes];
        pendingScopes.clear();
        for (const scope of scopes) if (scope.isConnected) scan(scope);
      }, 60);
    });
    mutations.observe(root.documentElement || root, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['href', 'data-sku', 'data-nid', 'data-item-id', 'data-product-id', 'title', 'aria-label', 'class', 'style', 'hidden']
    });

    function setState(state) {
      if (destroyed || !state) return;
      stateLoaded = true;
      reportDiagnostics();
      const nextEnabled = state.enabled === true, nextConfigured = state.configured === true;
      const nextProvider = typeof state.provider === 'string' ? state.provider : provider;
      if (enabled === nextEnabled && configured === nextConfigured && provider === nextProvider && state.reset !== true) return;
      enabled = nextEnabled;
      configured = nextConfigured;
      provider = nextProvider;
      connectionError = false;
      generation += 1;
      queue.length = 0;
      pendingScopes.clear();
      clearTimeout(scanTimer);
      scanTimer = null;
      for (const record of records.values()) {
        reset(record);
      }
      if (operational()) scan();
    }

    function visibilityChanged() {
      queue.length = 0;
      for (const record of records.values()) {
        clearTimeout(record.timer);
        record.timer = null;
        record.ready = false;
        if (record.status === 'queued') record.status = 'idle';
      }
      // A full discovery on return also picks up structure that changed while hidden.
      if (operational()) scan();
    }
    doc.addEventListener('visibilitychange', visibilityChanged);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearTimeout(scanTimer);
      clearTimeout(diagnosticTimer);
      intersection.disconnect();
      mutations.disconnect();
      doc.removeEventListener('visibilitychange', visibilityChanged);
      unsubscribe?.();
      queue.length = 0;
      pendingScopes.clear();
      for (const record of records.values()) reset(record);
      records.clear();
      observedRecords.clear();
    }

    if (subscribeState) unsubscribe = subscribeState(setState);
    scan();
    const initialGeneration = generation;
    Promise.resolve().then(getState).then(state => {
      if (generation === initialGeneration) setState(state);
    }).catch(() => {
      if (generation === initialGeneration) {
        setState({ enabled: false, configured: false });
        connectionError = true;
      }
    });
    return { setState, destroy, scan, getDiagnostics };
  };

  const adapter = WS.detectAdapter(globalThis.location?.hostname);
  if (globalThis.location?.protocol !== 'https:' || !adapter || !globalThis.chrome?.runtime?.id) return;
  const send = message => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
  WS.controller?.destroy();
  document.querySelector('#dw-page-status')?.remove();
  const pageStatus = document.createElement('aside');
  pageStatus.id = 'dw-page-status';
  pageStatus.setAttribute('data-dw-owned', '');
  pageStatus.setAttribute('aria-label', '双休购物运行状态');
  pageStatus.textContent = '双休购物 · 正在连接扩展…';
  document.documentElement.append(pageStatus);
  WS.controller = WS.createController({
    adapter,
    onDiagnostics: state => { pageStatus.textContent = `双休购物 · ${state.message}`; },
    classify: product => send({ type: 'CLASSIFY', product }),
    getState: () => send({ type: 'GET_STATE' }),
    subscribeState: listener => {
      const onMessage = (message, sender, respond) => {
        if (sender.id !== chrome.runtime.id) return;
        if (message?.type === 'STATE_CHANGED') listener(message);
        if (message?.type === 'GET_PAGE_STATUS') respond(WS.controller.getDiagnostics());
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => chrome.runtime.onMessage.removeListener(onMessage);
    }
  });
})();
