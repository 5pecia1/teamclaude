import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { CODEX_CREDIT_MAX_AGE_MS } from '../src/codex-credits.js';
import { resolveUpstreamProxy, resetUpstreamProxy, setUpstreamProxy } from '../src/upstream-proxy.js';

const MODEL = 'gpt-5.6-sol';
const HOUR = 60 * 60_000;

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function oauth(name, extra = {}) {
  return {
    name,
    type: 'oauth',
    provider: 'codex',
    accountId: `account-${name}`,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + HOUR,
    ...extra,
  };
}

function creditHeaders(balance) {
  return {
    'x-codex-credits-has-credits': 'True',
    'x-codex-credits-unlimited': 'False',
    'x-codex-credits-balance': String(balance),
  };
}

function setQuota(account, usage) {
  const now = Date.now();
  Object.assign(account.quota, {
    unified5h: usage,
    unified5hSeenAt: now,
    unified5hReset: now + HOUR,
    unified7d: usage,
    unified7dSeenAt: now,
    unified7dReset: now + 7 * 24 * HOUR,
    sessionWindowStated: true,
    weeklyWindowStated: true,
  });
}

function seedBalance(am, balance) {
  am.updateQuota(0, creditHeaders(balance), MODEL, 200);
  setQuota(am.accounts[0], 1);
}

async function startProxy({ responseBalance = 1.25, maxUsage = 0.75, persistCreditState }) {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(200, { 'content-type': 'application/json', ...creditHeaders(responseBalance) });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([oauth('codex', {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    codexCredits: { enabled: true, maxUsage, budgetId: 'budget-1' },
  })], 0.98);
  seedBalance(am, 2);
  am.persistCreditState = persistCreditState;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test-key' } });
  const proxyPort = await listen(proxy);
  return {
    am,
    proxyPort,
    get upstreamCalls() { return upstreamCalls; },
    async close() {
      await close(proxy);
      await close(upstream);
    },
  };
}

async function post(proxyPort, path = '/backend-api/codex/responses') {
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: [], stream: false }),
  });
  await response.text();
  return response.status;
}

test('near-threshold included quota wins before credit fallback while a live probe is due', () => {
  const am = new AccountManager([
    oauth('free'),
    oauth('budget', { codexCredits: { enabled: true, maxUsage: 10, budgetId: 'budget-1' } }),
  ], 0.98);
  setQuota(am.accounts[0], 0.99);
  am.updateQuota(1, creditHeaders(20), MODEL, 200);
  setQuota(am.accounts[1], 1);
  am._nextProbeAt = 0;

  const selected = am.getActiveAccount(null, MODEL, null, null, 'codex');

  assert.equal(selected.name, 'free');
  assert.ok(am._nextProbeAt > Date.now(), 'the due live probe was selected before any credit fallback');
  assert.deepEqual(am._pickFallback(null, MODEL, 'codex'), { account: am.accounts[0], paid: false });
});

test('stale and unknown credit readings cannot authorize paid fallback', () => {
  for (const reading of ['stale', 'unknown']) {
    const am = new AccountManager([oauth('budget', {
      codexCredits: { enabled: true, maxUsage: 10, budgetId: 'budget-1' },
    })], 0.98);
    seedBalance(am, 20);
    if (reading === 'stale') {
      am.accounts[0].quota.codexCredits.seenAt = Date.now() - CODEX_CREDIT_MAX_AGE_MS - 1;
    } else {
      am.updateQuota(0, creditHeaders('not-a-number'), MODEL, 200);
    }
    am._nextProbeAt = 0;

    assert.equal(am._selectProbe(null, MODEL), null, reading);
    assert.equal(am.getActiveAccount(null, MODEL, null, null, 'codex'), null, reading);
  }
});

test('credit budget survives identity-matched restore and counts decreases after downtime', () => {
  const config = [oauth('before-restart', {
    accountId: 'chatgpt-account',
    codexCredits: { enabled: true, maxUsage: 20, budgetId: 'budget-1' },
  })];
  const before = new AccountManager(config, 0.98);
  before.updateQuota(0, creditHeaders(100), MODEL, 200);
  before.updateQuota(0, creditHeaders(94.75), MODEL, 200);
  const saved = before.exportQuotaState();
  assert.equal(saved[0].quota.codexCreditBudget.used, 5.25);
  assert.equal(saved[0].quota.codexCredits, undefined, 'balance readings are refreshed, not restored');

  const after = new AccountManager([oauth('renamed-after-restart', {
    accountId: 'chatgpt-account',
    codexCredits: { enabled: true, maxUsage: 20, budgetId: 'budget-1' },
  })], 0.98);
  after.restoreQuotaState(saved);
  assert.equal(after.accounts[0].quota.codexCreditBudget.used, 5.25);
  assert.equal(after.accounts[0].quota.codexCredits, undefined);

  after.updateQuota(0, creditHeaders(90.25), MODEL, 200);
  assert.equal(after.accounts[0].quota.codexCreditBudget.used, 9.75);
  assert.equal(after.accounts[0].quota.codexCreditBudget.lastBalance, 90.25);
});

test('disk reload toggles and mirrors raw policy without resetting a matching budget id', async () => {
  const raw = oauth('codex', {
    codexCredits: { enabled: true, maxUsage: 10, budgetId: 'budget-1' },
  });
  const disk = { accounts: [{ ...raw, codexCredits: { ...raw.codexCredits } }] };
  const mem = { accounts: [{ ...raw, codexCredits: { ...raw.codexCredits } }] };
  const am = new AccountManager(mem.accounts, 0.98);
  am.updateQuota(0, creditHeaders(25.125), MODEL, 200);
  am.updateQuota(0, creditHeaders(23.5), MODEL, 200);
  assert.equal(am.accounts[0].quota.codexCreditBudget.used, 1.625);

  disk.accounts[0].codexCredits.enabled = false;
  await syncAccountsFromDisk(disk, mem, am);
  assert.deepEqual(am.accounts[0].codexCredits, { enabled: false, maxUsage: 10, budgetId: 'budget-1' });
  assert.deepEqual(mem.accounts[0].codexCredits, disk.accounts[0].codexCredits);
  assert.equal(am.accounts[0].quota.codexCreditBudget.used, 1.625);

  disk.accounts[0].codexCredits = { enabled: true, maxUsage: 2.5, budgetId: 'budget-1' };
  await syncAccountsFromDisk(disk, mem, am);
  assert.deepEqual(am.accounts[0].codexCredits, disk.accounts[0].codexCredits);
  assert.equal(am.accounts[0].quota.codexCreditBudget.used, 1.625);
});

test('paid proxy dispatch requires durable persistence; caps and save failures send nothing', async () => {
  const snapshots = [];
  const harness = await startProxy({
    persistCreditState: async () => snapshots.push(JSON.parse(JSON.stringify(harness.am.exportQuotaState()))),
  });
  try {
    assert.equal(await post(harness.proxyPort), 200);
    assert.equal(harness.upstreamCalls, 1);
    assert.equal(snapshots.length, 1, 'the baseline was saved before paid dispatch');
    assert.equal(snapshots[0][0].quota.codexCreditBudget.used, 0);
    assert.equal(harness.am.accounts[0].quota.codexCreditBudget.used, 0.75);
    assert.deepEqual(harness.am.accounts[0].quota.codexCredits, {
      hasCredits: true,
      unlimited: false,
      balance: 1.25,
      seenAt: harness.am.accounts[0].quota.codexCredits.seenAt,
    });

    assert.equal(
      await post(harness.proxyPort, '/tc-acct/codex/backend-api/codex/responses'),
      429,
      'an explicit pin cannot bypass the reached budget',
    );
    assert.equal(harness.upstreamCalls, 1);
    assert.equal(snapshots.length, 1);
    assert.equal(harness.am._selectProbe(null, MODEL), null, 'the live inference probe cannot bypass the cap');
  } finally {
    await harness.close();
  }

  const failing = await startProxy({
    maxUsage: 5,
    persistCreditState: async () => { throw new Error('state write failed'); },
  });
  try {
    assert.equal(await post(failing.proxyPort), 503);
    assert.equal(failing.upstreamCalls, 0, 'failed persistence denies paid dispatch before contacting the mock');
  } finally {
    await failing.close();
  }
});
