// Server-only bot engine. Talks to h5.parttime.mobi and Telegram.
// Imported only by server function handlers and the public cron route handler.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://h5.parttime.mobi/prod-api";

export type BotUser = {
  id: string;
  slot: number;
  label: string;
  username: string;
  password: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  min_price: number;
  max_price: number;
  payment_methods: string[];
  polling_interval_ms: number;
  cooldown_seconds: number;
  is_active: boolean;
  auth_token: string | null;
  auth_token_at: string | null;
  status: string;
  status_message: string;
  last_polled_at: string | null;
  orders_grabbed: number;
  seen_order_ids: string[];
};

export async function log(
  user_id: string | null,
  slot: number | null,
  level: "info" | "success" | "warn" | "error",
  message: string,
  meta?: unknown,
) {
  try {
    await supabaseAdmin.from("bot_logs").insert({
      user_id,
      slot,
      level,
      message,
      meta: (meta ?? null) as never,
    });
  } catch (e) {
    console.error("log insert failed", e);
  }
}

export async function setStatus(
  id: string,
  status: string,
  status_message = "",
  extra: Record<string, unknown> = {},
) {
  await supabaseAdmin
    .from("bot_users")
    .update({ status, status_message, ...extra })
    .eq("id", id);
}

export async function sendTelegram(
  bot_token: string,
  chat_id: string,
  text: string,
  parse_mode: "HTML" | "Markdown" = "HTML",
): Promise<{ ok: boolean; error?: string }> {
  if (!bot_token || !chat_id) return { ok: false, error: "Missing Telegram bot token or chat id" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.description || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ----- Global admin Telegram (cached briefly) -----
type AdminTg = { bot_token: string; chat_id: string };
let adminTgCache: { val: AdminTg; at: number } | null = null;
const ADMIN_TG_TTL_MS = 15_000;

export async function getAdminTelegram(force = false): Promise<AdminTg> {
  if (!force && adminTgCache && Date.now() - adminTgCache.at < ADMIN_TG_TTL_MS) return adminTgCache.val;
  const { data } = await supabaseAdmin
    .from("app_config")
    .select("admin_telegram_bot_token, admin_telegram_chat_id")
    .eq("id", 1)
    .maybeSingle();
  const val: AdminTg = {
    bot_token: ((data as { admin_telegram_bot_token?: string } | null)?.admin_telegram_bot_token) || "",
    chat_id: ((data as { admin_telegram_chat_id?: string } | null)?.admin_telegram_chat_id) || "",
  };
  adminTgCache = { val, at: Date.now() };
  return val;
}

export function invalidateAdminTelegramCache() {
  adminTgCache = null;
}

/**
 * DUAL-LAYER Telegram routing. Used ONLY for the three allowed order events:
 * [ORDER GRABBED CONFIRMED], [ORDER SKIPPED], [ORDER DETECTED BUT MISSED].
 * Never invoked for cooldown / hit-success / polling status.
 */
export async function sendDualTelegram(
  u: Pick<BotUser, "slot" | "label" | "username" | "telegram_bot_token" | "telegram_chat_id">,
  text: string,
  parse_mode: "HTML" | "Markdown" = "HTML",
): Promise<void> {
  if (u.telegram_bot_token && u.telegram_chat_id) {
    void sendTelegram(u.telegram_bot_token, u.telegram_chat_id, text, parse_mode);
  }
  const admin = await getAdminTelegram();
  if (admin.bot_token && admin.chat_id) {
    const tag =
      parse_mode === "HTML"
        ? `📡 <b>[SLOT ${String(u.slot).padStart(2, "0")} · ${u.label || u.username || "—"}]</b>\n`
        : `📡 *[SLOT ${String(u.slot).padStart(2, "0")} · ${u.label || u.username || "—"}]*\n`;
    void sendTelegram(admin.bot_token, admin.chat_id, tag + text, parse_mode);
  }
}

export async function loginUser(u: BotUser): Promise<string | null> {
  const r = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u.username, password: u.password }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: string; code?: number; msg?: string };
  if (j.token) {
    await supabaseAdmin
      .from("bot_users")
      .update({
        auth_token: j.token,
        auth_token_at: new Date().toISOString(),
        status: "running",
        status_message: "Authorized / Running",
      })
      .eq("id", u.id);
    await log(u.id, u.slot, "success", "Login OK, token refreshed");
    return j.token;
  }
  const msg = (j.msg || "").toLowerCase();
  if (msg.includes("password") || msg.includes("user") || j.code === 500) {
    await setStatus(u.id, "invalid_creds", "Invalid Username or Password");
    await log(u.id, u.slot, "error", `Login failed: ${j.msg || "unknown"}`);
  } else if (msg.includes("ban") || msg.includes("forbid") || msg.includes("permission") || j.code === 403) {
    await setStatus(u.id, "suspended", "No Permission / Account Suspended");
    await log(u.id, u.slot, "error", `Login forbidden: ${j.msg || "unknown"}`);
  } else {
    await setStatus(u.id, "error", j.msg || `HTTP ${r.status}`);
    await log(u.id, u.slot, "error", `Login error: ${j.msg || r.status}`);
  }
  return null;
}

/**
 * Mobile signature + KEEP-ALIVE / NO-CACHE headers. The Worker fetch runtime
 * pools sockets transparently when Connection: keep-alive is sent, reusing the
 * same TCP connection for back-to-back requests against the same origin and
 * blinding the per-connection firewall counter for this slot's burst.
 */
const MOBILE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=utf-8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://h5.parttime.mobi",
  Referer: "https://h5.parttime.mobi/",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
  "Sec-Ch-Ua": '"Chromium";v="139", "Not;A=Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?1",
  "Sec-Ch-Ua-Platform": '"Android"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Connection: "keep-alive",
  "Keep-Alive": "timeout=60, max=1000",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

const perUserCooldownUntil = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasTooManyRequests(payload: unknown, error?: string): boolean {
  const haystack = [error, typeof payload === "string" ? payload : JSON.stringify(payload ?? {})]
    .filter(Boolean)
    .join(" ");
  return /too many requests/i.test(haystack);
}

/**
 * Explicit "order is gone / taken by someone else" detection. Only these
 * messages allow the aggressive grab loop to break.
 */
function isOrderGoneMessage(msg: string | undefined, code: number | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    /already\s*(received|claimed|taken|grabbed|accept)/.test(m) ||
    /has\s*been\s*(received|claimed|taken|grabbed)/.test(m) ||
    /received\s*by/.test(m) ||
    /no\s*longer\s*available/.test(m) ||
    /not\s*exist|does\s*not\s*exist|order\s*not\s*found/.test(m) ||
    /已被领取|已被抢|已被接|订单不存在|已领取|已被他人/.test(msg) ||
    code === 404
  );
}

/**
 * STRICT execution lock per slot for `cooldown_seconds` (user-editable).
 * No HTTP requests are issued during the lock. NO Telegram notifications.
 */
async function applyRateLimitCooldown(u: BotUser): Promise<void> {
  const secs = Math.max(1, Math.round(u.cooldown_seconds || 10));
  const duration = secs * 1000;
  perUserCooldownUntil.set(u.id, Date.now() + duration);
  await setStatus(u.id, "cooldown", `Cooling down ${secs}s (rate limit)`);
  await log(
    u.id,
    u.slot,
    "error",
    `[Firewall Blocked] - Too Many Requests - Entering Cooldown for ${secs} Seconds`,
  );
}

// ============================================================================
// MULTI-SESSION ROTATION ENGINE (10 parallel tokens, pre-emptive hot-swap)
// ============================================================================
const POOL_SIZE = 10;
const POOL_HIT_LIMIT = 5;
const TOKEN_COOLDOWN_MS = 30_000;

type PoolToken = { token: string; hits: number; cooldownUntil: number; index: number };

const tokenPools = new Map<string, PoolToken[]>();
const currentIndex = new Map<string, number>();
const poolBuilding = new Map<string, Promise<PoolToken[] | null>>();

export function clearTokenPool(userId: string): void {
  tokenPools.delete(userId);
  currentIndex.delete(userId);
  poolBuilding.delete(userId);
  perUserCooldownUntil.delete(userId);
  sessionStartedAt.delete(userId);
  lastHealthyAt.delete(userId);
  sessionEpoch.delete(userId);
}

// ============================================================================
// ACTIVE SESSION HEALTH MONITOR — proactive 7-minute session recycle
// ----------------------------------------------------------------------------
// The upstream/worker session degrades silently after roughly 8-10 minutes:
// sockets go stale, pooled tokens stop returning data and the loop freezes.
// Instead of waiting for the thread to die, every session is age-checked on
// every tick and PROACTIVELY torn down at the 7-minute mark (or earlier if it
// has not produced a healthy response within the stall window). The teardown
// flushes tokens, cooldown locks, the shared list-gate chain and the cached
// admin config, bumps the session epoch (which rotates connection headers so
// the runtime opens brand-new sockets), then rebuilds a fresh token pool —
// functionally identical to a manual version revert, but automatic.
// ============================================================================
const SESSION_MAX_AGE_MS = 7 * 60 * 1000; // proactive recycle at 7 minutes
const SESSION_STALL_MS = 90 * 1000; // no healthy response for 90s => frozen

const sessionStartedAt = new Map<string, number>();
const lastHealthyAt = new Map<string, number>();
const sessionEpoch = new Map<string, number>();

/** Called after every successful (HTTP 200) poll so the watchdog sees liveness. */
export function markSessionHealthy(userId: string): void {
  lastHealthyAt.set(userId, Date.now());
}

/** Fresh header set per session epoch — forces new sockets after a recycle. */
function mobileHeaders(userId: string): Record<string, string> {
  const epoch = sessionEpoch.get(userId) ?? 0;
  return {
    ...MOBILE_HEADERS,
    "X-Session-Epoch": String(epoch),
    "X-Request-Id": `${epoch}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  };
}

/**
 * DEEP CLEAN + RESTART. Flushes every stuck in-memory buffer tied to this slot,
 * rotates connection headers, and re-initializes a fresh polling session.
 */
async function recycleSession(u: BotUser, reason: string): Promise<void> {
  const epoch = (sessionEpoch.get(u.id) ?? 0) + 1;
  await log(
    u.id,
    u.slot,
    "warn",
    `[SESSION HEALTH] ${reason} — flushing tokens/sockets and re-initializing a fresh session (epoch #${epoch}).`,
  );

  // 1. Deep clean: drop all per-slot memory buffers.
  tokenPools.delete(u.id);
  currentIndex.delete(u.id);
  poolBuilding.delete(u.id);
  perUserCooldownUntil.delete(u.id);

  // 2. Reset shared outbound gate so a wedged chain can't block the new loop.
  listGateChain = Promise.resolve();
  listLastAt = 0;

  // 3. Rotate headers / invalidate caches so new sockets + fresh config are used.
  sessionEpoch.set(u.id, epoch);
  invalidateAdminTelegramCache();

  // 4. Clear the stored token so single-session fallback re-logins cleanly.
  try {
    await supabaseAdmin
      .from("bot_users")
      .update({ auth_token: null, auth_token_at: null })
      .eq("id", u.id);
  } catch {
    /* non-fatal */
  }

  // 5. Fresh session clock, then rebuild the pool immediately.
  sessionStartedAt.set(u.id, Date.now());
  lastHealthyAt.set(u.id, Date.now());

  const rebuilt = await buildTokenPool(u);
  await log(
    u.id,
    u.slot,
    rebuilt ? "success" : "error",
    rebuilt
      ? `[SESSION HEALTH] Auto-reconnect complete — ${rebuilt.length} fresh tokens live. Polling resumed.`
      : `[SESSION HEALTH] Auto-reconnect could not rebuild the token pool; falling back to single-session login.`,
  );
}

/**
 * Active health check, evaluated on every tick. Returns true when a recycle
 * was performed (the caller should skip this tick, the next one runs fresh).
 */
async function healthGate(u: BotUser): Promise<boolean> {
  const now = Date.now();
  const started = sessionStartedAt.get(u.id);
  if (!started) {
    sessionStartedAt.set(u.id, now);
    lastHealthyAt.set(u.id, now);
    if (!sessionEpoch.has(u.id)) sessionEpoch.set(u.id, 1);
    return false;
  }

  const age = now - started;
  const idle = now - (lastHealthyAt.get(u.id) ?? now);

  if (age >= SESSION_MAX_AGE_MS) {
    await recycleSession(
      u,
      `Session age ${Math.round(age / 1000)}s reached the 7-minute proactive refresh mark`,
    );
    return true;
  }
  if (idle >= SESSION_STALL_MS) {
    await recycleSession(u, `No healthy response for ${Math.round(idle / 1000)}s (frozen session detected)`);
    return true;
  }
  return false;
}


async function rawLogin(u: BotUser): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u.username, password: u.password }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string };
    return j.token || null;
  } catch {
    return null;
  }
}

async function buildTokenPool(u: BotUser): Promise<PoolToken[] | null> {
  const existing = poolBuilding.get(u.id);
  if (existing) return existing;
  const p = (async () => {
    const tokens: PoolToken[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const t = await rawLogin(u);
      if (t) tokens.push({ token: t, hits: 0, cooldownUntil: 0, index: tokens.length + 1 });
      await sleep(150);
    }
    if (tokens.length === 0) return null;
    tokenPools.set(u.id, tokens);
    currentIndex.set(u.id, 0);
    await log(
      u.id,
      u.slot,
      "success",
      `[ENGINE STATUS] - Multi-Session pool initialized: ${tokens.length}/${POOL_SIZE} tokens ready.`,
    );
    return tokens;
  })();
  poolBuilding.set(u.id, p);
  try {
    return await p;
  } finally {
    poolBuilding.delete(u.id);
  }
}

function pickHealthyToken(userId: string): PoolToken | null {
  const pool = tokenPools.get(userId);
  if (!pool || pool.length === 0) return null;
  const now = Date.now();
  const start = currentIndex.get(userId) ?? 0;
  for (let i = 0; i < pool.length; i++) {
    const pos = (start + i) % pool.length;
    if (pool[pos].cooldownUntil <= now) {
      currentIndex.set(userId, pos);
      return pool[pos];
    }
  }
  return null;
}

function nextHealthyIndex(userId: string, current: PoolToken): number | null {
  const pool = tokenPools.get(userId);
  if (!pool) return null;
  const start = pool.findIndex((p) => p === current);
  const now = Date.now();
  for (let i = 1; i <= pool.length; i++) {
    const cand = pool[(start + i) % pool.length];
    if (cand.cooldownUntil <= now) return cand.index;
  }
  return null;
}

function focusIndex(userId: string, tokenIndex: number): void {
  const pool = tokenPools.get(userId);
  if (!pool) return;
  const pos = pool.findIndex((p) => p.index === tokenIndex);
  if (pos >= 0) currentIndex.set(userId, pos);
}

// ---- Global outbound request throttle (list endpoint) ----
// The upstream rate-limits by IP, and all slots share the worker's IP.
// Serialize list fetches with a minimum gap so N concurrent slots never
// burst the server. Receive (grab) requests intentionally bypass this so
// a detected order still gets an aggressive burst.
const LIST_MIN_GAP_MS = 400;
let listGateChain: Promise<void> = Promise.resolve();
let listLastAt = 0;
function acquireListSlot(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  const wait = listGateChain.then(async () => {
    const gap = LIST_MIN_GAP_MS - (Date.now() - listLastAt);
    if (gap > 0) await sleep(gap);
    listLastAt = Date.now();
  });
  listGateChain = wait.then(() => held);
  return wait.then(() => release);
}

async function getOrderList(
  token: string,
): Promise<{ status: number; orders: OrderRow[]; raw: unknown; error?: string; rateLimited: boolean; ms: number }> {
  const release = await acquireListSlot();
  const t0 = Date.now();
  try {
    const url =
      `${BASE}/bus/user/order/list?pageNum=1&pageSize=20&status=0&type=all` +
      `&orderByColumn=createTime&isAsc=asc&_t=${Date.now()}`;
    const r = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...MOBILE_HEADERS,
      },
      keepalive: true,
    });
    const text = await r.text();
    let j: unknown = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      return {
        status: r.status,
        orders: [],
        raw: text,
        error: `Parse error: ${text.slice(0, 200)}`,
        rateLimited: hasTooManyRequests(text),
        ms: Date.now() - t0,
      };
    }
    const response = { data: j as { rows?: OrderRow[] } };
    const orders = response.data.rows || [];
    return { status: r.status, orders, raw: j, rateLimited: hasTooManyRequests(j), ms: Date.now() - t0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: 0, orders: [], raw: null, error, rateLimited: hasTooManyRequests(null, error), ms: Date.now() - t0 };
  } finally {
    release();
  }
}


type OrderRow = {
  orderId?: string | number;
  orderNo?: string;
  id?: string | number;
  amount?: number | string;
  money?: number | string;
  price?: number | string;
  showAmount?: number | string;
  withdrawAmount?: number | string;
  platPay?: number | string;
  payType?: string;
  payment?: string;
  paymentMethod?: string;
  [k: string]: unknown;
};

function pickAmount(o: OrderRow): number {
  const v = o.showAmount ?? o.withdrawAmount ?? o.amount ?? o.money ?? o.price ?? o.platPay ?? 0;
  return Number(v) || 0;
}
function pickPayment(o: OrderRow): string {
  return String(o.payType ?? o.payment ?? o.paymentMethod ?? "").toLowerCase();
}
function pickOrderId(o: OrderRow): string {
  return String(o.orderNo ?? o.orderId ?? o.id ?? "");
}
// Recursive deep-search: some APIs nest bank info under
// customer_details / bankInfo / receiveInfo / payeeInfo / account / bank.
function deepFind(obj: unknown, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 5) return "";
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const lower = k.toLowerCase();
    if (keys.includes(lower)) {
      const v = rec[k];
      if (v != null && typeof v !== "object") {
        const s = String(v).trim();
        if (s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") return s;
      }
    }
  }
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (v && typeof v === "object") {
      const found = deepFind(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function pickRecipient(o: OrderRow): string {
  return deepFind(o, [
    "recipientname", "recipient_name", "receivename", "receive_name",
    "receivername", "receiver_name", "payeename", "payee_name",
    "accountname", "account_name", "username", "user_name",
    "realname", "real_name", "holdername", "holder_name", "name",
  ]) || "N/A";
}
function pickAccountNo(o: OrderRow): string {
  return deepFind(o, [
    "accountno", "account_no", "accountnumber", "account_number",
    "cardno", "card_no", "cardnumber", "card_number",
    "bankaccount", "bank_account", "payeeaccount", "payee_account",
    "receiveaccount", "receive_account", "phoneno", "phone_no",
    "phone", "mobile", "mobileno", "mobile_no",
    "stcaccount", "stc_account", "stcpay", "stc_pay",
  ]) || "N/A";
}
function pickIban(o: OrderRow): string {
  return deepFind(o, [
    "iban", "ibanno", "iban_no", "ibannumber", "iban_number",
    "ibancode", "iban_code",
  ]) || "N/A";
}

async function receiveOrderOnce(token: string, order: OrderRow) {
  try {
    const r = await fetch(`${BASE}/bus/user/order/receive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...MOBILE_HEADERS,
      },
      body: JSON.stringify(order),
      keepalive: true,
    });
    const text = await r.text();
    let j: { code?: number; msg?: string } = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { msg: text.slice(0, 200) };
    }
    const confirmed = j.code === 200;
    return { status: r.status, ok: confirmed, code: j.code, msg: j.msg, raw: text };
  } catch (e) {
    return { status: 0, ok: false, code: undefined as number | undefined, msg: e instanceof Error ? e.message : String(e), raw: "" };
  }
}

/**
 * AGGRESSIVE GRAB LOOP — pounds the /receive endpoint for the specific order
 * until either:
 *   • the server explicitly confirms success (code 200), OR
 *   • the server explicitly says the order is gone / taken by another user.
 *
 * Generic HTTP 500s, network blips, parse errors, or "too many requests"
 * during the grab burst do NOT break the loop — the bot keeps trying.
 *
 * Hard safety caps prevent a runaway: max ~12s wall-time and 240 attempts,
 * which is well past the realistic life of a fresh order on this platform.
 */
async function aggressiveGrab(
  u: BotUser,
  token: string,
  order: OrderRow,
  oid: string,
): Promise<{ ok: boolean; code?: number; msg?: string; attempts: number; ms: number }> {
  const start = Date.now();
  const MAX_MS = 12_000;
  const MAX_ATTEMPTS = 240;
  let attempts = 0;
  let last: Awaited<ReturnType<typeof receiveOrderOnce>> | null = null;

  while (Date.now() - start < MAX_MS && attempts < MAX_ATTEMPTS) {
    attempts++;
    const res = await receiveOrderOnce(token, order);
    last = res;

    // SUCCESS — server confirmed grab.
    if (res.ok && res.code === 200) {
      return { ok: true, code: res.code, msg: res.msg, attempts, ms: Date.now() - start };
    }

    // EXPLICIT FAILURE — order is gone / claimed by someone else. Break.
    if (isOrderGoneMessage(res.msg, res.code)) {
      return { ok: false, code: res.code, msg: res.msg, attempts, ms: Date.now() - start };
    }

    // Anything else (HTTP 500, "Too many requests" during burst, network errors,
    // unknown codes) → keep pounding immediately. Tiny breather so we don't
    // monopolize the event loop on a hot failure path.
    if (attempts % 8 === 0) {
      await log(
        u.id,
        u.slot,
        "warn",
        `[GRAB RETRY] ${oid} · attempt ${attempts} · code=${res.code ?? "n/a"} · "${(res.msg || "").slice(0, 80)}" — retrying...`,
      );
    }
    await sleep(25);
  }

  return {
    ok: false,
    code: last?.code,
    msg: last?.msg || "grab loop exhausted (timeout)",
    attempts,
    ms: Date.now() - start,
  };
}

/**
 * Run one polling tick for one user.
 *
 * Uses the MULTI-SESSION rotation engine when a token pool is available:
 *   - Each poll uses one selected token from the 10-token rotation array.
 *   - A healthy token continues polling until it reaches 5 successful hits, then rotates.
 *   - Any error (HTTP 500 / "Too many requests" / non-200 / rate-limit) triggers
 *     a PRE-EMPTIVE hot-swap: that token is marked cooldown (30s), engine
 *     instantly moves to the next healthy token on the very next tick.
 *
 * Falls back to STABLE SINGLE-SESSION mode when the entire pool is exhausted
 * or cannot be built, preserving uptime.
 */
export async function tickUser(u: BotUser): Promise<void> {
  const cooldownUntil = perUserCooldownUntil.get(u.id) ?? 0;
  if (cooldownUntil > Date.now()) return; // honor per-user cooldown lock

  // ---- Build the 10-token pool on first tick ---------------------------------
  let pool = tokenPools.get(u.id);
  if (!pool) {
    await log(
      u.id,
      u.slot,
      "info",
      `[ENGINE STATUS] - Initializing Multi-Session engine (10 parallel tokens)...`,
    );
    const built = await buildTokenPool(u);
    pool = built ?? undefined;
  }

  // ---- Pick a healthy token from the pool (pre-emptive rotation) -------------
  const selected: PoolToken | null = pool && pool.length > 0 ? pickHealthyToken(u.id) : null;
  let token: string | null;
  let multiSession = false;

  if (selected) {
    token = selected.token;
    multiSession = true;
  } else {
    if (pool && pool.length > 0) {
      await log(
        u.id,
        u.slot,
        "error",
        `[CRITICAL WARNING] - Multi-Session failed. Reverting to Stable Single-Session engine.`,
      );
    }
    token = u.auth_token;
    if (!token) {
      token = await loginUser(u);
      if (!token) return;
    }
  }

  const tokenTag = selected ? `Token #${selected.index}/${pool!.length}` : `Single-Session`;
  await log(
    u.id,
    u.slot,
    "info",
    `[POLLING] Slot ${u.slot} → GET /bus/user/order/list · ${tokenTag} (keep-alive · no-cache)`,
  );

  let list = await getOrderList(token);

  // ---- 401 handling: refresh the specific token slot (or single-session) -----
  if (list.status === 401 || (list.raw as { code?: number })?.code === 401) {
    await log(u.id, u.slot, "warn", `[SERVER ALERT] Slot ${u.slot} · ${tokenTag} token expired (401). Re-logging in.`);
    if (selected) {
      const fresh = await rawLogin(u);
      if (fresh) {
        selected.token = fresh;
        selected.hits = 0;
        token = fresh;
        list = await getOrderList(token);
      } else {
        selected.cooldownUntil = Date.now() + TOKEN_COOLDOWN_MS;
        return;
      }
    } else {
      token = await loginUser(u);
      if (!token) return;
      list = await getOrderList(token);
    }
  }

  const rawText = typeof list.raw === "string" ? list.raw : JSON.stringify(list.raw ?? {});
  const rawSnippet = rawText.length > 800 ? rawText.slice(0, 800) + "…" : rawText;
  const serverMsg = (list.raw as { msg?: string } | null)?.msg ?? "";
  const innerCode = (list.raw as { code?: number } | null)?.code;
  const isError =
    list.rateLimited ||
    list.status !== 200 ||
    (innerCode !== undefined && innerCode !== 200);

  // ---- PRE-EMPTIVE SWAP path (multi-session) ---------------------------------
  if (isError && selected) {
    const nextIdx = nextHealthyIndex(u.id, selected);
    const responseText = serverMsg || list.error || `HTTP ${list.status}`;
    await log(
      u.id,
      u.slot,
      "error",
      `[SERVER RESPONSE] - Token #${selected.index} hit a block at ${selected.hits} hits. Response: ${responseText}. ` +
        (nextIdx
          ? `Swapping to Token #${nextIdx} immediately...`
          : `All tokens on cooldown — will fallback to Single-Session next tick.`) +
        ` · [RAW DATA]: ${rawSnippet}`,
    );
    selected.cooldownUntil = Date.now() + TOKEN_COOLDOWN_MS;
    selected.hits = 0;
    if (nextIdx) focusIndex(u.id, nextIdx);
    return;
  }

  // ---- Single-session error handling (preserves prior behaviour) -------------
  if (isError) {
    if (
      list.rateLimited ||
      list.status === 429 ||
      (list.status === 500 && hasTooManyRequests(list.raw, list.error))
    ) {
      await log(
        u.id,
        u.slot,
        "error",
        `[SERVER ALERT] Slot ${u.slot} received: ${serverMsg || "Too many requests. Please try again later."} (HTTP ${list.status}) · [RAW DATA]: ${rawSnippet}`,
      );
      await applyRateLimitCooldown(u);
      return;
    }
    await log(
      u.id,
      u.slot,
      "error",
      `[SERVER ALERT] Slot ${u.slot} HTTP ${list.status} · [RAW DATA]: ${rawSnippet}`,
    );
    return;
  }

  // ---- SUCCESS ---------------------------------------------------------------
  if (selected) {
    selected.hits += 1;
    await log(
      u.id,
      u.slot,
      "success",
      `[ENGINE STATUS] - Token #${selected.index} active (1-${pool!.length}). Hits: ${selected.hits}/${POOL_HIT_LIMIT}. · ${list.ms}ms · rows=${list.orders.length}`,
    );
    if (selected.hits >= POOL_HIT_LIMIT) {
      const nextIdx = nextHealthyIndex(u.id, selected);
      selected.hits = 0;
      if (nextIdx) {
        focusIndex(u.id, nextIdx);
        await log(
          u.id,
          u.slot,
          "info",
          `[ENGINE STATUS] - Token #${selected.index} reached ${POOL_HIT_LIMIT}/${POOL_HIT_LIMIT} hit limit. Rotating forward to Token #${nextIdx}.`,
        );
      }
    }
  } else {
    await log(
      u.id,
      u.slot,
      "success",
      `[Hit Success] - Single-Session · Status 200 OK · ${list.ms}ms · rows=${list.orders.length} · [RAW DATA]: ${rawSnippet}`,
    );
  }

  if (list.orders.length === 0) {
    await supabaseAdmin
      .from("bot_users")
      .update({ last_polled_at: new Date().toISOString(), status: "running", status_message: "Authorized / Running" })
      .eq("id", u.id);
    return;
  }

  const orders = list.orders;
  const seen = new Set(u.seen_order_ids || []);
  const aliasMap: Record<string, string[]> = {
    "stc pay": ["stc", "stcpay"],
    stcpay: ["stc", "stcpay"],
    stc: ["stc"],
    urpay: ["urpay", "ur pay", "ur-pay"],
    "ur pay": ["urpay", "ur pay"],
    barq: ["barq"],
    banks: ["bank"],
    bank: ["bank"],
  };
  const allowedTokens: string[] = [];
  for (const m of u.payment_methods || []) {
    const key = String(m).toLowerCase().trim();
    const toks = aliasMap[key] || [key];
    allowedTokens.push(...toks);
  }
  const newSeen: string[] = [];

  const friendly = (raw: string): string => {
    const r = raw.toLowerCase();
    if (/stc/.test(r)) return "STC Pay";
    if (/ur\s*-?\s*pay/.test(r)) return "Urpay";
    if (/barq/.test(r)) return "Barq";
    if (/bank/.test(r)) return "Banks";
    return raw || "Unknown";
  };

  for (const o of orders) {
    const oid = pickOrderId(o);
    if (!oid || seen.has(oid)) continue;
    newSeen.push(oid);
    const amt = pickAmount(o);
    const pay = pickPayment(o);
    const payLabel = friendly(pay);
    const userTag = u.label || u.username;
    const slotTag = `${u.label || u.username} (Slot ${u.slot})`;

    let skipReason = "";
    if (amt < Number(u.min_price) || amt > Number(u.max_price)) {
      skipReason = `Price ${amt} SAR outside range ${u.min_price}–${u.max_price}`;
    } else if (allowedTokens.length > 0 && !allowedTokens.some((t) => pay.includes(t))) {
      skipReason = `Payment "${payLabel}" not in selected filters`;
    }
    if (skipReason) {
      await log(u.id, u.slot, "warn", `[ORDER SKIPPED] ${oid} · ${amt} SAR · ${payLabel} — ${skipReason}`);
      await sendDualTelegram(
        u,
        `⚠️ <b>[ORDER SKIPPED]</b>\nUser: ${userTag}\nOrder #: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${payLabel}\nReason: ${skipReason}`,
      );
      continue;
    }

    await log(u.id, u.slot, "success", `[DETECTION] Order ${oid} found — entering AGGRESSIVE GRAB LOOP`);

    // Fire the aggressive grab loop in the background so the polling cycle is
    // not blocked. The loop itself never gives up unless the server explicitly
    // confirms success or says the order is gone.
    void aggressiveGrab(u, token, o, oid).then(async (res) => {
      if (res.ok) {
        await supabaseAdmin
          .from("bot_users")
          .update({ orders_grabbed: (u.orders_grabbed || 0) + 1 })
          .eq("id", u.id);
        u.orders_grabbed = (u.orders_grabbed || 0) + 1;
        await log(
          u.id,
          u.slot,
          "success",
          `[ORDER GRABBED CONFIRMED] ${oid} · ${amt} SAR · ${payLabel} · attempts=${res.attempts} · ${res.ms}ms`,
        );
        const recipient = pickRecipient(o);
        const accountNo = pickAccountNo(o);
        const iban = pickIban(o);
        if (accountNo === "N/A" || iban === "N/A") {
          await log(u.id, u.slot, "info",
            `[ORDER FIELDS DUMP] ${oid} :: ${JSON.stringify(o)}`);
        }
        await sendDualTelegram(
          u,
          `🟢 <b>[ORDER GRABBED CONFIRMED]</b>\n` +
            `Slot/ID: <b>${slotTag}</b>\n` +
            `Order No: <code>${oid}</code>\n` +
            `Amount: <b>${amt}</b> Riyals\n` +
            `Payment: ${payLabel}\n` +
            `Recipient Name: ${recipient}\n` +
            `Account No: <code>${accountNo}</code>\n` +
            `IBAN: <code>${iban}</code>\n` +
            `Status: 100% Successfully Saved to Account!\n` +
            `Attempts: ${res.attempts}\n` +
            `Response Time: ${res.ms}ms`,
        );
      } else {
        const rawMsg = res.msg || `code ${res.code ?? "n/a"}`;
        await log(
          u.id,
          u.slot,
          "warn",
          `[ORDER DETECTED BUT MISSED] ${oid} · ${amt} SAR · ${payLabel} · attempts=${res.attempts} · reason="${rawMsg}"`,
        );
        const recipient = pickRecipient(o);
        const accountNo = pickAccountNo(o);
        const iban = pickIban(o);
        await sendDualTelegram(
          u,
          `⚠️ <b>[ORDER DETECTED BUT MISSED]</b>\n` +
            `Slot/ID: <b>${slotTag}</b>\n` +
            `Order No: <code>${oid}</code>\n` +
            `Amount: <b>${amt}</b> Riyals\n` +
            `Payment: ${payLabel}\n` +
            `Recipient Name: ${recipient}\n` +
            `Account No: <code>${accountNo}</code>\n` +
            `IBAN: <code>${iban}</code>\n` +
            `Status: Server confirmed order is no longer available (claimed elsewhere).\n` +
            `Attempts: ${res.attempts}\n` +
            `Response Time: ${res.ms}ms\n` +
            `Reason: <code>${rawMsg.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string)}</code>`,
        );
      }
    });
  }

  if (newSeen.length) {
    const merged = Array.from(new Set([...(u.seen_order_ids || []), ...newSeen])).slice(-200);
    await supabaseAdmin.from("bot_users").update({ seen_order_ids: merged }).eq("id", u.id);
  }
}

/**
 * STRICT FIXED INTERVAL polling. Each slot polls at exactly its configured
 * `polling_interval_ms`. No Math.random(), no jitter, no variation.
 */
export async function runPollCycle(budgetMs = 8000): Promise<{ ticked: number }> {
  const start = Date.now();
  const { data: users, error } = await supabaseAdmin
    .from("bot_users")
    .select("*")
    .eq("is_active", true);
  if (error || !users) return { ticked: 0 };

  // Stagger initial start per slot so N active slots don't all fire at t=0.
  // Combined with the global list-request gate, this smooths the outbound
  // request stream across the shared worker IP.
  const stagger = LIST_MIN_GAP_MS;
  const state = users.map((u, i) => ({ u: u as BotUser, nextAt: start + i * stagger }));
  let ticks = 0;


  while (Date.now() - start < budgetMs) {
    const now = Date.now();
    const due = state.filter((s) => s.nextAt <= now);
    if (due.length === 0) {
      const sleepMs = Math.max(50, Math.min(...state.map((s) => s.nextAt - now)));
      await sleep(Math.min(sleepMs, budgetMs - (Date.now() - start)));
      continue;
    }
    await Promise.all(
      due.map(async (s) => {
        try {
          await tickUser(s.u);
        } catch (e) {
          await log(s.u.id, s.u.slot, "error", `tick error: ${e instanceof Error ? e.message : String(e)}`);
        }
        ticks++;
        const cooldownUntil = perUserCooldownUntil.get(s.u.id) ?? 0;
        const fixedInterval = Math.max(200, Math.round(s.u.polling_interval_ms || 1000));
        // STRICT FIXED — exact interval, no jitter.
        s.nextAt = Math.max(cooldownUntil, Date.now() + fixedInterval);
      }),
    );
  }
  return { ticked: ticks };
}
