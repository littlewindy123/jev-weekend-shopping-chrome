import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBackground } from '../background.js';
import { LIMITS, MODEL_CONFIG, SHOPPING_MATCHES, STORAGE_KEYS } from '../config.js';

const KEY = 'unit-test-placeholder-key';
const popup = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };
const setup = { id: 'extension-test', url: 'chrome-extension://extension-test/setup.html', frameId: 0 };
const offscreen = { id: 'extension-test', url: 'chrome-extension://extension-test/offscreen.html' };
const shopping = {
  id: 'extension-test', frameId: 0, url: 'https://search.jd.com/Search?keyword=demo',
  tab: { id: 1, url: 'https://search.jd.com/Search?keyword=demo' },
};
const product = {
  platform: 'jd', product_id: '123', product_title: '虚构测试商品',
  shop_name: '虚构店铺', brand_name: '', shop_description: '',
};
const answer = (choice = 'weekend') => new Response(JSON.stringify({
  answers: { workweek: { type: 'choice', choice } },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Condition did not become true');
}

function harness({
  enabled = true, key = KEY, provider = 'typesafe', initial = {}, fetchImpl = async () => answer(),
  offscreenExists = false, ...options
} = {}) {
  const store = { [STORAGE_KEYS.settings]: { enabled, apiKey: key, provider }, ...initial };
  const calls = [];
  const events = [];
  const broadcasts = [];
  const uiMessages = [];
  const engine = { exists: offscreenExists, calls: [], created: 0, closed: 0 };
  const chromeApi = {
    runtime: {
      id: 'extension-test', getURL: path => 'chrome-extension://extension-test/' + path,
      onMessage: { addListener: listener => { chromeApi.listener = listener; } },
      getContexts: async () => {
        events.push(['contexts']);
        return engine.exists ? [{ documentUrl: offscreen.url }] : [];
      },
      sendMessage: async message => {
        if (message.target === 'ui') { uiMessages.push(message); return; }
        engine.calls.push(message);
        assert.fail('Official-only background must not send local runtime commands');
      },
    },
    storage: {
      local: {
        setAccessLevel: async value => { events.push(['access', value]); },
        get: async () => { events.push(['read']); return structuredClone(store); },
        set: async value => {
          if (STORAGE_KEYS.settings in value) events.push(['writeSettings']);
          Object.assign(store, structuredClone(value));
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (id, message) => { broadcasts.push({ id, message }); },
    },
    offscreen: {
      createDocument: async () => { engine.created += 1; assert.fail('No local engine may be created'); },
      closeDocument: async () => { events.push(['close']); engine.exists = false; engine.closed += 1; },
    },
  };
  const app = createBackground({
    chromeApi,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); },
    ...options,
  });
  const send = (message, sender = shopping) => app.handleMessage(message, sender);
  return { app, store, calls, events, broadcasts, uiMessages, engine, chromeApi, send };
}

test('storage is restricted before loading keys and public state never returns them', async () => {
  const h = harness();
  const state = await h.send({ type: 'GET_STATE' });
  assert.deepEqual(h.events.slice(0, 2), [['access', { accessLevel: 'TRUSTED_CONTEXTS' }], ['read']]);
  assert.equal(state.enabled, true);
  assert.equal(state.configured, true);
  assert.equal(state.model, MODEL_CONFIG.model);
  assert.equal(JSON.stringify(state).includes(KEY), false);
  const result = await h.send({ type: 'SAVE_SETTINGS', apiKey: 'other' });
  assert.equal(result.code, 'FORBIDDEN');
  assert.equal(h.store[STORAGE_KEYS.settings].apiKey, KEY);
});

test('new installs remain off, cannot turn on without a key, and only popup can test', async () => {
  const h = harness({ enabled: false, key: '' });
  assert.equal((await h.send({ type: 'GET_STATE' })).enabled, false);
  assert.equal((await h.send({ type: 'SAVE_SETTINGS', enabled: true }, popup)).code, 'NOT_CONFIGURED');
  assert.equal((await h.send({ type: 'TEST_CONNECTION' }, shopping)).code, 'FORBIDDEN');
  assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).code, 'NOT_CONFIGURED');
  assert.equal(h.calls.length, 0);
  const saved = await h.send({ type: 'SAVE_SETTINGS', apiKey: KEY }, popup);
  assert.equal(saved.configured, true);
  assert.equal(saved.enabled, false);
  assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0][1].body).state.shop_name.includes('虚构'), true);
});

test('messages require extension identity, supported https shopping tab, and top frame', async () => {
  const h = harness();
  for (const sender of [
    { ...shopping, id: 'attacker' },
    { ...shopping, frameId: 1 },
    { ...shopping, url: 'http://search.jd.com/' },
    { ...shopping, url: 'https://search.jd.com.evil.example/' },
    { ...shopping, tab: { id: 1, url: 'https://evil.example/' } },
    { ...popup, url: 'chrome-extension://extension-test/demo.html' },
  ]) assert.equal((await h.send({ type: 'CLASSIFY', product }, sender)).code, 'FORBIDDEN');
  assert.equal((await h.send({ type: 'CLASSIFY', product }, popup)).code, 'FORBIDDEN');
  assert.equal(h.calls.length, 0);
});

test('trusted popup page also works as a top-level extension tab but not an embedded frame', async () => {
  const h = harness();
  const extensionTab = { ...popup, frameId: 0, tab: { id: 2, url: popup.url } };
  assert.equal((await h.send({ type: 'GET_STATE' }, extensionTab)).ok, true);
  assert.equal((await h.send({ type: 'SAVE_SETTINGS', enabled: false }, extensionTab)).enabled, false);
  assert.equal((await h.send({ type: 'GET_STATE' }, { ...extensionTab, frameId: 1 })).code, 'FORBIDDEN');
  assert.equal((await h.send({ type: 'CLASSIFY', product }, extensionTab)).code, 'FORBIDDEN');
});

test('JD homepage is injected and authorized while lookalike, iframe and non-https origins are rejected', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(SHOPPING_MATCHES.includes('https://www.jd.com/*'), true);
  assert.equal(manifest.host_permissions.includes('https://www.jd.com/*'), true);
  assert.equal(manifest.content_scripts[0].matches.includes('https://www.jd.com/*'), true);
  const sender = { ...shopping, url: 'https://www.jd.com/', tab: { id: 1, url: 'https://www.jd.com/' } };
  const h = harness();
  assert.equal((await h.send({ type: 'CLASSIFY', product }, sender)).ok, true);
  for (const invalid of [
    { ...sender, url: 'https://www.jd.com.evil.example/' },
    { ...sender, url: 'http://www.jd.com/' },
    { ...sender, url: 'https://www.jd.com:8443/' },
    { ...sender, frameId: 1 },
    { ...sender, id: 'other-extension' },
  ]) assert.equal((await h.send({ type: 'CLASSIFY', product }, invalid)).code, 'FORBIDDEN');
});

test('request targets fixed provider and transmits only product fields with no browser credentials', async () => {
  const h = harness({ fetchImpl: async () => answer('no_weekend') });
  const result = await h.send({ type: 'CLASSIFY', product: { ...product, cookie: 'private' }, url: 'https://evil.example' });
  assert.deepEqual(result, { ok: true, choice: 'no_weekend', cached: false });
  const [url, options] = h.calls[0];
  assert.equal(url, MODEL_CONFIG.endpoint);
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(JSON.parse(options.body).state.cookie, undefined);
  assert.equal(JSON.stringify(h.store[STORAGE_KEYS.cache]).includes(KEY), false);
  assert.equal(JSON.stringify(h.store[STORAGE_KEYS.cache]).includes(product.shop_name), false);
});

test('identical in-flight requests merge and cache persists across worker restarts for 24 hours', async () => {
  const response = deferred();
  let now = 1_000_000;
  const h = harness({ now: () => now, fetchImpl: async () => response.promise });
  const first = h.send({ type: 'CLASSIFY', product });
  const duplicate = h.send({ type: 'CLASSIFY', product: { ...product, product_title: `  ${product.product_title}  ` } });
  await until(() => h.calls.length === 1);
  response.resolve(answer('weekend'));
  assert.equal((await first).choice, 'weekend');
  assert.equal((await duplicate).choice, 'weekend');
  assert.equal(h.calls.length, 1);
  assert.equal((await h.send({ type: 'CLASSIFY', product })).cached, true);
  const restarted = harness({ initial: h.store, now: () => now });
  assert.equal((await restarted.send({ type: 'CLASSIFY', product })).cached, true);
  assert.equal(restarted.calls.length, 0);
  now += LIMITS.cacheTtlMs + 1;
  assert.equal((await restarted.send({ type: 'CLASSIFY', product })).cached, false);
  assert.equal(restarted.calls.length, 1);
});

test('model requests are capped at three concurrent calls across tabs', async () => {
  const responses = [];
  let active = 0;
  let peak = 0;
  const h = harness({ fetchImpl: async () => {
    active += 1;
    peak = Math.max(peak, active);
    const deferredResponse = deferred();
    responses.push(deferredResponse);
    const result = await deferredResponse.promise;
    active -= 1;
    return result;
  } });
  const jobs = Array.from({ length: 7 }, (_, index) => h.send({
    type: 'CLASSIFY', product: { ...product, product_id: String(index) },
  }));
  await until(() => responses.length === 3);
  await tick();
  assert.equal(h.calls.length, 3);
  for (let index = 0; index < jobs.length; index += 1) {
    await until(() => responses.length > index);
    responses[index].resolve(answer());
  }
  assert.equal((await Promise.all(jobs)).every((result) => result.ok), true);
  assert.equal(peak, 3);
});

test('disable aborts active requests, drops queued work, broadcasts removal, and returns no stamp', async () => {
  const signals = [];
  const h = harness({ fetchImpl: async (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const jobs = Array.from({ length: 5 }, (_, index) => h.send({
    type: 'CLASSIFY', product: { ...product, product_id: String(index) },
  }));
  await until(() => signals.length === 3);
  const state = await h.send({ type: 'SAVE_SETTINGS', enabled: false }, popup);
  assert.equal(state.enabled, false);
  const results = await Promise.all(jobs);
  assert.equal(results.every((result) => !result.ok && result.code === 'CANCELLED'), true);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.broadcasts.at(-1).message.enabled, false);
  assert.equal((await h.send({ type: 'CLASSIFY', product })).code, 'DISABLED');
});

test('429 retries only once, persists cooldown, and never switches model or endpoint', async () => {
  let now = 10_000;
  const sleeps = [];
  const h = harness({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    fetchImpl: async () => new Response('private-response-body', { status: 429, headers: { 'retry-after': '2' } }),
  });
  const result = await h.send({ type: 'CLASSIFY', product });
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.retryAfterMs, 2000);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(h.store[STORAGE_KEYS.cooldown], now + 2000);
  assert.equal((await h.send({ type: 'CLASSIFY', product: { ...product, product_id: 'other' } })).code, 'RATE_LIMITED');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.every(([url, options]) => url === MODEL_CONFIG.endpoint && JSON.parse(options.body).model === MODEL_CONFIG.model), true);
  assert.equal(JSON.stringify(result).includes('private-response-body'), false);
});

test('replacing a key cancels old work and a fresh request uses the new credential', async () => {
  let count = 0;
  const h = harness({ fetchImpl: async (_url, { signal }) => {
    count += 1;
    if (count > 1) return answer('weekend');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const old = h.send({ type: 'CLASSIFY', product });
  await until(() => h.calls.length === 1);
  await h.send({ type: 'SAVE_SETTINGS', apiKey: 'replacement-key' }, popup);
  assert.equal((await old).code, 'CANCELLED');
  assert.deepEqual(h.broadcasts.at(-1).message, {
    type: 'STATE_CHANGED', enabled: true, configured: true, provider: 'typesafe', reset: true,
  });
  assert.equal(JSON.stringify(h.broadcasts).includes('replacement-key'), false);
  const fresh = await h.send({ type: 'CLASSIFY', product });
  assert.equal(fresh.choice, 'weekend');
  assert.equal(h.calls[1][1].headers.Authorization, 'Bearer replacement-key');
});

test('unchanged key does not reset the page and a plain toggle broadcasts reset false', async () => {
  const h = harness();
  await h.send({ type: 'SAVE_SETTINGS', apiKey: KEY }, popup);
  assert.equal(h.broadcasts.length, 0);
  await h.send({ type: 'SAVE_SETTINGS', enabled: false }, popup);
  assert.deepEqual(h.broadcasts.at(-1).message, {
    type: 'STATE_CHANGED', enabled: false, configured: true, provider: 'typesafe', reset: false,
  });
  assert.equal('reset' in (await h.send({ type: 'GET_STATE' })), false);
});

test('disabling during rate-limit backoff aborts the retry', async () => {
  let sleeping = false;
  const h = harness({
    fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    sleep: async (_ms, signal) => {
      sleeping = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const request = h.send({ type: 'CLASSIFY', product });
  await until(() => sleeping);
  await h.send({ type: 'SAVE_SETTINGS', enabled: false }, popup);
  assert.equal((await request).code, 'CANCELLED');
  assert.equal(h.calls.length, 1);
});

test('long Retry-After is honored without retrying early and survives worker restart', async () => {
  let now = 10_000;
  const h = harness({
    now: () => now,
    sleep: async () => assert.fail('Long cooldown must not retry inline'),
    fetchImpl: async () => new Response('', { status: 529, headers: { 'retry-after': '60' } }),
  });
  assert.equal((await h.send({ type: 'CLASSIFY', product })).retryAfterMs, 60_000);
  assert.equal(h.calls.length, 1);
  now += 1_000;
  const restarted = harness({ now: () => now, initial: h.store });
  assert.equal((await restarted.send({ type: 'CLASSIFY', product })).code, 'RATE_LIMITED');
  assert.equal(restarted.calls.length, 0);
  now += 60_000;
  assert.equal((await restarted.send({ type: 'CLASSIFY', product })).ok, true);
});

test('invalid JSON, bad choices, auth errors, network errors, unavailable official model and timeout never stamp', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('bad-json'), 'INVALID_RESPONSE'],
    [async () => answer('anything'), 'INVALID_RESPONSE'],
    [async () => new Response(KEY, { status: 401 }), 'AUTH_FAILED'],
    [async () => new Response(KEY, { status: 402 }), 'MODEL_UNAVAILABLE'],
    [async () => { throw new Error(KEY); }, 'NETWORK_ERROR'],
    [async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'TIMEOUT'],
  ]) {
    const h = harness({ fetchImpl, limits: { ...LIMITS, timeoutMs: 15 } });
    const result = await h.send({ type: 'CLASSIFY', product });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.choice, undefined);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(h.store[STORAGE_KEYS.cache], undefined);
    assert.equal((await h.send({ type: 'GET_STATE' }, popup)).status.kind, 'error');
  }
});

test('clearing a saved key disables the extension and concurrent saves keep both updates', async () => {
  const h = harness({ enabled: false });
  await Promise.all([
    h.send({ type: 'SAVE_SETTINGS', apiKey: 'new-key' }, popup),
    h.send({ type: 'SAVE_SETTINGS', enabled: true }, popup),
  ]);
  assert.deepEqual(h.store[STORAGE_KEYS.settings], {
    enabled: true, apiKey: 'new-key', provider: 'typesafe',
  });
  const cleared = await h.send({ type: 'SAVE_SETTINGS', apiKey: '' }, popup);
  assert.equal(cleared.configured, false);
  assert.equal(cleared.enabled, false);
  assert.equal(JSON.stringify(cleared).includes('new-key'), false);
});

test('extension refuses requests when it cannot restrict storage access', async () => {
  const h = harness();
  await h.app.ready;
  h.chromeApi.storage.local.setAccessLevel = async () => { throw new Error('denied'); };
  const app = createBackground({ chromeApi: h.chromeApi, fetchImpl: async () => assert.fail('No request allowed') });
  const result = await app.handleMessage({ type: 'CLASSIFY', product }, shopping);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL_ERROR');
});


test('legacy provider keys and local restore intent are discarded before official requests are possible', async () => {
  for (const provider of ['local', 'cloud', undefined]) {
    const h = harness({
      offscreenExists: true,
      initial: {
        [STORAGE_KEYS.settings]: { provider, apiKey: 'legacy-key-never-send', enabled: true,
          pendingLocalEnable: true, restoreLocalOnStartup: true },
        [STORAGE_KEYS.status]: { kind: 'error', message: 'Old provider failure' },
        [STORAGE_KEYS.cooldown]: Date.now() + 60_000,
        [STORAGE_KEYS.cache]: { ['a'.repeat(64)]: { choice: 'no_weekend', expiresAt: Date.now() + 60_000 } },
      },
    });
    const state = await h.send({ type: 'GET_STATE' }, popup);
    assert.equal(state.provider, 'typesafe');
    assert.equal(state.enabled, false);
    assert.equal(state.configured, false);
    assert.equal(state.local, undefined);
    assert.equal(state.pendingLocalEnable, undefined);
    assert.equal(state.status.message.includes('Old provider failure'), false);
    assert.equal(JSON.stringify(state).includes('legacy-key-never-send'), false);
    assert.deepEqual(h.store[STORAGE_KEYS.settings], { provider: 'typesafe', apiKey: '', enabled: false });
    assert.deepEqual(h.store[STORAGE_KEYS.cache], {});
    assert.equal(h.store[STORAGE_KEYS.cooldown], 0);
    assert.equal(h.engine.closed, 1);
    assert.equal(h.events.findIndex(([name]) => name === 'close') < h.events.findIndex(([name]) => name === 'writeSettings'), true);
    assert.equal(h.engine.created, 0);
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.broadcasts.at(-1).message.reset, true);
    assert.equal((await h.send({ type: 'CLASSIFY', product })).code, 'DISABLED');
    assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).code, 'NOT_CONFIGURED');
    assert.equal(h.calls.length, 0);
    await h.send({ type: 'SAVE_SETTINGS', apiKey: 'new-official-key' }, popup);
    assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1].headers.Authorization, 'Bearer new-official-key');
    assert.equal(JSON.stringify(h.calls).includes('legacy-key-never-send'), false);
  }
});

test('first install stays paused, while official settings survive restarts without touching local runtime', async () => {
  const first = harness({ initial: { [STORAGE_KEYS.settings]: undefined } });
  const initial = await first.send({ type: 'GET_STATE' }, popup);
  assert.equal(initial.provider, 'typesafe');
  assert.equal(initial.configured, false);
  assert.equal(initial.enabled, false);
  assert.equal(first.engine.created, 0);
  assert.equal(first.engine.closed, 0);
  assert.equal(first.events.some(([name]) => name === 'contexts'), false);
  assert.equal(first.calls.length, 0);
  await first.send({ type: 'SAVE_SETTINGS', apiKey: KEY, enabled: true }, popup);
  const restarted = harness({ initial: first.store, offscreenExists: true });
  const restored = await restarted.send({ type: 'GET_STATE' }, popup);
  assert.equal(restored.enabled, true);
  assert.equal(restored.configured, true);
  assert.equal(restored.providerLabel, MODEL_CONFIG.provider);
  assert.equal(restored.model, MODEL_CONFIG.model);
  assert.equal(restarted.engine.created, 0);
  assert.equal(restarted.engine.closed, 0);
  assert.equal(restarted.events.some(([name]) => name === 'contexts'), false);
  assert.equal(restarted.calls.length, 0);
});

test('old local operations are unsupported and legacy pages cannot change official settings', async () => {
  const h = harness();
  for (const type of ['PREPARE_LOCAL', 'UNLOAD_LOCAL', 'LOCAL_LOAD', 'LOCAL_CLASSIFY', 'LOCAL_STATUS', 'CLASSIFY_SAMPLE']) {
    const result = await h.send({ type, enableWhenReady: true, sampleId: 'single' }, popup);
    assert.equal(result.code, 'UNKNOWN_MESSAGE');
    assert.equal(result.ok, false);
  }
  for (const sender of [setup, offscreen]) {
    assert.equal((await h.send({ type: 'GET_STATE' }, sender)).code, 'FORBIDDEN');
    assert.equal((await h.send({ type: 'SAVE_SETTINGS', apiKey: 'injected' }, sender)).code, 'FORBIDDEN');
  }
  for (const extra of [{ provider: 'local' }, { provider: 'cloud' }, { endpoint: 'https://evil.example' }, { model: 'other' }]) {
    assert.equal((await h.send({ type: 'SAVE_SETTINGS', ...extra }, popup)).code, 'INVALID_SETTINGS');
  }
  assert.equal(h.engine.created, 0);
  assert.equal(h.engine.closed, 0);
  assert.equal(h.engine.calls.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store[STORAGE_KEYS.settings].apiKey, KEY);
});

test('requests use only the pinned official TypeSafe endpoint and model', async () => {
  assert.equal(MODEL_CONFIG.provider, 'TypeSafe AI');
  assert.equal(MODEL_CONFIG.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(MODEL_CONFIG.model, 'jev-1.13.0');
  const h = harness();
  const result = await h.send({ type: 'CLASSIFY', product, endpoint: 'https://opencode.ai/zen/v1/systemone' });
  assert.equal(result.ok, true);
  assert.equal(h.calls[0][0], 'https://api.typesafe.ai/v1/systemone');
  assert.equal(JSON.parse(h.calls[0][1].body).model, 'jev-1.13.0');
});

test('a failure to close a legacy engine blocks migration and sends no credential anywhere', async () => {
  const h = harness({ provider: 'local', offscreenExists: true });
  h.chromeApi.offscreen.closeDocument = async () => { throw new Error('private legacy failure'); };
  const result = await h.send({ type: 'GET_STATE' }, popup);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LEGACY_CLEANUP_FAILED');
  assert.equal(JSON.stringify(result).includes('private legacy failure'), false);
  assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).code, 'LEGACY_CLEANUP_FAILED');
  assert.equal(h.calls.length, 0);
  assert.equal(h.engine.created, 0);
});

test('a failed settings write never activates or transmits the unsaved key', async () => {
  const h = harness({ enabled: false, key: '' });
  await h.app.ready;
  const originalSet = h.chromeApi.storage.local.set;
  h.chromeApi.storage.local.set = async value => {
    if (STORAGE_KEYS.settings in value) throw new Error('private storage failure');
    return originalSet(value);
  };
  const result = await h.send({ type: 'SAVE_SETTINGS', apiKey: 'unsaved-key', enabled: true }, popup);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(result).includes('private storage failure'), false);
  const state = await h.send({ type: 'GET_STATE' }, popup);
  assert.equal(state.configured, false);
  assert.equal(state.enabled, false);
  assert.equal(h.store[STORAGE_KEYS.settings].apiKey, '');
  assert.equal((await h.send({ type: 'TEST_CONNECTION' }, popup)).code, 'NOT_CONFIGURED');
  assert.equal((await h.send({ type: 'CLASSIFY', product })).code, 'DISABLED');
  assert.equal(h.calls.length, 0);
});
