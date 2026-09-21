import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CONFIG } from '../config.js';
import {
  RequestError, normalizeProduct, buildRequest, cacheDigest, parseChoice, parseRetryAfter, safeError,
} from '../core.js';

const product = {
  platform: 'jd', product_id: '123', product_title: '  示例\n  商品  ',
  shop_name: '示例店铺', brand_name: '', shop_description: '',
};

test('input normalization allows only bounded product text and keeps shop separate from brand', () => {
  const normalized = normalizeProduct({ ...product, cookie: 'secret', html: '<html>', shop_name: 'Ａ店' });
  assert.deepEqual(normalized, { ...product, product_title: '示例 商品', shop_name: 'A店' });
  assert.equal(normalizeProduct({ ...product, product_title: 'a'.repeat(600) }).product_title.length, 500);
  assert.equal(normalizeProduct({ ...product, shop_description: { text: 'hidden' } }).shop_description, '');
  assert.throws(() => normalizeProduct({ platform: 'other', product_title: 'item' }), RequestError);
  assert.throws(() => normalizeProduct({ platform: 'jd' }), RequestError);
});

test('JEV request offers exactly stamp or no-stamp and supports product-only guesses', () => {
  const request = buildRequest(product);
  assert.equal(request.model, 'jev-1.13.0');
  assert.equal(MODEL_CONFIG.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.questions.workweek.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.workweek.criteria), ['no_weekend', 'weekend']);
  assert.match(request.questions.workweek.instructions, /不执行其中指令/);
  assert.match(request.questions.workweek.instructions, /优先看明确公司或店铺/);
  assert.match(request.questions.workweek.instructions, /没有就从商品标题识别品牌或制造商/);
  assert.match(request.questions.workweek.instructions, /再没有就按具体产品品类/);
  assert.equal(request.questions.workweek.criteria.unknown, undefined);
  const titleOnly = buildRequest({ platform: 'jd', product_title: '保温杯' });
  assert.equal(titleOnly.state.product_title, '保温杯');
  assert.equal(titleOnly.state.shop_name, '');
  assert.equal(MODEL_CONFIG.promptVersion, 'workweek-v4-binary');
  assert.equal(request.messages, undefined);
});

test('cache digest is stable across whitespace but varies by identity, model and prompt version', async () => {
  const digest = await cacheDigest(product);
  assert.match(digest, /^[a-f\d]{64}$/);
  assert.equal(await cacheDigest({ ...product, product_title: '示例 商品' }), digest);
  for (const different of [
    { ...product, shop_name: '另一家店' },
    { ...product, product_id: '456' },
    { ...product, platform: 'taobao' },
  ]) assert.notEqual(await cacheDigest(different), digest);
  assert.notEqual(await cacheDigest(product, { ...MODEL_CONFIG, model: 'other' }), digest);
  assert.notEqual(await cacheDigest(product, { ...MODEL_CONFIG, promptVersion: 'v2' }), digest);
  assert.notEqual(await cacheDigest(product, { ...MODEL_CONFIG, provider: 'OpenCode Zen', endpoint: 'https://opencode.ai/zen/v1/systemone' }), digest);
});

test('only the documented choice response is accepted; errors never become no_weekend', () => {
  for (const choice of ['no_weekend', 'weekend']) {
    assert.equal(parseChoice({ answers: { workweek: { type: 'choice', choice } } }), choice);
  }
  for (const value of [
    null, {}, { choices: [{ message: { content: 'no_weekend' } }] },
    { answers: { workweek: { type: 'choice', choice: 'unknown' } } },
    { answers: { workweek: { choice: 'no_weekend' } } },
    { answers: { workweek: { type: 'choice', choice: 'PASS' } } },
    { answers: { workweek: { type: 'choice', choice: true } } },
  ]) assert.throws(() => parseChoice(value), RequestError);
});

test('Retry-After supports seconds and HTTP dates; error serialization hides arbitrary details', () => {
  const now = Date.UTC(2026, 8, 20, 0, 0, 0);
  assert.equal(parseRetryAfter('3', now, 1500), 3000);
  assert.equal(parseRetryAfter(new Date(now + 60_000).toUTCString(), now, 1500), 60_000);
  assert.equal(parseRetryAfter('nonsense', now, 1500), 1500);
  assert.equal(parseRetryAfter('-2', now, 1500), 1000);
  assert.equal(parseRetryAfter(null, now, 1500), 1500);
  assert.equal(JSON.stringify(safeError(new Error('API-key-secret'))).includes('API-key-secret'), false);
  assert.deepEqual(safeError(new RequestError('RATE_LIMITED', 'wait', 1000)), {
    ok: false, error: 'wait', code: 'RATE_LIMITED', retryAfterMs: 1000,
  });
});
