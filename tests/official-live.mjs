import { mkdir, writeFile } from 'node:fs/promises';
import { MODEL_CONFIG } from '../config.js';
import { buildRequest, parseChoice } from '../core.js';

// Opt-in live API check: the credential is read without terminal echo and is
// never placed in a command argument, source file or report. Three billed API
// evaluations use fictional records by default; --product-fallback instead sends
// three public product titles, without shop/account data or full page contents.
function readSecret() {
  if (!process.stdin.isTTY) throw new Error('Run this check in an interactive terminal.');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('TypeSafe API Key (hidden input): ');
  return new Promise((resolve, reject) => {
    let input = '';
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = buffer => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') { finish(); input = ''; reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') {
          const value = input.trim(); input = ''; finish(); resolve(value); return;
        }
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else if (input.length < 512) input += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

const productFallback = process.argv.includes('--product-fallback');
const binaryCheck = process.argv.includes('--binary-check');
const productCases = [
  { id: 'title-brand-anessa', title: '安热沙（Anessa）采销直播间小金瓶防晒霜60mL防晒霜军训专用京东自营' },
  { id: 'title-brand-golf', title: '高尔夫（GOLF）单肩包女士斜挎包男女轻量化ipad手机包学生休闲通勤骑行运动包' },
  { id: 'title-unbranded-soap', title: '炉甘石香皂全身皮肤清洁抑菌止痒沐浴洗澡无激素天然皂男女通用 100%纯度+【强效款】' },
];
const controls = [
  { id: 'single-day', expected: 'no_weekend', description: '虚构店铺明确说明：本店全体员工固定每周工作六天，每周日休息一天，无额外轮休。' },
  { id: 'two-days', expected: 'weekend', description: '虚构店铺明确说明：本店全体员工固定每周工作五天，周六和周日均休息，无周末加班。' },
  { id: 'alternating-days', expected: 'no_weekend', description: '虚构店铺明确说明：本店全体员工实行大小周，每周工作五天和六天交替，不固定双休。' },
];
const cases = binaryCheck ? [...controls, ...productCases] : productFallback ? productCases : controls;
const report = { at: new Date().toISOString(), endpoint: MODEL_CONFIG.endpoint, model: MODEL_CONFIG.model,
  promptVersion: MODEL_CONFIG.promptVersion, simulatedResponses: false,
  records: binaryCheck ? 'fictional-controls-and-public-product-titles' : productFallback ? 'public-product-titles-only' : 'fictional',
  accuracyVerified: false, credentialRecorded: false, modelsEndpointOk: false, cases: [] };
let apiKey = '';
try {
  apiKey = await readSecret();
  if (!apiKey || /[^\x21-\x7E]/.test(apiKey)) throw new Error('Invalid credential input.');
  const modelResponse = await fetch(new URL('/v1/models', MODEL_CONFIG.endpoint), {
    headers: { Authorization: 'Bearer ' + apiKey }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!modelResponse.ok) throw new Error('Official models endpoint returned HTTP ' + modelResponse.status);
  report.modelsEndpointOk = true;
  await modelResponse.body?.cancel();
  for (const item of cases) {
    const product = { platform: 'jd', product_id: '', product_title: item.title || '虚构测试水杯',
      shop_name: item.title ? '' : '虚构测试店铺', brand_name: '', shop_description: item.description || '' };
    const started = performance.now();
    const response = await fetch(MODEL_CONFIG.endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(product)), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Official evaluation endpoint returned HTTP ' + response.status);
    const body = await response.json();
    const choice = parseChoice(body);
    if (body.model !== MODEL_CONFIG.model) throw new Error('Official response used a different model version.');
    const result = { id: item.id, expected: item.expected, actual: choice,
      ...(item.expected ? { matches: choice === item.expected } : { validChoice: true }),
      elapsedMs: Math.round(performance.now() - started), httpStatus: response.status };
    report.cases.push(result);
    console.log(JSON.stringify(result));
  }
  report.success = report.cases.every(item => item.validChoice || item.matches);
  process.exitCode = report.success ? 0 : 1;
} catch (error) {
  report.success = false;
  report.error = error?.message?.startsWith('Official ') ? error.message : 'The live check did not complete; no credential or raw service error was recorded.';
  console.error(report.error);
  process.exitCode = 1;
} finally {
  apiKey = '';
  const folder = new URL('../verification/', import.meta.url);
  await mkdir(folder, { recursive: true });
  const filename = binaryCheck ? 'official-binary-v4.json' : productFallback ? 'official-product-fallback.json' : 'official-live.json';
  await writeFile(new URL(filename, folder), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Saved verification/${filename} without credentials.`);
}
