import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const constantsSrc = readFileSync(
  join(root, 'web/frontend/src/features/futures/futuresConstants.ts'),
  'utf8',
);
const metricsSrc = readFileSync(join(root, 'web/frontend/src/features/futures/useFuturesMetrics.ts'), 'utf8');
const hcSrc = readFileSync(join(root, 'web/frontend/src/components/charts/HighchartsChart.vue'), 'utf8');
const derivativesSrc = readFileSync(join(root, 'web/backend/routes/derivatives.js'), 'utf8');

test('tfToApiParams maps UI pills to ccxt timeframe + limit', () => {
  assert.match(constantsSrc, /export function tfToApiParams/);
  assert.match(constantsSrc, /case '15m':[\s\S]*timeframe: '15m', limit: 96/);
  assert.match(constantsSrc, /case '1h':[\s\S]*timeframe: '1h', limit: 24/);
  assert.match(constantsSrc, /case '1w':[\s\S]*timeframe: '1h', limit: 168/);
  assert.match(constantsSrc, /case '1M':[\s\S]*timeframe: '1h', limit: 720/);
});

test('funding APR multiplier unchanged', () => {
  assert.match(constantsSrc, /FUNDING_APR_MULT = 3 \* 365 \* 100/);
  assert.match(metricsSrc, /FUNDING_APR_MULT/);
});

test('useFuturesMetrics uses dynamic API params (no hardcoded 1h/720 fetch)', () => {
  assert.match(metricsSrc, /tfToApiParams/);
  assert.match(metricsSrc, /apiParams\.value/);
  assert.match(metricsSrc, /watch\(tf, scheduleRefetch\)/);
  assert.doesNotMatch(metricsSrc, /fetchFuturesOhlcvMulti\([^,]+, '1h', 720/);
  assert.doesNotMatch(metricsSrc, /fetchOpenInterestHistory\([^,]+, '1h', 720/);
  assert.doesNotMatch(metricsSrc, /fetchLiquidations\([^,]+, '1h', 720/);
  assert.doesNotMatch(metricsSrc, /fetchFundingRates\([^,]+, 720/);
});

test('volume chart disables stacking; liquidations use colorByPoint', () => {
  assert.match(metricsSrc, /stacking: null/);
  assert.match(metricsSrc, /colorByPoint: true/);
  assert.match(metricsSrc, /Directional volume proxy/);
  assert.match(metricsSrc, /Estimated from volume spikes/);
});

test('Highcharts handles per-point column colors', () => {
  assert.match(hcSrc, /seriesNeedsFullUpdate/);
  assert.match(hcSrc, /pointDataFingerprint/);
});

test('futures-scanner funding uses normalizeFundingTo8h', () => {
  assert.match(
    derivativesSrc,
    /normalizeFundingTo8h\(\[\{ ts: funding\.timestamp \|\| Date\.now\(\), rate: funding\.fundingRate \}\]\)/,
  );
});
