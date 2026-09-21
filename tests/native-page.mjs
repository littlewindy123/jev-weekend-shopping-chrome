import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Fictional products in the observed JD DOM shapes. Every model reply is a mock.
// This checks production content scripts in a real DOM, not a live shopping site.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const project = fileURLToPath(new URL('../', import.meta.url));
const files = new Map([
  ['/adapters.js', ['adapters.js', 'text/javascript']],
  ['/content.js', ['content.js', 'text/javascript']],
  ['/stamp.css', ['stamp.css', 'text/css']]
]);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Fictional native-page regression — mocked inference</title>
<link rel="stylesheet" href="/stamp.css"><style>
body{margin:24px;min-height:2400px;font:16px sans-serif}h1{font-size:18px}
#original-list{display:grid;grid-template-columns:repeat(3,280px);gap:24px}
#J_feeds,#search-results{display:contents}.more2_item_good,.plugin_goodsCardWrapper{list-style:none;height:300px}
.more2_lk{display:block;color:inherit;text-decoration:none}.more2_img,._bannerPicBox_fixture_1{height:210px;background:#dbe8d2}
._bannerPicBoxBtns_fixture_2{height:18px}.more2_info_name,._goods_title_container_fixture_1{padding-top:8px}
</style></head><body><h1>虚构商品结构回归 · 全部响应为 mock · 非真实京东判断</h1>
<aside id="countdown">60</aside><main id="original-list"><ul id="J_feeds"></ul><section id="search-results"></section></main></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } else if (files.has(pathname)) {
      const [filename, contentType] = files.get(pathname);
      res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
      res.end(await readFile(path.join(project, filename)));
    } else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), 'dws-native-page-'));
let context;
let checks = 0;
const errors = [];
const pass = name => { checks++; console.log(`PASS ${name}`); };
const settle = page => page.waitForTimeout(220);

async function fixture({ enabled = true, configured = true } = {}) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/fixture`);
  await page.addScriptTag({ url: `${origin}/adapters.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.evaluate(({ enabled, configured }) => {
    const WS = window.WeekendShopping;
    const base = WS.adapters.jd;
    const stats = { extract: 0, measure: 0, findRoot: 0, findSubtree: 0, active: 0, peak: 0 };
    const calls = [], pending = new Map(), originals = new Map(), clicks = [];
    const rootNode = document.querySelector('#original-list');
    // Counts script-originated layout reads, not the browser's internal IO layout.
    for (const name of ['getBoundingClientRect', 'getClientRects', 'checkVisibility']) {
      const original = Element.prototype[name];
      if (!original) continue;
      Element.prototype[name] = function (...args) {
        if (this.matches(base.cardSelector) || this.closest(base.cardSelector)) stats.measure++;
        return original.apply(this, args);
      };
    }
    const adapter = {
      ...base,
      findCards(scope) {
        stats[scope === document ? 'findRoot' : 'findSubtree']++;
        return base.findCards(scope);
      },
      extract(card) { stats.extract++; return base.extract(card); }
    };
    function add({ id, kind = 'home', opacity = '', sku = true } = {}) {
      const card = document.createElement(kind === 'home' ? 'li' : 'div');
      card.dataset.fixtureId = id;
      if (kind === 'home') {
        card.className = 'more2_item_good';
        card.innerHTML = `<a class="more2_lk" href="https://item.jd.com/${id}.html"><div class="more2_img"></div><div class="more2_info_name">虚构首页水杯 ${id}</div></a>`;
        document.querySelector('#J_feeds').append(card);
      } else {
        card.className = 'plugin_goodsCardWrapper';
        if (sku) card.dataset.sku = id;
        card.innerHTML = `<div class="_bannerPicBoxBtns_fixture_2">虚构图片按钮</div><div class="_bannerPicBox_fixture_1"></div><div class="_goods_title_container_fixture_1"><span title="不可替代可见标题">虚构<font>水杯</font> ${id}</span></div><div class="_newStyle_3z0zc_1"><span class="_name_3z0zc_15"><span class="_limit_3z0zc_23">虚构商品京东自营旗舰店</span></span></div><a href="https://chat.jd.com/fictional-only">虚构客服入口</a>`;
        document.querySelector('#search-results').append(card);
      }
      if (opacity) card.style.opacity = opacity;
      card.addEventListener('click', event => {
        event.preventDefault(); // Keep all fixture clicks offline.
        clicks.push({ id, target: event.target.className });
      });
      originals.set(id, card);
      return card;
    }
    const controller = WS.createController({
      adapter, demo: true, dwellMs: 45, maxConcurrent: 3,
      onDiagnostics(state) {
        let output = document.querySelector('#dw-page-status');
        if (!output) {
          output = document.createElement('aside');
          output.id = 'dw-page-status';
          output.setAttribute('data-dw-owned', '');
          document.body.append(output);
        }
        output.textContent = state.message;
      },
      getState: async () => ({ enabled, configured, provider: 'local' }),
      classify(product) {
        calls.push({ ...product });
        stats.active++;
        stats.peak = Math.max(stats.peak, stats.active);
        return new Promise(resolve => pending.set(product.product_id, result => {
          pending.delete(product.product_id);
          stats.active--;
          resolve({ ok: true, choice: result, mock: true });
        }));
      }
    });
    window.nativeFixture = {
      stats, calls, originals, rootNode, clicks, controller, add,
      state(enabled, configured = true) { controller.setState({ enabled, configured, provider: 'local' }); },
      release(id, choice = 'no_weekend') {
        if (!pending.has(id)) throw new Error(`No mock request pending for ${id}`);
        pending.get(id)(choice);
      },
      // Deterministic visibility simulation; all IO, layout and DOM remain native.
      hidden(value) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    };
  }, { enabled, configured });
  return page;
}
const waitCall = (page, id) => page.waitForFunction(id => nativeFixture.calls.some(x => x.product_id === id), id);
const release = (page, id, choice = 'no_weekend') => page.evaluate(({ id, choice }) => nativeFixture.release(id, choice), { id, choice });
const snapshot = page => page.evaluate(() => ({ ...nativeFixture.stats, calls: nativeFixture.calls.length }));
async function finishNextRequests(page, offset, count) {
  for (let index = offset; index < offset + count; index++) {
    await page.waitForFunction(index => nativeFixture.calls.length > index, index);
    const id = await page.evaluate(index => nativeFixture.calls[index].product_id, index);
    await release(page, id);
  }
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 760 }
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());

  const native = await fixture();
  await native.evaluate(() => {
    nativeFixture.add({ id: '900000000001' });
    nativeFixture.add({ id: '900000000002', kind: 'search' });
  });
  await waitCall(native, '900000000001');
  await release(native, '900000000001');
  await waitCall(native, '900000000002');
  await release(native, '900000000002');
  await native.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 2);
  assert.deepEqual(await native.evaluate(() => nativeFixture.calls), [
    { platform: 'jd', product_id: '900000000001', product_title: '虚构首页水杯 900000000001', shop_name: '', brand_name: '', shop_description: '' },
    { platform: 'jd', product_id: '900000000002', product_title: '虚构水杯 900000000002', shop_name: '虚构商品京东自营旗舰店', brand_name: '', shop_description: '' }
  ]);
  assert.equal(await native.locator('.more2_img > .dw-stamp-overlay').count(), 1);
  assert.equal(await native.locator('._bannerPicBox_fixture_1 > .dw-stamp-overlay').count(), 1);
  assert.equal(await native.locator('._bannerPicBoxBtns_fixture_2 .dw-stamp-overlay').count(), 0);
  assert.deepEqual(await native.locator('.dw-stamp-note').allTextContents(), ['模拟结果 · 非 AI 判断', '模拟结果 · 非 AI 判断']);
  pass('fictional observed JD homepage/new-search shapes extract visible fields and place mocked stamps in their original image hosts');

  const image = await native.locator('.more2_img').boundingBox();
  await native.mouse.click(image.x + image.width / 2, image.y + image.height / 2);
  assert.equal(await native.evaluate(() => nativeFixture.clicks[0]?.id), '900000000001');
  assert.equal(await native.evaluate(() => nativeFixture.clicks[0]?.target), 'more2_img');
  assert.equal(await native.evaluate(() => [...document.querySelectorAll('.dw-stamp-overlay, .dw-stamp-overlay *')].every(node => getComputedStyle(node).pointerEvents === 'none')), true);
  assert.equal(await native.evaluate(() => nativeFixture.rootNode === document.querySelector('#original-list') && [...nativeFixture.originals].every(([id, card]) => card === document.querySelector(`[data-fixture-id="${id}"]`))), true);
  assert.equal(native.url(), `${origin}/fixture`);
  pass('PASS allows clicks to reach the original card; original page and card nodes are preserved');

  const beforeCountdown = await snapshot(native);
  await native.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      document.querySelector('#countdown').textContent = String(60 - i);
      await new Promise(requestAnimationFrame);
    }
  });
  await settle(native);
  const afterCountdown = await snapshot(native);
  assert.equal(afterCountdown.findRoot, beforeCountdown.findRoot);
  assert.equal(afterCountdown.extract, beforeCountdown.extract);
  assert.equal(afterCountdown.measure, beforeCountdown.measure);
  await native.evaluate(() => nativeFixture.add({ id: '900000000003' }));
  await waitCall(native, '900000000003');
  assert.equal((await snapshot(native)).findRoot, beforeCountdown.findRoot);
  await release(native, '900000000003');
  pass('unrelated countdown updates do not rescan or re-extract products; inserted product discovery scans only its subtree');
  await native.close();

  const queued = await fixture();
  await queued.evaluate(() => {
    nativeFixture.add({ id: '900000000011' });
    nativeFixture.add({ id: '900000000012', kind: 'search' });
  });
  await waitCall(queued, '900000000011');
  await settle(queued); // The second visible card has passed its dwell and is queued.
  assert.equal((await snapshot(queued)).calls, 1);
  await queued.evaluate(() => window.scrollTo(0, 1300));
  await settle(queued);
  await release(queued, '900000000011');
  await settle(queued);
  assert.equal((await snapshot(queued)).calls, 1, 'A queued product scrolled out before dispatch must not be sent');
  await queued.evaluate(() => window.scrollTo(0, 0));
  await waitCall(queued, '900000000012');
  await release(queued, '900000000012');
  assert.equal((await snapshot(queued)).peak, 1);
  pass('local inference stays at one concurrent request and drops a queued card after it scrolls out, then handles it on return');
  await queued.close();

  const paused = await fixture({ enabled: true, configured: false });
  await paused.evaluate(() => nativeFixture.add({ id: '900000000021' }));
  await settle(paused);
  assert.deepEqual(await snapshot(paused), { extract: 0, measure: 0, findRoot: 0, findSubtree: 0, active: 0, peak: 0, calls: 0 });
  await paused.evaluate(() => nativeFixture.state(true));
  await waitCall(paused, '900000000021');
  await release(paused, '900000000021');
  await paused.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 1);
  await paused.evaluate(() => nativeFixture.state(false));
  const disabledStats = await snapshot(paused);
  await paused.evaluate(() => {
    nativeFixture.add({ id: '900000000022', kind: 'search' });
    document.querySelector('.more2_info_name').textContent = '暂停时变更的虚构商品';
    nativeFixture.controller.scan();
  });
  await settle(paused);
  assert.deepEqual(await snapshot(paused), disabledStats);
  assert.equal(await paused.locator('.dw-stamp').count(), 0);
  pass('an unready model and a paused controller perform no product extraction, layout reads or new requests; pause removes stamps');
  await paused.evaluate(() => nativeFixture.state(true));
  await finishNextRequests(paused, 1, 2);
  await paused.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 2);
  assert.equal(await paused.evaluate(() => nativeFixture.calls.filter(x => x.product_id === '900000000021').at(-1).product_title), '暂停时变更的虚构商品');
  assert.equal(await paused.evaluate(() => nativeFixture.calls.filter(x => x.product_id === '900000000022').length), 1);
  pass('resuming discovers cards added during pause and reclassifies changed original card text');
  await paused.close();

  const hidden = await fixture();
  await hidden.evaluate(() => nativeFixture.add({ id: '900000000031' }));
  await waitCall(hidden, '900000000031');
  await hidden.evaluate(() => nativeFixture.hidden(true));
  const hiddenStats = await snapshot(hidden);
  await hidden.evaluate(() => {
    nativeFixture.add({ id: '900000000032', kind: 'search' });
    document.querySelector('.more2_info_name').textContent = '隐藏时变更的虚构商品';
    nativeFixture.controller.scan();
    nativeFixture.release('900000000031');
  });
  await settle(hidden);
  const whileHidden = await snapshot(hidden);
  for (const field of ['extract', 'measure', 'findRoot', 'findSubtree', 'calls']) assert.equal(whileHidden[field], hiddenStats[field]);
  assert.equal(await hidden.locator('.dw-stamp').count(), 0);
  await hidden.evaluate(() => nativeFixture.hidden(false));
  await finishNextRequests(hidden, 1, 2);
  await hidden.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 2);
  assert.equal(await hidden.evaluate(() => nativeFixture.calls.filter(x => x.product_id === '900000000031').at(-1).product_title), '隐藏时变更的虚构商品');
  pass('simulated hidden visibility stops extraction, layout and new requests, even on a pending reply; return discovers and validates changed cards');
  await hidden.close();

  const lazy = await fixture();
  await lazy.evaluate(() => nativeFixture.add({ id: '900000000041', kind: 'search', sku: false }));
  await settle(lazy);
  assert.equal((await snapshot(lazy)).calls, 0);
  assert.equal((await snapshot(lazy)).extract, 0);
  await lazy.evaluate(() => document.querySelector('.plugin_goodsCardWrapper').dataset.sku = '900000000041');
  await waitCall(lazy, '900000000041');
  await release(lazy, '900000000041');
  pass('a new-search card inserted without data-sku is discovered when its identity attribute arrives');
  await lazy.evaluate(() => nativeFixture.add({ id: '900000000042', opacity: '0' }));
  await settle(lazy);
  assert.equal(await lazy.evaluate(() => nativeFixture.calls.some(x => x.product_id === '900000000042')), false);
  await lazy.evaluate(() => document.querySelector('[data-fixture-id="900000000042"]').style.opacity = '1');
  await waitCall(lazy, '900000000042');
  await release(lazy, '900000000042');
  await lazy.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 2);
  pass('an opacity-zero card is not classified until a visibility style change makes its content visible');
  await lazy.close();

  const diagnostics = await fixture();
  await diagnostics.evaluate(() => nativeFixture.add({ id: '900000000051' }));
  await waitCall(diagnostics, '900000000051');
  await release(diagnostics, '900000000051', 'weekend');
  await diagnostics.waitForFunction(() => document.querySelector('#dw-page-status')?.textContent.includes('不盖章 1 件'));
  assert.equal(await diagnostics.locator('.dw-stamp').count(), 0);
  assert.equal(await diagnostics.evaluate(() => nativeFixture.controller.getDiagnostics().weekend), 1);
  assert.equal(await diagnostics.evaluate(() => 'unknown' in nativeFixture.controller.getDiagnostics()), false);
  await diagnostics.evaluate(() => nativeFixture.state(false));
  await diagnostics.waitForFunction(() => document.querySelector('#dw-page-status').textContent.includes('已暂停'));
  await diagnostics.evaluate(() => nativeFixture.state(true, false));
  await diagnostics.waitForFunction(() => document.querySelector('#dw-page-status').textContent.includes('尚未配置 Key'));
  await diagnostics.evaluate(() => nativeFixture.state(true));
  await diagnostics.waitForFunction(() => nativeFixture.calls.length === 2);
  await release(diagnostics, '900000000051', 'invalid-response');
  await diagnostics.waitForFunction(() => document.querySelector('#dw-page-status').textContent.includes('失败 1 件'));
  assert.equal(await diagnostics.locator('.dw-stamp').count(), 0);
  assert.equal(await diagnostics.locator('#dw-page-status').evaluate(e => getComputedStyle(e).pointerEvents), 'none');
  pass('binary diagnostics show no-stamp separately from pause, unconfigured and failure without a third decision');
  await diagnostics.close();

  assert.deepEqual(errors, []);
  pass('all fixture pages finish without uncaught browser errors');
  console.log(`Native-page regression: ${checks} checks passed (fictional JD fixtures; mocked model responses; simulated document visibility).`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolvedProfile = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolvedProfile === tempRoot || path.dirname(resolvedProfile) !== tempRoot ||
      !path.basename(resolvedProfile).startsWith('dws-native-page-')) {
    throw new Error('Refusing to remove a profile outside the expected temporary directory');
  }
  await rm(resolvedProfile, { recursive: true, force: true });
}
