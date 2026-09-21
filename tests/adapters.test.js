import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({ URL });
vm.runInContext(await readFile(new URL('../adapters.js', import.meta.url), 'utf8'), context);
const WS = context.WeekendShopping;

// A minimal element contract isolates extraction rules; real DOM fixtures live in browser.mjs.
function visible(innerText, { hidden = false, owned = false } = {}) {
  return { innerText, closest: () => owned ? {} : null, getClientRects: () => hidden ? [] : [{}] };
}
function card(fields, attributes = {}, href = 'https://item.jd.com/123.html', variant = '') {
  const link = { getAttribute: name => name === 'href' ? href : null };
  const linksMatch = selector => selector === 'a[href]' ||
    (selector.includes('a[href*=') &&
      (selector.includes('item.jd.com/') && href.includes('item.jd.com/') ||
        selector.includes('item.taobao.com/item.htm') && href.includes('item.taobao.com/item.htm') ||
        selector.includes('detail.tmall.com/item.htm') && href.includes('detail.tmall.com/item.htm')));
  return {
    matches: selector => !!variant && selector === variant,
    getAttribute: name => attributes[name] || null,
    querySelectorAll: selector => linksMatch(selector) ? [link] : fields[selector] || [],
    querySelector: selector => linksMatch(selector) ? link : fields[selector]?.[0] || null,
    ownerDocument: { location: { href: 'https://search.jd.com/Search?keyword=test' } }
  };
}

test('JD reads only rendered fields, keeps brand distinct, and does not invent a company from self-operated labels', () => {
  const result = WS.adapters.jd.extract(card({
    '.p-name em': [visible('隐藏标题', { hidden: true }), visible(' 测试\n水杯 ')],
    '.p-shop a': [visible('京东自营')],
    '.p-brand': [visible('独立品牌')],
    '.p-shop-description': [visible('隐藏说明', { hidden: true })]
  }, { 'data-sku': 'sku-123' }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    platform: 'jd', product_id: 'sku-123', product_title: '测试 水杯',
    shop_name: '', brand_name: '独立品牌', shop_description: ''
  });
});

test('missing visible title prevents classification; missing brand remains empty', () => {
  assert.equal(WS.adapters.jd.extract(card({ '.p-name': [visible('hidden', { hidden: true })] })), null);
  const result = WS.adapters.jd.extract(card({ '.p-name em': [visible('商品')], '.p-shop a': [visible('某某专营店')] }));
  assert.equal(result.brand_name, '');
  assert.equal(result.shop_name, '某某专营店');
  assert.equal(result.product_id, '123');
});

test('Taobao recovers item id from approved product link without opening it', () => {
  const result = WS.adapters.taobao.extract(card({
    '[class*="Title--title"]': [visible('示例商品')],
    '[class*="ShopInfo--shopName"]': [visible('示例商店')]
  }, {}, '//item.taobao.com/item.htm?id=7654321&spm=tracking'));
  assert.equal(result.product_id, '7654321');
  assert.equal(result.shop_name, '示例商店');
  assert.equal(result.platform, 'taobao');
});

test('all input fields and href identity changes invalidate local card results', () => {
  const product = { platform: 'jd', product_id: '1', product_title: '杯', shop_name: '店', brand_name: '', shop_description: '' };
  for (const key of Object.keys(product)) {
    assert.notEqual(WS.fingerprint(product), WS.fingerprint({ ...product, [key]: `${product[key]}x` }));
  }
  assert.notEqual(WS.adapters.jd.identity(card({}, {}, 'https://item.jd.com/1.html')),
    WS.adapters.jd.identity(card({}, {}, 'https://item.jd.com/2.html')));
});

test('automatic adapter selection is restricted to declared shopping hosts', () => {
  assert.equal(WS.detectAdapter('www.jd.com'), WS.adapters.jd);
  assert.equal(WS.detectAdapter('search.jd.com'), WS.adapters.jd);
  assert.equal(WS.detectAdapter('s.taobao.com'), WS.adapters.taobao);
  assert.equal(WS.detectAdapter('evil.search.jd.com'), null);
  assert.equal(WS.detectAdapter('passport.jd.com'), null);
  assert.equal(WS.detectAdapter('localhost'), null);
});

test('observed JD homepage card uses product href and visible title without inventing a shop or brand', () => {
  const image = {};
  const item = card({
    '.more2_info_name': [visible('京东首页测试商品')],
    '.more2_img': [image],
    '.p-shop a': [visible('不能移作首页店铺的信息')],
    '.p-brand': [visible('不能移作运营公司的品牌')]
  }, { 'data-brand': '自营' }, 'https://item.jd.com/100002143889.html', '.more2_item_good');
  assert.deepEqual(JSON.parse(JSON.stringify(WS.adapters.jd.extract(item))), {
    platform: 'jd', product_id: '100002143889', product_title: '京东首页测试商品',
    shop_name: '', brand_name: '', shop_description: ''
  });
  assert.equal(WS.adapters.jd.imageHost(item), image);
});

test('observed JD new search card reads data-sku and named self-operated store, never chat links', () => {
  const image = {};
  const item = card({
    '[class*="_goods_title_container_"] span[title]': [visible('富光 测试水杯')],
    '[class*="_name_3z0zc_"]': [visible('富光FGA京东自营旗舰店')],
    '[class*="_bannerPicBox_"]': [image]
  }, { 'data-sku': '100002143890' }, 'https://chat.jd.com/example', '.plugin_goodsCardWrapper[data-sku]');
  assert.deepEqual(JSON.parse(JSON.stringify(WS.adapters.jd.extract(item))), {
    platform: 'jd', product_id: '100002143890', product_title: '富光 测试水杯',
    shop_name: '富光FGA京东自营旗舰店', brand_name: '', shop_description: ''
  });
  assert.equal(WS.adapters.jd.imageHost(item), image);
  assert.equal(WS.adapters.jd.identity(item), '["100002143890"]');
});
