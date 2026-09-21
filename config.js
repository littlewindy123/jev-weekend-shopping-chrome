// Fixed official TypeSafe endpoint. No local runtime or alternate provider fallback.
export const MODEL_CONFIG = Object.freeze({
  provider: 'TypeSafe AI',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-1.13.0',
  promptVersion: 'workweek-v4-binary',
});

export const LIMITS = Object.freeze({
  concurrency: 3,
  queue: 80,
  cacheEntries: 1000,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  timeoutMs: 20_000,
  retryBaseMs: 1_500,
  maxInlineRetryMs: 8_000,
});

export const SHOPPING_MATCHES = Object.freeze([
  'https://www.jd.com/*',
  'https://search.jd.com/*',
  'https://list.jd.com/*',
  'https://s.taobao.com/*',
  'https://www.taobao.com/*',
]);

export const STORAGE_KEYS = Object.freeze({
  settings: 'dwsSettings',
  cache: 'dwsCache',
  status: 'dwsStatus',
  cooldown: 'dwsCooldownUntil',
});
