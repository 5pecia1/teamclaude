// A local budget over observed Codex balance decreases, not an upstream billing limit.
export const CODEX_CREDIT_MAX_AGE_MS = 5 * 60_000;

/** @typedef {{enabled: boolean, maxUsage: number, budgetId: string}} CreditPolicy */
/** @typedef {{hasCredits: boolean|null, unlimited: boolean|null, balance: number|null}} CreditReading */
/** @typedef {{budgetId: string, used: number, lastBalance: number, startedAt: number}} CreditBudget */

/** @param {unknown} value */
function decimal(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 1e6 ? n : null;
}

/** @param {unknown} value */
function flag(value) {
  if (value === true || value === 'True' || value === 'true') return true;
  if (value === false || value === 'False' || value === 'false') return false;
  return null;
}

/** Missing and invalid readings must never become a zero balance or unlimited permission.
 * @param {any} raw
 * @returns {CreditReading|null}
 */
export function normalizeCodexCredits(raw) {
  if (raw == null) return null;
  return { hasCredits: flag(raw.has_credits), unlimited: flag(raw.unlimited), balance: decimal(raw.balance) };
}

/** @param {Record<string, string>} headers */
export function parseCodexCredits(headers) {
  const prefix = 'x-codex-credits-';
  if (!['has-credits', 'unlimited', 'balance'].some(key => headers?.[prefix + key] != null)) return null;
  return normalizeCodexCredits({
    has_credits: headers[prefix + 'has-credits'],
    unlimited: headers[prefix + 'unlimited'],
    balance: headers[prefix + 'balance'],
  });
}

/** Invalid configured policies fail closed; an absent policy preserves legacy routing.
 * @param {Record<string, any>} account
 * @returns {CreditPolicy|null}
 */
export function codexCreditPolicy(account) {
  if (account.provider !== 'codex' || account.type !== 'oauth' || account.codexCredits === undefined) return null;
  const raw = account.codexCredits;
  const validLimit = typeof raw?.maxUsage === 'number' && decimal(raw.maxUsage) != null && raw.maxUsage >= 0;
  const validId = typeof raw?.budgetId === 'string' && /^[\w.-]{1,64}$/.test(raw.budgetId);
  return {
    enabled: raw?.enabled === true && validLimit && validId,
    maxUsage: validLimit ? raw.maxUsage : 0,
    budgetId: validId ? raw.budgetId : '',
  };
}

/** @param {any} value @param {string} id @returns {value is CreditBudget} */
export function validCreditBudget(value, id) {
  return value?.budgetId === id && typeof value.used === 'number' && Number.isFinite(value.used) && value.used >= 0
    && typeof value.lastBalance === 'number' && decimal(value.lastBalance) != null
    && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) && value.startedAt > 0;
}

/** @param {Record<string, any>} account @param {CreditReading|null} reading @param {number} [now] */
export function observeCodexCredits(account, reading, now = Date.now()) {
  if (!reading) return;
  const q = account.quota;
  q.codexCredits = { ...reading, seenAt: now };
  const policy = account.codexCredits;
  if (!policy?.budgetId || reading.balance == null) return;
  const previous = q.codexCreditBudget;
  if (!previous || previous.budgetId !== policy.budgetId) {
    q.codexCreditBudget = { budgetId: policy.budgetId, used: 0, lastBalance: reading.balance, startedAt: now };
  } else if (validCreditBudget(previous, policy.budgetId)) {
    // Top-ups never refund local spending. Out-of-order snapshots can overcount,
    // so this is deliberately a conservative balance-decrease budget.
    const decrease = Math.max(0, previous.lastBalance - reading.balance);
    // Round each positive observed decrease up to a micro-unit.
    const usedMicros = Math.round(previous.used * 1e6) + Math.ceil(decrease * 1e6);
    previous.used = usedMicros / 1e6;
    previous.lastBalance = reading.balance;
  }
}

/** @param {unknown} seenAt @param {number} now */
function fresh(seenAt, now) {
  return typeof seenAt === 'number' && seenAt <= now && now - seenAt <= CODEX_CREDIT_MAX_AGE_MS;
}

/** @param {Record<string, any>} account @param {number} [now] */
export function codexCreditsAvailable(account, now = Date.now()) {
  const policy = account.codexCredits;
  const q = account.quota;
  const credits = q.codexCredits;
  const budget = q.codexCreditBudget;
  return policy?.enabled === true && policy.maxUsage > 0
    && validCreditBudget(budget, policy.budgetId) && budget.used < policy.maxUsage
    && credits?.hasCredits === true && credits.unlimited === false
    && typeof credits.balance === 'number' && credits.balance > 0
    && fresh(credits.seenAt, now);
}

/** Only recent, explicitly stated included quota can bypass a credit budget.
 * Unknown model-to-bucket mappings conservatively require every named bucket.
 * @param {Record<string, any>} account @param {string|null} [model] @param {number} [now]
 */
export function codexIncludedQuota(account, model = null, now = Date.now()) {
  const q = account.quota;
  const underLimit = (/** @type {any} */ value, /** @type {any} */ resetAt, /** @type {any} */ seenAt) =>
    typeof value === 'number' && value >= 0 && value < 1 && fresh(seenAt, now)
      && (resetAt == null || (typeof resetAt === 'number' && resetAt > now));
  if (q.unifiedStatus === 'rejected') return false;
  if (q.unified5h == null && q.unified7d == null) return false;
  if (q.unified5h != null ? !underLimit(q.unified5h, q.unified5hReset, q.unified5hSeenAt) : q.sessionWindowStated !== false) return false;
  if (q.unified7d != null ? !underLimit(q.unified7d, q.unified7dReset, q.unified7dSeenAt) : q.weeklyWindowStated !== false) return false;
  const buckets = q.codexModelBuckets || {};
  const slug = model ? q.codexModelLimits?.[model.toLowerCase()] : null;
  const relevant = slug && buckets[slug] ? [buckets[slug]] : Object.values(buckets);
  return relevant.every((/** @type {any} */ b) => underLimit(b.utilization, b.resetAt, b.seenAt));
}
