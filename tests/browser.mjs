import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Development-only dependency. The extension itself needs no npm install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'screenshots');
await mkdir(output, { recursive: true });
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture') {
      res.setHeader('Content-Type', types['.html']);
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/stamp.css"><style>body{margin:20px}#items{display:grid;grid-template-columns:repeat(3,240px);gap:20px}.card{height:360px}.pic{width:240px;height:240px;background:#e1e7d8}a{display:block;color:#203020}</style></head><body><div id="items"></div></body></html>');
      return;
    }
    const filename = path.resolve(project, '.' + pathname);
    if (!filename.startsWith(project) || pathname.includes('..')) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    res.end(await readFile(filename));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(os.tmpdir(), `dws-browser-test-${process.pid}-${Date.now()}`);
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.DWS_CHROMIUM_PATH ? { executablePath: process.env.DWS_CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true, viewport: { width: 1360, height: 1000 },
  args: [`--disable-extensions-except=${project}`, `--load-extension=${project}`],
});
let checks = 0;
const errors = [];
const track = page => page.on('pageerror', error => errors.push(error.message));
const pass = name => { checks++; console.log(`PASS ${name}`); };
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // The connection result below is explicitly a UI fixture, not an official API
  // response. Only TEST_CONNECTION is mocked; storage and toggles use real MV3.
  // Offline mode also prevents the test-only Key from reaching any remote service.
  await context.setOffline(true);
  const popup = await context.newPage();
  track(popup);
  await popup.addInitScript(() => {
    window.fixtureConnections = 0;
    window.fixtureConnectionOutcome = 'error';
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => {
      if (message.type !== 'TEST_CONNECTION') return original(message);
      window.fixtureConnections++;
      return Promise.resolve(window.fixtureConnectionOutcome === 'success'
        ? { ok: true }
        : { ok: false, error: 'Fixture only: official API connection rejected', code: 'AUTH_FAILED' });
    };
  });
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => !document.querySelector('#test').disabled && !document.querySelector('#status').textContent.includes('正在读取'));
  assert.equal(await popup.locator('#enabled').isChecked(), false);
  assert.equal(await popup.locator('form#settings').isVisible(), true);
  assert.equal(await popup.locator('#api-key').inputValue(), '');
  assert.equal(await popup.locator('#provider, #start-local, #local-panel, a[href="setup.html"]').count(), 0);
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length, 0);
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Popup must not overflow horizontally at 360px');
  assert.ok(await popup.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'Popup must fit the Chrome 600px popup height');
  await popup.screenshot({ path: path.join(output, 'popup.png') });
  await popup.locator('#enabled').click();
  await popup.waitForFunction(() => document.querySelector('#status').dataset.kind === 'error');
  assert.match(await popup.locator('#status').innerText(), /Key/);
  assert.equal(await popup.locator('#enabled').isChecked(), false);
  pass('real MV3 cloud-only popup defaults to paused without a Key and rejects enabling before configuration');

  await popup.locator('#api-key').fill('fixture-key-no-real-service');
  await popup.locator('#api-key').press('Tab');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#api-key').value === 'fixture-key-no-real-service');
  await popup.locator('#enabled').check();
  await popup.waitForFunction(() => document.querySelector('#switch-title').textContent === '已开启');
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('dwsSettings'))).dwsSettings.enabled, true);
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#enabled').checked && !document.querySelector('#enabled').disabled);
  await popup.locator('#enabled').uncheck();
  await popup.waitForFunction(() => document.querySelector('#switch-title').textContent === '已暂停');
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('dwsSettings'))).dwsSettings.enabled, false);
  pass('real MV3 Key and enabled state survive popup reload; toggling persists both on and off');

  await popup.locator('#test').click();
  await popup.waitForFunction(() => document.querySelector('#status').dataset.kind === 'error');
  assert.equal(await popup.locator('#status').innerText(), 'Fixture only: official API connection rejected');
  assert.equal(await popup.evaluate(() => fixtureConnections), 1);
  await popup.evaluate(() => { fixtureConnectionOutcome = 'success'; });
  await popup.locator('#test').click();
  await popup.waitForFunction(() => document.querySelector('#status').dataset.kind === 'success');
  assert.equal(await popup.evaluate(() => fixtureConnections), 2);
  assert.match(await popup.locator('#status').innerText(), /连接成功/);
  assert.equal(await popup.locator('#test').isDisabled(), false);
  await popup.screenshot({ path: path.join(output, 'popup-connected-fixture.png') });
  pass('explicit mocked TEST_CONNECTION reports failure and recovery; test-only Key never leaves the offline browser');

  await popup.locator('#api-key').fill('');
  await popup.locator('#api-key').press('Tab');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已清除'));
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Key'));
  assert.equal(await popup.locator('#api-key').inputValue(), '');
  assert.equal(await popup.locator('#enabled').isChecked(), false);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('dwsSettings'))).dwsSettings.apiKey, '');
  pass('clearing the Key persists across popup reload and leaves classification paused');

  const shopping = await context.newPage(); track(shopping);
  await shopping.route('https://www.jd.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Offline shopping fixture</body></html>'
  }));
  await shopping.goto('https://www.jd.com/');
  await shopping.waitForFunction(() => document.querySelector('#dw-page-status')?.textContent.includes('尚未配置 Key'));
  const shoppingTabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.jd.com/*' }))[0].id);
  const pageStatus = await popup.evaluate(id => chrome.tabs.sendMessage(id, { type: 'GET_PAGE_STATUS' }, { frameId: 0 }), shoppingTabId);
  assert.equal(pageStatus.configured, false);
  assert.match(pageStatus.message, /尚未配置 Key/);
  await popup.waitForFunction(() => document.querySelector('#page-status').textContent.includes('当前页面：'));
  await shopping.close();
  pass('real MV3 auto-injection shows unconfigured status and popup receives current-page diagnostics; offline JD fixture only');

  // UI polling regression only: all states in this block are explicitly mocked.
  const ui = await context.newPage(); track(ui);
  await ui.addInitScript(() => {
    window.fixtureState = {ok:true,provider:'typesafe',enabled:false,configured:true,status:{kind:'idle',message:'UI test fixture'}};
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => {
      if (message.type === 'GET_STATE') return Promise.resolve(window.fixtureState);
      return original(message);
    };
  });
  await ui.goto(`chrome-extension://${extensionId}/popup.html`);
  await ui.waitForFunction(() => document.querySelector('#status').textContent.includes('UI test fixture'));
  await ui.evaluate(() => {fixtureState.status={kind:'error',message:'UI fixture inference failure'};});
  await ui.waitForFunction(() => document.querySelector('#status').textContent==='UI fixture inference failure');
  await ui.evaluate(() => {fixtureState.status={kind:'success',message:'UI fixture recovered'};});
  await ui.waitForFunction(() => document.querySelector('#status').textContent==='UI fixture recovered');
  await ui.close();
  pass('explicit mocked UI state: popup polling reports failures and recovery without reopening');
  await context.setOffline(false);

  const page = await context.newPage(); track(page);
  await page.setViewportSize({width:1360,height:1120});
  await page.goto(`${url}/demo.html`);
  await page.locator('#products .dw-stamp').first().waitFor();
  assert.equal(await page.locator('.dw-stamp-note').first().innerText(), '模拟结果 · 非 AI 判断');
  await page.locator('[data-product-id="fiction-4"] .dw-stamp').waitFor();
  await page.screenshot({ path: path.join(output, 'demo.png'), fullPage: false });
  const firstImage = page.locator('[data-dw-image]').first();
  await firstImage.click();
  assert.match(await page.locator('#feedback').innerText(), /商品点击正常/);
  await page.locator('#replace').click();
  await page.waitForFunction(() => !document.querySelector('#products article').querySelector('.dw-stamp'));
  await firstImage.click();
  assert.match(await page.locator('#feedback').innerText(), /商品点击正常/);
  await page.locator('#demo-enabled').uncheck();
  assert.equal(await page.locator('#products .dw-stamp').count(), 0);
  pass('demo displays explicit simulated labels, stamp does not block product click, recycled card and off switch remove stamps');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'demo-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  pass('demo has no horizontal overflow at 390px');

  const fixture = await context.newPage(); track(fixture);
  await fixture.setViewportSize({ width: 900, height: 500 });
  await fixture.goto(`${url}/fixture`);
  await fixture.addScriptTag({ url: `${url}/adapters.js` });
  await fixture.addScriptTag({ url: `${url}/content.js` });
  await fixture.evaluate(() => {
    window.calls = []; window.resolvers = []; window.active = 0; window.peak = 0; window.clicks = 0;
    window.addCard = (id, choice = 'no_weekend') => {
      const card = document.createElement('article'); card.className = 'card';
      card.dataset.dwProduct = ''; card.dataset.productId = id;
      card.innerHTML = `<a href="#${id}"><div class="pic" data-dw-image></div><h3 data-dw-title>Fictional ${id}</h3></a><p data-dw-shop>Fictional shop ${id}</p>`;
      card.dataset.choice = choice;
      card.querySelector('a').onclick = event => { event.preventDefault(); window.clicks++; };
      document.querySelector('#items').append(card); return card;
    };
    for (let i = 0; i < 12; i++) addCard(`item-${i}`, ['no_weekend','weekend','unknown'][i % 3]);
    window.controller = WeekendShopping.createController({
      adapter: WeekendShopping.adapters.demo, demo: true, dwellMs: 60,
      classify: product => {
        calls.push(product); active++; peak = Math.max(peak, active);
        return new Promise(resolve => resolvers.push(result => { active--; resolve(result); }));
      }
    });
  });
  await fixture.waitForFunction(() => calls.length === 3);
  assert.equal(await fixture.evaluate(() => peak), 3);
  assert.ok(await fixture.evaluate(() => calls.every(item => ['item-0','item-1','item-2'].includes(item.product_id))));
  await fixture.evaluate(() => {
    document.querySelector('[data-product-id="item-0"] [data-dw-title]').textContent = 'New identity while old result is pending';
    resolvers.splice(0).forEach(resolve => resolve({ ok: true, choice: 'no_weekend' }));
  });
  await fixture.waitForFunction(() => calls.length >= 6);
  assert.equal(await fixture.locator('[data-product-id="item-0"] .dw-stamp').count(), 0);
  pass('viewport dwell and concurrency capped at 3; late result for changed card never stamps the new identity');
  await fixture.evaluate(() => {
    controller.setState({ enabled: false, configured: true });
    resolvers.splice(0).forEach(resolve => resolve({ ok: true, choice: 'no_weekend' }));
  });
  await fixture.waitForFunction(() => active === 0);
  assert.equal(await fixture.locator('.dw-stamp').count(), 0);
  pass('switch-off clears stamps and rejects in-flight stale results');

  await fixture.evaluate(() => {
    controller.destroy(); calls.length = 0; peak = 0;
    controller = WeekendShopping.createController({
      adapter: WeekendShopping.adapters.demo, demo: true, dwellMs: 50,
      classify: async product => {
        calls.push(product); active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 40)); active--;
        const card = document.querySelector(`[data-product-id="${product.product_id}"]`);
        return card?.dataset.choice === 'error' ? {ok:false,error:'fixture failure'} : {ok:true,choice:card?.dataset.choice || 'unknown'};
      }
    });
  });
  await fixture.locator('[data-product-id="item-0"] .dw-stamp').waitFor();
  await fixture.waitForFunction(() => active === 0 && calls.length === 6);
  assert.equal(await fixture.locator('[data-product-id="item-1"] .dw-stamp').count(), 0);
  assert.equal(await fixture.locator('[data-product-id="item-2"] .dw-stamp').count(), 0);
  await fixture.locator('[data-product-id="item-0"] [data-dw-image]').click();
  assert.equal(await fixture.evaluate(() => clicks), 1);
  const beforeRepaint = await fixture.evaluate(() => calls.length);
  await fixture.evaluate(() => {
    const host = document.querySelector('[data-product-id="item-0"] [data-dw-image]');
    host.replaceChildren(document.createElement('img'));
  });
  await fixture.locator('[data-product-id="item-0"] .dw-stamp').waitFor();
  assert.equal(await fixture.evaluate(() => calls.length), beforeRepaint);
  pass('only no_weekend stamps; image subtree repaint restores mark without another request; product clicks remain usable');
  await fixture.evaluate(() => window.scrollTo(0, 780));
  await fixture.waitForFunction(() => calls.some(item => item.product_id === 'item-9') && active === 0);
  const afterScroll = await fixture.evaluate(() => calls.length);
  await fixture.evaluate(() => window.scrollTo(0, 0));
  await fixture.waitForTimeout(200);
  assert.equal(await fixture.evaluate(() => calls.length), afterScroll);
  await fixture.evaluate(() => {
    const card = addCard('added-error', 'error'); card.scrollIntoView();
  });
  await fixture.waitForFunction(() => calls.some(item => item.product_id === 'added-error') && active === 0);
  assert.equal(await fixture.locator('[data-product-id="added-error"] .dw-stamp').count(), 0);
  pass('scroll back does not reclassify unchanged cards; appended cards are observed; errors do not stamp');

  await fixture.evaluate(() => {
    const card = document.querySelector('[data-product-id="added-error"]'); card.dataset.choice = 'no_weekend';
    controller.setState({enabled:true,configured:true,reset:true});
  });
  await fixture.locator('[data-product-id="added-error"] .dw-stamp').waitFor();
  pass('changing the key can reset failed visible cards without requiring a reload');
  assert.deepEqual(errors, []);
  pass('no browser page JavaScript errors');
  console.log(`Browser checks passed: ${checks}`);
} catch (error) {
  for (const page of context.pages()) {
    console.error('Diagnostic:', page.url(), await page.locator('#status').textContent({timeout:500}).catch(() => 'no status element'));
  }
  console.error('Page errors:', errors);
  throw error;
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
