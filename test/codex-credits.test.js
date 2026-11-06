import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexCreditPolicy, normalizeCodexCredits, parseCodexCredits, observeCodexCredits, codexCreditsAvailable, codexIncludedQuota, CODEX_CREDIT_MAX_AGE_MS } from '../src/codex-credits.js';

const policy = { enabled: true, maxUsage: 10, budgetId: 'first' };
const reading = balance => ({ hasCredits: true, unlimited: false, balance });
const account = () => ({ codexCredits: { ...policy }, quota: {} });

test('credit policy requires Codex OAuth, a literal opt-in, a finite budget and an explicit id', () => {
  const input = { provider: 'codex', type: 'oauth', codexCredits: policy };
  assert.deepEqual(codexCreditPolicy(input), policy);
  assert.equal(codexCreditPolicy({ ...input, provider: 'anthropic' }), null);
  assert.equal(codexCreditPolicy({ ...input, type: 'apikey' }), null);
  assert.equal(codexCreditPolicy({ provider: 'codex', type: 'oauth' }), null);
  for (const raw of [null, false, {}, { ...policy, enabled: 'true' }, { ...policy, maxUsage: -1 }, { ...policy, maxUsage: Infinity }, { ...policy, maxUsage: '10' }, { ...policy, budgetId: '' }]) {
    assert.equal(codexCreditPolicy({ ...input, codexCredits: raw }).enabled, false);
  }
});

test('headers and usage payloads parse the same balance without coercing missing values', () => {
  const expected = reading(19.25);
  assert.deepEqual(normalizeCodexCredits({ has_credits: true, unlimited: false, balance: '19.25' }), expected);
  assert.deepEqual(parseCodexCredits({ 'x-codex-credits-has-credits': 'True', 'x-codex-credits-unlimited': 'False', 'x-codex-credits-balance': '19.25' }), expected);
  assert.equal(parseCodexCredits({}), null);
  for (const balance of [null, undefined, '', ' ', '0x10', 'NaN', Infinity, {}, true]) {
    assert.equal(normalizeCodexCredits({ balance }).balance, null);
  }
  assert.equal(normalizeCodexCredits({ balance: '-1.5' }).balance, -1.5);
});

test('observed decreases accumulate; top-ups, disable/re-enable and a limit edit do not refund usage', () => {
  const a = account();
  const now = Date.now();
  observeCodexCredits(a, reading(100), now);
  observeCodexCredits(a, reading(96), now);
  observeCodexCredits(a, reading(120), now);
  assert.equal(a.quota.codexCreditBudget.used, 4);
  a.codexCredits.enabled = false;
  observeCodexCredits(a, reading(118), now);
  a.codexCredits.enabled = true;
  assert.equal(a.quota.codexCreditBudget.used, 6);
  assert.equal(codexCreditsAvailable(a, now), true);
  observeCodexCredits(a, reading(114), now);
  assert.equal(codexCreditsAvailable(a, now), false);
  a.codexCredits.maxUsage = 11;
  assert.equal(codexCreditsAvailable(a, now), true);
  a.codexCredits.budgetId = 'second';
  assert.equal(codexCreditsAvailable(a, now), false, 'new id requires a new observation');
  observeCodexCredits(a, reading(114), now);
  assert.equal(a.quota.codexCreditBudget.used, 0);
});

test('small positive decreases round up to one micro-unit and equal readings add nothing', () => {
  const a = account();
  a.codexCredits.maxUsage = 0.000001;
  const now = Date.now();
  observeCodexCredits(a, reading(1), now);
  observeCodexCredits(a, reading(0.9999999), now);
  assert.ok(a.quota.codexCreditBudget.used >= 0.000001);
  assert.equal(codexCreditsAvailable(a, now), false);

  observeCodexCredits(a, reading(0.9999999), now);
  assert.equal(a.quota.codexCreditBudget.used, 0.000001);
  assert.equal(codexCreditsAvailable(a, now), false);
});

test('unknown, nonnumeric, unlimited, depleted and stale balances never authorize paid usage', () => {
  const now = Date.now();
  for (const r of [reading(null), reading(0), reading(-2), { ...reading(100), hasCredits: false }, { ...reading(100), unlimited: true }, { ...reading(100), unlimited: null }]) {
    const a = account();
    observeCodexCredits(a, r, now);
    assert.equal(codexCreditsAvailable(a, now), false);
  }
  const a = account();
  observeCodexCredits(a, reading(100), now);
  assert.equal(codexCreditsAvailable(a, now + CODEX_CREDIT_MAX_AGE_MS + 1), false);
  assert.equal(codexCreditsAvailable(a, now - 1), false);
  a.quota.codexCreditBudget.used = NaN;
  observeCodexCredits(a, reading(100), now);
  assert.equal(codexCreditsAvailable(a, now), false, 'corruption must not silently reset spending');
});

test('only fresh included quota permits requests independently of a paid budget', () => {
  const a = account();
  const now = Date.now();
  assert.equal(codexIncludedQuota(a, null, now), false);
  Object.assign(a.quota, { sessionWindowStated: false, unified7d: 0.5, unified7dSeenAt: now, unified7dReset: now + 3600_000 });
  assert.equal(codexIncludedQuota(a, null, now), true);
  a.quota.codexModelBuckets = { spark: { utilization: 1, seenAt: now, resetAt: now + 3600_000 } };
  assert.equal(codexIncludedQuota(a, 'unknown-model', now), false);
  a.quota.codexModelBuckets.spark.utilization = 0.1;
  assert.equal(codexIncludedQuota(a, null, now), true);
  assert.equal(codexIncludedQuota(a, null, now + CODEX_CREDIT_MAX_AGE_MS + 1), false);
  a.quota.unified7d = 1;
  assert.equal(codexIncludedQuota(a, null, now), false);
});
