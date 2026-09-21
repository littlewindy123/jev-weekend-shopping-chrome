import { STORAGE_KEYS } from './config.js';
const toggle = document.querySelector('#enabled');
const key = document.querySelector('#api-key');
const test = document.querySelector('#test');
const status = document.querySelector('#status');
let dirty = false, busy = true, lastState, stateRevision = 0, lastStatusSignature = '';
let saving = Promise.resolve();
async function inspectPage() {
  const output = document.querySelector('#page-status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATUS' }, { frameId: 0 });
    if (!page || typeof page.message !== 'string') throw new Error('No page status');
    output.textContent = `当前页面：${page.message}`;
  } catch {
    output.textContent = '当前页未连接。请在京东或淘宝商品列表刷新页面；更新扩展后，旧页面也需要刷新。';
  }
}
function report(message, kind = 'info') { status.textContent = message; status.dataset.kind = kind; }
function setBusy(value) {
  busy = value;
  for (const control of [toggle, key, test]) control.disabled = value;
}
function render(state) {
  if (!state || state.provider !== 'typesafe') return;
  stateRevision++;
  lastState = state;
  toggle.checked = state.enabled === true;
  document.querySelector('#switch-title').textContent = state.enabled ? '已开启' : '已暂停';
  document.querySelector('#switch-description').textContent = state.enabled
    ? '京东 / 淘宝 · 滚动时判断可见商品'
    : state.configured ? '连接成功后，开启上方开关即可' : '填写官方 Key，直接在商城原页使用';
  const signature = JSON.stringify(state.status);
  if (signature !== lastStatusSignature) {
    lastStatusSignature = signature;
    report(state.status?.message || '填写 TypeSafe 官方 API Key 后测试连接。', state.status?.kind);
  }
}
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展暂时无法响应，请重新加载。');
  return response;
}
function saveKey() {
  if (!dirty) return saving;
  dirty = false;
  const apiKey = key.value.trim();
  saving = saving.catch(() => {}).then(() => send({ type: 'SAVE_SETTINGS', apiKey }))
    .catch(error => { dirty = true; throw error; });
  return saving;
}
key.addEventListener('input', () => { dirty = true; });
key.addEventListener('change', async () => {
  stateRevision++;
  try {
    const state = await saveKey();
    if (state) render(state);
    report(key.value.trim() ? 'Key 已保存到本机。点击下方按钮测试连接。' : 'Key 已清除，扩展已暂停。');
  } catch (error) { dirty = true; report(error.message, 'error'); }
});
toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  stateRevision++;
  setBusy(true);
  try {
    await saveKey();
    render(await send({ type: 'SAVE_SETTINGS', enabled }));
    report(enabled ? '已开启。关闭弹窗，在京东、淘宝原页面滚动即可。' : '已暂停，页面印章已移除。');
  } catch (error) { render(lastState); report(error.message, 'error'); }
  finally { setBusy(false); }
});
document.querySelector('#settings').addEventListener('submit', async event => {
  event.preventDefault();
  stateRevision++;
  setBusy(true);
  report('正在连接 TypeSafe 官方 JEV…');
  try {
    await saveKey();
    render(await send({ type: 'TEST_CONNECTION' }));
    report('官方 JEV 连接成功。开启上方开关即可使用。', 'success');
  } catch (error) { report(error.message, 'error'); }
  finally { setBusy(false); }
});
async function initialize() {
  setBusy(true);
  try {
    // Background migration must finish before reading any old provider's saved key.
    const state = await send({ type: 'GET_STATE' });
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const saved = stored[STORAGE_KEYS.settings];
    key.value = saved?.provider === 'typesafe' && typeof saved.apiKey === 'string' ? saved.apiKey : '';
    render(state);
    setBusy(false);
    inspectPage();
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'STATE_CHANGED' && message.target === 'ui' && !busy) render(message);
    });
    setInterval(async () => {
      if (busy || document.hidden) return;
      inspectPage();
      const revision = ++stateRevision;
      try {
        const next = await send({ type: 'GET_STATE' });
        if (!busy && revision === stateRevision) render(next);
      } catch { /* The next user action reports connection errors. */ }
    }, 1500);
  } catch (error) { report(error.message, 'error'); }
}
initialize();
