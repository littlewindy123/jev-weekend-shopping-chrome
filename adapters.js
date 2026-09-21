/* JD homepage/new search selectors were inspected on 2026-09-21; Taobao remains conservative. */
(() => {
  'use strict';
  const WS = globalThis.WeekendShopping = globalThis.WeekendShopping || {};
  const clean = (value, limit = 320) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const genericShop = /^(?:自营|京东自营|官方自营|淘宝|天猫)$/;

  function text(card, selectors, limit) {
    for (const selector of selectors) {
      for (const node of card.querySelectorAll(selector)) {
        // innerText reads rendered text; textContent could include hidden seller/account data.
        if (node.closest('[data-dw-owned]') || !node.getClientRects().length ||
          node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
        const value = clean(node.innerText, limit);
        if (value) return value;
      }
    }
    return '';
  }

  const productLinks = platform => platform === 'jd' ? 'a[href*="item.jd.com/"]'
    : platform === 'taobao' ? 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]' : 'a[href]';

  function linkedId(card, platform) {
    const selector = productLinks(platform);
    const anchor = card.matches(selector) ? card : card.querySelector(selector);
    if (!anchor) return '';
    try {
      const url = new URL(anchor.getAttribute('href'), card.ownerDocument.location.href);
      if (platform === 'jd' && /(^|\.)jd\.com$/.test(url.hostname)) {
        return clean(url.pathname.match(/\/(\d+)\.html/)?.[1], 120);
      }
      if (platform === 'taobao' && /(^|\.)(?:taobao|tmall)\.com$/.test(url.hostname)) {
        return clean(url.searchParams.get('id'), 120);
      }
    } catch { /* Malformed/missing links do not create a product identity. */ }
    return '';
  }

  function findCards(root, selector) {
    const candidates = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    const unique = [...new Set(candidates)].filter(node => !node.closest('[data-dw-owned]'));
    const set = new Set(unique);
    return unique.filter(node => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (set.has(parent)) return false;
      }
      return true;
    });
  }

  function adapter(name, selector, fields, imageSelector, idAttributes) {
    return {
      name,
      cardSelector: selector,
      findCards: root => findCards(root, selector),
      identity(card) {
        const linksSelector = productLinks(name);
        const links = [...(card.matches(linksSelector) ? [card] : []), ...card.querySelectorAll(linksSelector)];
        return JSON.stringify([...idAttributes.map(attr => card.getAttribute(attr)), ...links.map(link => link.getAttribute('href'))]);
      },
      extract(card) {
        const product_title = text(card, fields.title, 320);
        if (!product_title) return null;
        const shop = text(card, fields.shop, 160);
        return {
          platform: name,
          product_id: clean(idAttributes.map(attr => card.getAttribute(attr)).find(Boolean), 120) || linkedId(card, name),
          product_title,
          shop_name: genericShop.test(shop) ? '' : shop,
          brand_name: text(card, fields.brand, 100),
          shop_description: text(card, fields.desc, 240)
        };
      },
      imageHost(card) {
        const host = card.querySelector(imageSelector);
        if (host) return host;
        return card.querySelector('img')?.parentElement || null;
      }
    };
  }

  const jdLegacy = adapter('jd', '.gl-item[data-sku]', {
      title: ['.p-name em', '.p-name'],
      shop: ['.p-shop a', '.p-shop'],
      brand: ['.p-brand'],
      desc: ['.p-shop-description']
  }, '.p-img', ['data-sku']);
  const jdHome = adapter('jd', '.more2_item_good', {
    title: ['.more2_info_name'], shop: [], brand: [], desc: []
  }, '.more2_img', []);
  const jdSearch = adapter('jd', '.plugin_goodsCardWrapper[data-sku]', {
    title: ['[class*="_goods_title_container_"] span[title]', '[class*="_goods_title_container_"]'],
    shop: ['[class*="_name_3z0zc_"]'], brand: [], desc: []
  }, '[class*="_bannerPicBox_"]', ['data-sku']);
  const jdVariant = card => card.matches(jdSearch.cardSelector) ? jdSearch
    : card.matches(jdHome.cardSelector) ? jdHome : jdLegacy;
  const jdSelector = [jdLegacy.cardSelector, jdHome.cardSelector, jdSearch.cardSelector].join(', ');

  WS.adapters = {
    jd: {
      name: 'jd', cardSelector: jdSelector,
      findCards: root => findCards(root, jdSelector),
      extract: card => jdVariant(card).extract(card),
      identity: card => jdVariant(card).identity(card),
      imageHost: card => jdVariant(card).imageHost(card)
    },
    taobao: adapter('taobao', 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"], .item.J_MouserOnverReq[data-nid]', {
      title: ['[class*="Title--title"]', '[class*="Title--"]', '[class*="title--"]', '.title'],
      shop: ['[class*="ShopInfo--shopName"]', '[class*="shopName"]', '.shop .shopname', '.shop .J_ShopInfo'],
      brand: ['[class*="brandName"]', '.brand-name'],
      desc: ['[class*="shopDescription"]', '.shop-description']
    }, '[class*="MainPic--mainPicWrapper"], [class*="MainPic--mainPic"], .pic', ['data-nid', 'data-item-id']),
    demo: adapter('demo', '[data-dw-product]', {
      title: ['[data-dw-title]'],
      shop: ['[data-dw-shop]'],
      brand: ['[data-dw-brand]'],
      desc: ['[data-dw-desc]']
    }, '[data-dw-image]', ['data-product-id'])
  };

  WS.detectAdapter = hostname => {
    if (['www.jd.com', 'search.jd.com', 'list.jd.com'].includes(hostname)) return WS.adapters.jd;
    if (['s.taobao.com', 'www.taobao.com'].includes(hostname)) return WS.adapters.taobao;
    return null;
  };
  WS.fingerprint = product => JSON.stringify([
    product.platform, product.product_id, product.product_title,
    product.shop_name, product.brand_name, product.shop_description
  ]);
})();
