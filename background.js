import { LIMITS, MODEL_CONFIG, SHOPPING_MATCHES, STORAGE_KEYS } from './config.js';
import {
  CHOICES, RequestError, buildRequest, cacheDigest, normalizeProduct,
  parseChoice, parseRetryAfter, safeError,
} from './core.js';

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function createBackground({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = wait,
  limits = LIMITS,
} = {}) {
  const storage = chromeApi.storage.local;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  const controllers = new Set();
  let settings = { enabled: false, apiKey: '', provider: 'typesafe' };
  let status = { kind: 'idle', message: '请先保存 TypeSafe 官方 API Key。' };
  let active = 0;
  let revision = 0;
  let cooldownUntil = 0;
  let writeChain = Promise.resolve();
  let settingsChain = Promise.resolve();
  let connectionTest;

  const ready = (async () => {
    // Restrict storage before reading any key, including credentials from older versions.
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = await storage.get(Object.values(STORAGE_KEYS));
    const saved = stored[STORAGE_KEYS.settings];
    const official = saved?.provider === 'typesafe';
    if (official) {
      settings.apiKey = typeof saved.apiKey === 'string' ? saved.apiKey : '';
      settings.enabled = Boolean(settings.apiKey) && saved.enabled === true;
      if (settings.apiKey) status = {
        kind: 'idle', message: settings.enabled ? '已开启，等待视口中的商品。' : '已暂停，页面印章已移除。',
      };
      const savedStatus = stored[STORAGE_KEYS.status];
      if (savedStatus && ['idle', 'success', 'error'].includes(savedStatus.kind)
          && typeof savedStatus.message === 'string') status = savedStatus;
      if (!settings.apiKey) status = { kind: 'idle', message: '请先保存 TypeSafe 官方 API Key。' };
      if (Number.isFinite(stored[STORAGE_KEYS.cooldown])) cooldownUntil = stored[STORAGE_KEYS.cooldown];
      const entries = stored[STORAGE_KEYS.cache];
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        for (const [key, entry] of Object.entries(entries).slice(-limits.cacheEntries)) {
          if (/^[a-f\d]{64}$/.test(key) && CHOICES.includes(entry?.choice)
              && Number.isFinite(entry.expiresAt) && entry.expiresAt > now()) {
            cache.set(key, { choice: entry.choice, expiresAt: entry.expiresAt });
          }
        }
      }
    } else if (saved) {
      // Old local/OpenCode keys are never adopted by the official TypeSafe endpoint.
      await closeLegacyOffscreen();
      status = { kind: 'idle', message: '已切换 TypeSafe 官方直连，请填写官方 API Key 后开启。' };
    }
    await persist({
      [STORAGE_KEYS.settings]: settings,
      ...(!official ? {
        [STORAGE_KEYS.cache]: {},
        [STORAGE_KEYS.cooldown]: 0,
        [STORAGE_KEYS.status]: status,
      } : {}),
    });
    if (saved && !official) await broadcast({ reset: true });
  })();
  ready.catch(() => {});

  function getState() {
    return {
      ok: true,
      enabled: settings.enabled,
      configured: Boolean(settings.apiKey),
      status: { ...status },
      provider: 'typesafe',
      providerLabel: MODEL_CONFIG.provider,
      model: MODEL_CONFIG.model,
    };
  }

  function persist(value) {
    const task = writeChain.then(() => storage.set(value));
    writeChain = task.catch(() => {});
    return task;
  }

  async function setStatus(kind, message) {
    status = { kind, message };
    await persist({ [STORAGE_KEYS.status]: status }).catch(() => {});
  }

  async function closeLegacyOffscreen() {
    try {
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chromeApi.runtime.getURL('offscreen.html')],
      });
      if (contexts.length) await chromeApi.offscreen.closeDocument();
    } catch {
      throw new RequestError('LEGACY_CLEANUP_FAILED', '旧版本地模型未能关闭，请重新加载扩展后再试。');
    }
  }

  function shoppingUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port
        && ['www.jd.com', 'search.jd.com', 'list.jd.com', 's.taobao.com', 'www.taobao.com'].includes(url.hostname);
    } catch { return false; }
  }

  function senderRole(sender) {
    if (!sender || sender.id !== chromeApi.runtime.id) return null;
    if ((sender.frameId === undefined || sender.frameId === 0)
        && sender.url === chromeApi.runtime.getURL('popup.html')) return 'popup';
    if (sender.tab && sender.frameId === 0 && shoppingUrl(sender.url)
        && shoppingUrl(sender.tab.url)) return 'shopping';
    return null;
  }

  async function broadcast({ reset = false } = {}) {
    const state = getState();
    const message = {
      type: 'STATE_CHANGED', enabled: state.enabled, configured: state.configured,
      provider: state.provider, reset,
    };
    try {
      const tabs = await chromeApi.tabs.query({ url: [...SHOPPING_MATCHES] });
      await Promise.allSettled(tabs.map(tab => chromeApi.tabs.sendMessage(tab.id, message)));
    } catch { /* Closed tabs do not need a warning. */ }
    try {
      await chromeApi.runtime.sendMessage({ ...state, ...message, target: 'ui' });
    } catch { /* No popup is currently open. */ }
  }

  function cancelRequests() {
    revision += 1;
    const error = new RequestError('CANCELLED', '设置已更改，本次判断已取消。');
    for (const controller of controllers) controller.abort(error);
    for (const job of queue.splice(0)) {
      controllers.delete(job.controller);
      job.reject(error);
    }
    pending.clear();
    connectionTest = undefined;
  }

  function drain() {
    while (active < limits.concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return job.run(job.controller.signal);
      }).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        controllers.delete(job.controller);
        drain();
      });
    }
  }

  function enqueue(run) {
    if (queue.length >= limits.queue) {
      return Promise.reject(new RequestError('QUEUE_FULL', '当前待判断商品较多，请稍后再试。', 2_000));
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      controllers.add(controller);
      queue.push({ run, controller, resolve, reject });
      drain();
    });
  }

  async function fetchOnce(body, apiKey, signal) {
    const controller = new AbortController();
    const aborted = () => controller.abort(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    const timeout = setTimeout(() => controller.abort(
      new RequestError('TIMEOUT', '模型请求超时，本次不盖章。'),
    ), limits.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(MODEL_CONFIG.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      controller.signal.throwIfAborted();
      if ([429, 529].includes(response.status)) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now(), limits.retryBaseMs);
        throw new RequestError('RATE_LIMITED', '服务暂时限流，已暂停新增请求；稍后可重试。', retryAfterMs);
      }
      if ([401, 403].includes(response.status)) {
        throw new RequestError('AUTH_FAILED', 'API Key 无效或没有权限，请检查 TypeSafe 官方 Key。');
      }
      if ([402, 404, 410].includes(response.status)) {
        throw new RequestError('MODEL_UNAVAILABLE', '官方模型不可用或账户额度不足；未切换其他模型。');
      }
      if (!response.ok) throw new RequestError('HTTP_ERROR', '模型服务返回 HTTP ' + response.status + '，本次不盖章。');
      let result;
      try { result = await response.json(); }
      catch {
        controller.signal.throwIfAborted();
        throw new RequestError('INVALID_RESPONSE', '模型响应不是有效 JSON，本次不盖章。');
      }
      controller.signal.throwIfAborted();
      return parseChoice(result);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof RequestError) throw error;
      throw new RequestError('NETWORK_ERROR', '网络请求失败，请检查网络后重试。');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
    }
  }

  async function request(product, signal) {
    const apiKey = settings.apiKey;
    if (!apiKey) throw new RequestError('NOT_CONFIGURED', '请先保存 TypeSafe 官方 API Key。');
    if (cooldownUntil > now()) {
      throw new RequestError('RATE_LIMITED', '服务暂时限流，请稍后重试。', cooldownUntil - now());
    }
    const body = buildRequest(product);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      try { return await fetchOnce(body, apiKey, signal); }
      catch (error) {
        if (error.code !== 'RATE_LIMITED') throw error;
        cooldownUntil = Math.max(cooldownUntil, now() + error.retryAfterMs);
        await persist({ [STORAGE_KEYS.cooldown]: cooldownUntil }).catch(() => {});
        const delay = cooldownUntil - now();
        if (attempt === 1 || delay > limits.maxInlineRetryMs) throw error;
        await sleep(Math.max(0, delay), signal);
        signal.throwIfAborted();
        if (cooldownUntil > now()) {
          throw new RequestError('RATE_LIMITED', '服务暂时限流，请稍后重试。', cooldownUntil - now());
        }
      }
    }
  }

  async function classify(product) {
    if (!settings.enabled) throw new RequestError('DISABLED', '扩展已暂停。');
    if (!settings.apiKey) throw new RequestError('NOT_CONFIGURED', '请先保存 TypeSafe 官方 API Key。');
    const input = normalizeProduct(product);
    const startedRevision = revision;
    const key = await cacheDigest(input, MODEL_CONFIG);
    if (revision !== startedRevision || !settings.enabled) {
      throw new RequestError('CANCELLED', '设置已更改，本次判断已取消。');
    }
    const cached = cache.get(key);
    if (cached?.expiresAt > now()) return { ok: true, choice: cached.choice, cached: true };
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const promise = enqueue(async signal => {
      const choice = await request(input, signal);
      signal.throwIfAborted();
      if (!settings.enabled || revision !== startedRevision) {
        throw new RequestError('CANCELLED', '设置已更改，本次判断已取消。');
      }
      for (const [hash, entry] of cache) if (entry.expiresAt <= now()) cache.delete(hash);
      cache.set(key, { choice, expiresAt: now() + limits.cacheTtlMs });
      while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
      await persist({ [STORAGE_KEYS.cache]: Object.fromEntries(cache) }).catch(() => {});
      signal.throwIfAborted();
      await setStatus('success', '连接正常。只对 AI 猜测可能非双休的商品盖章。');
      signal.throwIfAborted();
      return { ok: true, choice, cached: false };
    });
    pending.set(key, promise);
    try { return await promise; }
    finally { if (pending.get(key) === promise) pending.delete(key); }
  }

  async function saveSettings(message) {
    if (Object.keys(message).some(name => !['type', 'apiKey', 'enabled'].includes(name))) {
      throw new RequestError('INVALID_SETTINGS', '仅支持设置 TypeSafe 官方 Key 和开关。');
    }
    const next = { ...settings };
    if ('apiKey' in message) {
      if (typeof message.apiKey !== 'string' || message.apiKey.length > 512
          || /[^\x20-\x7E]/.test(message.apiKey)) {
        throw new RequestError('INVALID_KEY', 'API Key 格式不正确，请重新粘贴。');
      }
      next.apiKey = message.apiKey.trim();
    }
    if ('enabled' in message) {
      if (typeof message.enabled !== 'boolean') throw new RequestError('INVALID_SETTINGS', '开关设置格式不正确。');
      next.enabled = message.enabled;
    }
    if (next.enabled && !next.apiKey) {
      if (message.enabled === true) throw new RequestError('NOT_CONFIGURED', '请先保存 TypeSafe 官方 API Key，再开启。');
      next.enabled = false;
    }
    await persist({ [STORAGE_KEYS.settings]: next });
    const keyChanged = next.apiKey !== settings.apiKey;
    const changed = keyChanged || next.enabled !== settings.enabled;
    if (changed) cancelRequests();
    settings = next;
    if (keyChanged) {
      cooldownUntil = 0;
      await persist({ [STORAGE_KEYS.cooldown]: 0 }).catch(() => {});
    }
    await setStatus('idle', !settings.apiKey ? '请先保存 TypeSafe 官方 API Key。'
      : settings.enabled ? '已开启，等待视口中的商品。' : '已暂停，页面印章已移除。');
    if (changed) await broadcast({ reset: keyChanged });
    return getState();
  }

  async function testConnection() {
    if (connectionTest) return connectionTest;
    const promise = enqueue(async signal => {
      await request({
        platform: 'jd', product_id: '', product_title: '虚构连接测试商品',
        shop_name: '虚构测试店铺，不对应真实企业', brand_name: '', shop_description: '',
      }, signal);
      signal.throwIfAborted();
      await setStatus('success', 'TypeSafe 官方 JEV 连接成功。测试使用虚构文字，未判断真实商家。');
      signal.throwIfAborted();
      return getState();
    });
    connectionTest = promise;
    try { return await promise; }
    finally { if (connectionTest === promise) connectionTest = undefined; }
  }

  async function handleMessage(message, sender) {
    const role = senderRole(sender);
    if (!role || !message || typeof message.type !== 'string') {
      return safeError(new RequestError('FORBIDDEN', '消息来源不受支持。'));
    }
    if (['SAVE_SETTINGS', 'TEST_CONNECTION'].includes(message.type) && role !== 'popup') {
      return safeError(new RequestError('FORBIDDEN', '此操作只能在扩展弹窗中执行。'));
    }
    if (message.type === 'CLASSIFY' && role !== 'shopping') {
      return safeError(new RequestError('FORBIDDEN', '只判断支持购物页面中的商品。'));
    }
    try {
      await ready;
      if (message.type === 'GET_STATE') return getState();
      if (message.type === 'SAVE_SETTINGS') {
        const task = settingsChain.then(() => saveSettings(message));
        settingsChain = task.catch(() => {});
        return await task;
      }
      if (message.type === 'TEST_CONNECTION') return await testConnection();
      if (message.type === 'CLASSIFY') return await classify(message.product);
      return safeError(new RequestError('UNKNOWN_MESSAGE', '不支持的操作。'));
    } catch (error) {
      const result = safeError(error);
      if (['TEST_CONNECTION', 'CLASSIFY'].includes(message.type)
          && !['CANCELLED', 'DISABLED', 'INVALID_PRODUCT'].includes(result.code)) {
        await setStatus('error', result.error);
      }
      return result;
    }
  }

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === 'ui' || message?.target === 'offscreen') return false;
    handleMessage(message, sender).then(sendResponse, () => sendResponse(safeError(null)));
    return true;
  });
  return { ready, handleMessage };
}

if (globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.storage?.local) createBackground();
