import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { STORAGE_KEYS } from '../config.js';

const source = (await readFile(new URL('../popup.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const idle = {
  ok: true, provider: 'typesafe', enabled: false, configured: false,
  status: { kind: 'idle', message: '填写官方 Key' },
};
const ready = { ...idle, enabled: true, configured: true, status: { kind: 'success', message: '官方连接成功' } };
const controls = ['enabled', 'api-key', 'test'];

async function fixture(initial = idle, { deferInitialization = false, saved } = {}) {
  const elements = new Map();
  for (const id of [...controls, 'status', 'page-status', 'settings', 'switch-title', 'switch-description']) {
    elements.set('#' + id, {
      value: '', checked: false, disabled: false, textContent: '', dataset: {},
      addEventListener(type, handler) { this[type] = handler; },
    });
  }
  const requests = [], events = [];
  let poll, listener, initialized = false;
  const context = vm.createContext({
    STORAGE_KEYS,
    document: { hidden: false, querySelector: selector => elements.get(selector) },
    setInterval: handler => { poll = handler; },
    chrome: {
      storage: { local: { get: async storageKey => {
        events.push(['storage', storageKey]);
        return deferInitialization
          ? new Promise((resolve, reject) => requests.push({ message: { type: 'STORAGE_SETTINGS' }, resolve, reject }))
          : { [STORAGE_KEYS.settings]: saved };
      } } },
      runtime: {
        sendMessage: async message => {
          events.push(['message', message.type]);
          if (!initialized && message.type === 'GET_STATE') {
            initialized = true;
            if (!deferInitialization) return initial;
          }
          return new Promise((resolve, reject) => requests.push({ message, resolve, reject }));
        },
        onMessage: { addListener: handler => { listener = handler; } },
      },
    },
  });
  vm.runInContext(source, context);
  await tick();
  return {
    requests, events, element: id => elements.get('#' + id), poll: () => poll(),
    canPoll: () => typeof poll === 'function',
    push: state => listener({ ...state, type: 'STATE_CHANGED', target: 'ui' }),
  };
}

test('controls wait for GET_STATE migration and saved settings; either initialization failure keeps controls disabled', async () => {
  for (const failure of ['', 'state', 'storage']) {
    const f = await fixture(idle, { deferInitialization: true });
    assert.equal(controls.every(id => f.element(id).disabled), true);
    assert.deepEqual(f.events, [['message', 'GET_STATE']]);
    f.requests[0].resolve(failure === 'state' ? { ok: false, error: '初始化失败' } : idle);
    await tick();
    assert.equal(controls.every(id => f.element(id).disabled), true);
    if (failure === 'state') {
      assert.equal(f.element('status').textContent, '初始化失败');
      assert.equal(f.events.length, 1, 'Storage must not expose a key before migration succeeds');
      assert.equal(f.canPoll(), false);
      continue;
    }
    assert.deepEqual(f.events, [['message', 'GET_STATE'], ['storage', STORAGE_KEYS.settings]]);
    if (failure === 'storage') f.requests[1].reject(new Error('设置读取失败'));
    else f.requests[1].resolve({});
    await tick();
    assert.equal(controls.every(id => f.element(id).disabled), failure === 'storage');
    assert.equal(f.canPoll(), failure !== 'storage');
    if (failure === 'storage') assert.equal(f.element('status').textContent, '设置读取失败');
  }
});

test('only a saved official TypeSafe key prefills the input, never legacy provider credentials', async () => {
  for (const provider of [undefined, 'local', 'cloud', 'opencode', 'typesafe']) {
    const f = await fixture(idle, { saved: { provider, apiKey: 'fixture-provider-key' } });
    assert.equal(f.element('api-key').value, provider === 'typesafe' ? 'fixture-provider-key' : '');
    assert.deepEqual(f.events, [['message', 'GET_STATE'], ['storage', STORAGE_KEYS.settings]]);
    assert.equal(f.requests.length, 0, 'Initialization must not save or test any credential');
  }
});

test('a stale poll cannot undo either completed switch action, while a later fresh poll can update state', async () => {
  for (const enabled of [true, false]) {
    const previous = { ...ready, enabled: !enabled };
    const f = await fixture(previous);
    const oldPoll = f.poll();
    f.element('enabled').checked = enabled;
    const action = f.element('enabled').change();
    await tick();
    assert.equal(controls.every(id => f.element(id).disabled), true);
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].message)), { type: 'SAVE_SETTINGS', enabled });
    f.requests[1].resolve({ ...ready, enabled });
    await action;
    f.requests[0].resolve(previous);
    await oldPoll;
    assert.equal(f.element('enabled').checked, enabled);
    assert.equal(f.element('switch-title').textContent, enabled ? '已开启' : '已暂停');
    assert.equal(controls.every(id => !f.element(id).disabled), true);
    const freshPoll = f.poll();
    f.requests[2].resolve(previous);
    await freshPoll;
    assert.equal(f.element('enabled').checked, !enabled);
  }
});

test('newer polls and pushed official states supersede older in-flight snapshots', async () => {
  for (const pushed of [false, true]) {
    const f = await fixture();
    const oldPoll = f.poll();
    if (pushed) f.push(ready);
    else {
      const newPoll = f.poll();
      f.requests[1].resolve(ready);
      await newPoll;
    }
    f.requests[0].resolve(idle);
    await oldPoll;
    assert.equal(f.element('enabled').checked, true);
    assert.equal(f.element('switch-title').textContent, '已开启');
  }
});

test('failed switch changes restore the known state and leave controls available for a successful retry', async () => {
  const f = await fixture({ ...idle, configured: true });
  f.element('enabled').checked = true;
  const failed = f.element('enabled').change();
  await tick();
  f.requests[0].resolve({ ok: false, error: '保存开关失败' });
  await failed;
  assert.equal(f.element('enabled').checked, false);
  assert.equal(f.element('status').textContent, '保存开关失败');
  assert.equal(f.element('status').dataset.kind, 'error');
  assert.equal(controls.every(id => !f.element(id).disabled), true);
  f.element('enabled').checked = true;
  const retry = f.element('enabled').change();
  await tick();
  f.requests[1].resolve(ready);
  await retry;
  assert.equal(f.element('enabled').checked, true);
  assert.notEqual(f.element('status').dataset.kind, 'error');
});

test('a failed credential save on submit can retry the same input before any connection request', async () => {
  const f = await fixture();
  f.element('api-key').value = 'new-official-fixture-key';
  f.element('api-key').input();
  const failed = f.element('settings').submit({ preventDefault() {} });
  await tick();
  assert.equal(f.requests[0].message.type, 'SAVE_SETTINGS');
  f.requests[0].resolve({ ok: false, error: 'Key 保存失败' });
  await failed;
  assert.equal(f.element('status').textContent, 'Key 保存失败');
  assert.equal(f.requests.length, 1, 'A failed save must not trigger an authenticated request');
  const retry = f.element('settings').submit({ preventDefault() {} });
  await tick();
  assert.equal(f.requests.length, 2, 'Retry must save the unchanged input again');
  assert.equal(f.requests[1].message.apiKey, 'new-official-fixture-key');
  f.requests[1].resolve({ ...idle, configured: true });
  await tick();
  assert.equal(f.requests[2].message.type, 'TEST_CONNECTION');
  f.requests[2].resolve({ ...ready, enabled: false });
  await retry;
  assert.match(f.element('status').textContent, /官方 JEV 连接成功/);
  assert.equal(f.element('status').dataset.kind, 'success');
  assert.equal(controls.every(id => !f.element(id).disabled), true);
});

test('connection failures and subsequent pushed recovery update the visible status without reopening', async () => {
  const f = await fixture({ ...idle, configured: true });
  const action = f.element('settings').submit({ preventDefault() {} });
  await tick();
  assert.equal(f.requests[0].message.type, 'TEST_CONNECTION');
  f.requests[0].resolve({ ok: false, error: '官方接口暂不可用' });
  await action;
  assert.equal(f.element('status').dataset.kind, 'error');
  assert.equal(f.element('status').textContent, '官方接口暂不可用');
  assert.equal(controls.every(id => !f.element(id).disabled), true);
  f.push({ ...ready, status: { kind: 'error', message: '新的限流错误' } });
  assert.equal(f.element('status').textContent, '新的限流错误');
  f.push({ ...ready, status: { kind: 'success', message: '服务已恢复' } });
  assert.equal(f.element('status').textContent, '服务已恢复');
  assert.equal(f.element('status').dataset.kind, 'success');
});
