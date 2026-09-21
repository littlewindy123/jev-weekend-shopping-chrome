import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Local synthetic DOM only; this does not access Taobao or call a model.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.DWS_CHROMIUM_PATH ? { executablePath: process.env.DWS_CHROMIUM_PATH } : { channel: 'chromium' }) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:20px;font:16px sans-serif}.card{width:240px;margin:20px;display:inline-block;vertical-align:top}
    .picture{width:240px;height:180px;background:#ddd}img{width:240px;height:180px}
    .contents{display:contents}.empty{position:absolute;width:0;height:0}
    #later{margin-top:1400px}
    </style></head><body><main>
    <a id="contents" class="card contents" href="https://item.taobao.com/item.htm?id=101"><div class="picture"><img></div><div class="goods-title">虚构水杯一</div></a>
    <div id="sibling" class="card"><a class="empty" href="https://detail.tmall.com/item.htm?id=102"></a><div class="picture"><img></div><div class="info-title">虚构水杯二</div></div>
    <a id="missing" class="card" href="https://item.taobao.com/item.htm?id=103"><div class="picture"><img></div><div class="goods-title"></div></a>
    <div id="later"><a class="card" href="https://item.taobao.com/item.htm?id=104"><div class="picture"><img></div><div class="goods-title">虚构屏外商品</div></a></div>
    </main></body></html>`);
  await page.addStyleTag({ content: await readFile(new URL('../stamp.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: await readFile(new URL('../adapters.js', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: await readFile(new URL('../content.js', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    window.calls = [];
    window.controller = WeekendShopping.createController({ adapter: WeekendShopping.adapters.taobao, dwellMs: 10,
      classify: async product => { calls.push(product); return { ok: true, choice: 'no_weekend' }; } });
  });
  await page.waitForFunction(() => calls.length === 2 && document.querySelectorAll('.dw-stamp').length === 2);
  assert.deepEqual(await page.evaluate(() => calls.map(p => p.product_id).sort()), ['101', '102']);
  assert.equal(await page.evaluate(() => controller.getDiagnostics().detected), 4);
  assert.match(await page.evaluate(() => controller.getDiagnostics().message), /未读到标题/);
  assert.equal(await page.locator('#sibling .dw-stamp').count(), 1);
  assert.equal(await page.locator('.dw-stamp-note').count(), 0);
  assert.deepEqual(await page.locator('.dw-stamp-overlay').allTextContents(), ['PASS', 'PASS']);
  console.log('PASS zero-size anchors and sibling titles enter classification; offscreen and missing-title cards do not');

  await page.evaluate(() => document.querySelector('#missing .goods-title').textContent = '延迟加载的虚构标题');
  await page.waitForFunction(() => calls.length === 3 && document.querySelectorAll('.dw-stamp').length === 3);
  assert.equal(await page.evaluate(() => calls.at(-1).product_id), '103');
  console.log('PASS lazy title arrival triggers classification without reloading');

  await page.evaluate(() => document.querySelector('#sibling img').replaceWith(document.createElement('img')));
  await page.waitForFunction(() => document.querySelectorAll('.dw-stamp').length === 3);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => calls.length), 3);
  console.log('PASS replacing an observed image does not repeat a completed request');

  await page.locator('#later').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => calls.length === 4 && document.querySelectorAll('.dw-stamp').length === 4);
  console.log('PASS a below-the-fold card is classified after scroll');

  await page.evaluate(() => {
    controller.destroy();
    document.body.innerHTML = '<section id="multi"><a href="https://item.taobao.com/item.htm?id=201"></a><a href="https://item.taobao.com/item.htm?id=202"></a><img><div class="title">不属于某一件商品的标题</div></section>';
  });
  const wrappers = await page.evaluate(() => WeekendShopping.adapters.taobao.findCards(document).map(e => e.tagName));
  assert.deepEqual(wrappers, ['A', 'A']);
  assert.deepEqual(errors, []);
  console.log('PASS different product identities never merge into a list-level card');
} finally { await browser.close(); }
