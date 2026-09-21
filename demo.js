(() => {
  'use strict';
  const WS = window.WeekendShopping;
  const grid = document.querySelector('#products');
  const feedback = document.querySelector('#feedback');
  const enabled = document.querySelector('#demo-enabled');
  const errors = document.querySelector('#demo-error');
  const scenarios = new Map();
  let sequence = 0;
  let requests = 0;
  const goods = [
    ['磨砂陶瓷杯 · 给周末一点留白', '慢丘生活实验店', '慢丘', 'cup', '#e8e5d8', '49', 'no_weekend'],
    ['轻量无线耳机 · 听见自己的节奏', '回声样本店', '回声', 'headphones', '#e0e5db', '199', 'weekend'],
    ['蘑菇小夜灯 · 温柔照亮一个角落', '晚风虚构家居店', '晚风', 'lamp', '#eee1d3', '129', 'weekend'],
    ['桌面绿植盆 · 和自然待一会儿', '一叶模拟花房', '一叶', 'plant', '#e5e8de', '39', 'no_weekend'],
    ['手冲分享壶 · 不赶时间的咖啡', '慢丘生活实验店', '慢丘', 'pot', '#e9e2d5', '89', 'weekend'],
    ['日常帆布袋 · 装下周末的自由', '空白虚构织物店', '空白', 'bag', '#e5e1d9', '59', 'weekend']
  ];
  function art(type) {
    const shapes = {
      cup: '<ellipse cx="120" cy="178" rx="64" ry="9" fill="#b9b4a2" opacity=".25"/><path d="M158 83h16c39 0 39 57 0 57h-15" fill="none" stroke="#bdbfa9" stroke-width="14"/><path d="M62 68h102l-9 104q-43 21-84 0z" fill="#bdc2aa"/><ellipse cx="113" cy="68" rx="51" ry="13" fill="#d3d6c0"/><ellipse cx="113" cy="69" rx="42" ry="8" fill="#7f8c72"/><path d="M80 87l4 70" stroke="#d5d9c5" stroke-width="5" opacity=".6"/>',
      headphones: '<ellipse cx="120" cy="186" rx="64" ry="8" fill="#a4b09f" opacity=".2"/><path d="M58 139V96a62 62 0 0 1 124 0v43" fill="none" stroke="#52634f" stroke-width="16"/><path d="M61 105V91a59 59 0 0 1 118 0v14" fill="none" stroke="#a2af99" stroke-width="7"/><rect x="46" y="111" width="37" height="65" rx="17" fill="#71806a"/><rect x="157" y="111" width="37" height="65" rx="17" fill="#71806a"/><rect x="68" y="116" width="17" height="54" rx="8" fill="#a5af9a"/><rect x="155" y="116" width="17" height="54" rx="8" fill="#a5af9a"/>',
      lamp: '<ellipse cx="120" cy="187" rx="65" ry="8" fill="#a8846d" opacity=".2"/><path d="M105 96h30l9 74q-24 15-48 0z" fill="#d6b398"/><ellipse cx="120" cy="173" rx="44" ry="10" fill="#c29b7d"/><path d="M44 105a76 72 0 0 1 152 0z" fill="#c88867"/><ellipse cx="120" cy="105" rx="76" ry="12" fill="#efd3ad"/><path d="M69 79q18-33 45-34" fill="none" stroke="#dea285" stroke-width="5" stroke-linecap="round"/>',
      plant: '<ellipse cx="120" cy="191" rx="53" ry="8" fill="#a2ae95" opacity=".2"/><path d="M84 129h72l-10 58H94z" fill="#c2b498"/><ellipse cx="120" cy="129" rx="36" ry="9" fill="#aa987b"/><path d="M119 138V68M118 106L86 87M120 113l37-33" fill="none" stroke="#647d50" stroke-width="5"/><ellipse cx="99" cy="67" rx="17" ry="30" transform="rotate(-35 99 67)" fill="#788e5e"/><ellipse cx="144" cy="58" rx="16" ry="31" transform="rotate(29 144 58)" fill="#637c52"/><ellipse cx="81" cy="98" rx="14" ry="28" transform="rotate(-56 81 98)" fill="#96a478"/><ellipse cx="152" cy="99" rx="16" ry="28" transform="rotate(42 152 99)" fill="#7c9369"/>',
      pot: '<ellipse cx="120" cy="186" rx="60" ry="8" fill="#b6a690" opacity=".2"/><path d="M147 90h24q31 30-3 56h-15" fill="none" stroke="#af8b67" stroke-width="11"/><path d="M91 60h49v32l26 61q9 32-47 32t-53-32l25-61z" fill="#e4d4b6" stroke="#bba082" stroke-width="3"/><path d="M75 137h83l8 22q5 26-47 26t-51-25z" fill="#a88762"/><path d="M96 75v28l-17 47" fill="none" stroke="#f5e9cf" stroke-width="5"/>',
      bag: '<ellipse cx="120" cy="188" rx="65" ry="8" fill="#a79d86" opacity=".2"/><path d="M89 87V63q0-40 31-40t31 40v24" fill="none" stroke="#afa488" stroke-width="10"/><path d="M60 79h120l9 99q-66 17-138 0z" fill="#d0c6ac"/><path d="M71 88l-5 80M170 88l5 80" stroke="#e3dbc6" stroke-width="3"/><text x="120" y="135" text-anchor="middle" font-size="12" fill="#7c8167" font-family="Georgia">WEEKEND</text>'
    };
    return `<svg viewBox="0 0 240 220" aria-hidden="true">${shapes[type]}</svg>`;
  }
  function makeCard(index) {
    const good = goods[index % goods.length];
    const id = `fiction-${++sequence}`;
    scenarios.set(id, good[6]);
    const article = document.createElement('article');
    article.className = 'product';
    article.setAttribute('data-dw-product', '');
    article.dataset.productId = id;
    article.innerHTML = `<a href="#${id}"><div data-dw-image class="product-image" style="background:${good[4]}">${art(good[3])}</div><div class="product-meta"><span data-dw-brand>${good[2]}</span><span>虚构 / ${String(sequence).padStart(2, '0')}</span></div><h3 data-dw-title class="product-title">${good[0]}</h3></a><p data-dw-shop class="product-shop">${good[1]}</p><p data-dw-desc class="product-desc">用于交互测试的虚构店铺资料</p><div class="product-bottom"><span class="price"><small>¥</small>${good[5]}</span><span class="scenario">预设：${{no_weekend:'可能非双休',weekend:'双休',unknown:'不确定'}[good[6]]}</span></div>`;
    article.querySelector('a').addEventListener('click', (event) => {
      event.preventDefault();
      const clickedCard = event.currentTarget.closest('[data-dw-product]');
      feedback.textContent = `商品点击正常：${clickedCard.querySelector('[data-dw-title]').textContent}。印章没有拦截点击。`;
    });
    return article;
  }
  function append(count = 6) {
    const start = grid.children.length;
    for (let i = 0; i < count; i++) grid.append(makeCard(start + i));
  }
  append(12);
  const controller = WS.createController({
    root: document,
    adapter: WS.adapters.demo,
    demo: true,
    getState: async () => ({ enabled: enabled.checked, configured: true }),
    classify: async (product) => {
      document.querySelector('#requests').textContent = String(++requests);
      const fail = errors.checked;
      const choice = scenarios.get(product.product_id) || 'weekend';
      await new Promise(resolve => setTimeout(resolve, 480));
      return fail ? { ok: false, error: '模拟网络错误', code: 'NETWORK' } : { ok: true, choice };
    }
  });
  enabled.addEventListener('change', () => {
    controller.setState({ enabled: enabled.checked, configured: true });
    feedback.textContent = enabled.checked ? '模拟盖章已开启。' : '模拟盖章已暂停，印章已移除。';
  });
  errors.addEventListener('change', () => {
    feedback.textContent = errors.checked ? '之后的新请求将模拟失败，不会盖章；已有判断保持不变。追加商品即可测试。' : '已恢复模拟响应。追加商品或关闭再开启以重试。';
  });
  document.querySelector('#append').addEventListener('click', () => { append(); feedback.textContent = '已追加 6 件虚构商品，滚动到它们的位置即可判断。'; });
  document.querySelector('#replace').addEventListener('click', () => {
    const current = grid.firstElementChild;
    const replacement = makeCard(1);
    current.dataset.productId = replacement.dataset.productId;
    current.replaceChildren(...replacement.childNodes);
    feedback.textContent = '首张卡片已复用为新的“不确定”商品，旧 PASS 应立即消失。';
  });
  const counter = new MutationObserver(() => {
    document.querySelector('#stamps').textContent = String(grid.querySelectorAll('[data-dw-stamp], .dw-stamp').length);
  });
  counter.observe(grid, { childList: true, subtree: true });
  const more = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && grid.children.length < 36) append();
  });
  more.observe(document.querySelector('#sentinel'));
})();
