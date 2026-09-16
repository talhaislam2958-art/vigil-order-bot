// BROWSER-ONLY BOT ENGINE.
// A full client-side port of the cloud engine: 10-token rotation pools,
// strict fixed-interval polling per slot, aggressive claim burst, filter
// matching and dual-layer Telegram alerts — all running inside this tab with
// plain JS timers, consuming zero cloud credits.
//
// The upstream API returns permissive CORS headers (Access-Control-Allow-Origin
// reflects our origin for /login, /bus/user/order/list and /receive), so the
// browser can talk to it directly.

import {
  activeLocalSlots,
  getLocalAdminTelegram,
  listLocalSlots,
  patchLocalSlot,
  type LocalSlot,
} from "./local-store";

const BASE = "https://h5.parttime.mobi/prod-api";

// ---------------------------------------------------------------- log buffer
export type BrowserLog = {
  id: number;
  slot: number | null;
  level: "info" | "success" | "warn" | "error";
  message: string;
  created_at: string;
};

const LOG_CAP = 150;
let logId = 1;
let logs: BrowserLog[] = [];
const logListeners = new Set<() => void>();

function emit(): void {
  for (const fn of logListeners) fn();
}

export function subscribeBrowserLogs(fn: () => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export function getBrowserLogs(): BrowserLog[] {
  return logs;
}

export function clearBrowserLogs(slot?: number): void {
  logs = slot === undefined ? [] : logs.filter((l) => l.slot !== slot);
  emit();
}

export function blog(
  slot: number | null,
  level: BrowserLog["level"],
  message: string,
): void {
  const text = message.length > 2000 ? message.slice(0, 2000) + "…" : message;
  logs = [{ id: logId++, slot, level, message: text, created_at: new Date().toISOString() }, ...logs].slice(
    0,
    LOG_CAP,
  );
  emit();
}

// ---------------------------------------------------------------- telegram
export async function sendBrowserTelegram(
  bot_token: string,
  chat_id: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!bot_token || !chat_id) return { ok: false, error: "Missing Telegram bot token or chat id" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.description || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function sendDual(u: LocalSlot, text: string): void {
  if (u.telegram_bot_token && u.telegram_chat_id) {
    void sendBrowserTelegram(u.telegram_bot_token, u.telegram_chat_id, text);
  }
  const admin = getLocalAdminTelegram();
  if (admin.bot_token && admin.chat_id) {
    const tag = `📡 <b>[SLOT ${String(u.slot).padStart(2, "0")} · ${u.label || u.username || "—"}]</b>\n`;
    void sendBrowserTelegram(admin.bot_token, admin.chat_id, tag + text);
  }
}

// ---------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=utf-8",
  "Cache-Control": "no-cache",
};

type OrderRow = Record<string, unknown>;

function num(v: unknown): number {
  return Number(v) || 0;
}
function pickAmount(o: OrderRow): number {
  return num(o.showAmount ?? o.withdrawAmount ?? o.amount ?? o.money ?? o.price ?? o.platPay ?? 0);
}
function pickPayment(o: OrderRow): string {
  return String(o.payType ?? o.payment ?? o.paymentMethod ?? "").toLowerCase();
}
function pickOrderId(o: OrderRow): string {
  return String(o.orderNo ?? o.orderId ?? o.id ?? "");
}
function deepFind(obj: unknown, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 5) return "";
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (keys.includes(k.toLowerCase())) {
      const v = rec[k];
      if (v != null && typeof v !== "object") {
        const s = String(v).trim();
        if (s && s !== "null" && s !== "undefined") return s;
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
const pickRecipient = (o: OrderRow) =>
  deepFind(o, ["recipientname", "recipient_name", "receivename", "receivername", "payeename", "accountname", "realname", "holdername", "name"]) || "N/A";
const pickAccountNo = (o: OrderRow) =>
  deepFind(o, ["accountno", "account_no", "accountnumber", "account_number", "cardno", "card_no", "cardnumber", "bankaccount", "payeeaccount", "receiveaccount", "phone", "mobile", "mobileno", "stcaccount"]) || "N/A";
const pickIban = (o: OrderRow) => deepFind(o, ["iban", "ibanno", "iban_no", "ibannumber", "ibancode"]) || "N/A";

function friendly(raw: string): string {
  const r = raw.toLowerCase();
  if (/stc/.test(r)) return "STC Pay";
  if (/ur\s*-?\s*pay/.test(r)) return "Urpay";
  if (/barq/.test(r)) return "Barq";
  if (/bank/.test(r)) return "Banks";
  return raw || "Unknown";
}

function hasTooManyRequests(payload: unknown, error?: string): boolean {
  const hay = [error, typeof payload === "string" ? payload : JSON.stringify(payload ?? {})]
    .filter(Boolean)
    .join(" ");
  return /too many requests/i.test(hay);
}

function isOrderGone(msg: string | undefined, code: number | undefined): boolean {
  if (!msg) return code === 404;
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

// ---------------------------------------------------------------- API calls
export async function browserLogin(username: string, password: string) {
  const r = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: string; code?: number; msg?: string };
  return { status: r.status, token: j.token, code: j.code, msg: j.msg };
}

async function rawLogin(u: LocalSlot): Promise<string | null> {
  try {
    const r = await browserLogin(u.username, u.password);
    return r.token || null;
  } catch {
    return null;
  }
}

// Global outbound gate — all slots share this browser's IP.
const LIST_MIN_GAP_MS = 400;
let gateChain: Promise<void> = Promise.resolve();
let gateLastAt = 0;
function acquireListSlot(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  const wait = gateChain.then(async () => {
    const gap = LIST_MIN_GAP_MS - (Date.now() - gateLastAt);
    if (gap > 0) await sleep(gap);
    gateLastAt = Date.now();
  });
  gateChain = wait.then(() => held);
  return wait.then(() => release);
}

async function getOrderList(token: string) {
  const release = await acquireListSlot();
  const t0 = Date.now();
  try {
    const url =
      `${BASE}/bus/user/order/list?pageNum=1&pageSize=20&status=0&type=all` +
      `&orderByColumn=createTime&isAsc=asc&_t=${Date.now()}`;
    const r = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, ...HEADERS } });
    const text = await r.text();
    let j: unknown = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      return { status: r.status, orders: [] as OrderRow[], raw: text, error: `Parse error`, rateLimited: hasTooManyRequests(text), ms: Date.now() - t0 };
    }
    const orders = ((j as { rows?: OrderRow[] }).rows || []) as OrderRow[];
    return { status: r.status, orders, raw: j, error: undefined as string | undefined, rateLimited: hasTooManyRequests(j), ms: Date.now() - t0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: 0, orders: [] as OrderRow[], raw: null, error, rateLimited: false, ms: Date.now() - t0 };
  } finally {
    release();
  }
}

async function receiveOnce(token: string, order: OrderRow) {
  try {
    const r = await fetch(`${BASE}/bus/user/order/receive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...HEADERS },
      body: JSON.stringify(order),
    });
    const text = await r.text();
    let j: { code?: number; msg?: string } = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { msg: text.slice(0, 200) };
    }
    return { status: r.status, ok: j.code === 200, code: j.code, msg: j.msg };
  } catch (e) {
    return { status: 0, ok: false, code: undefined as number | undefined, msg: e instanceof Error ? e.message : String(e) };
  }
}

async function aggressiveGrab(u: LocalSlot, token: string, order: OrderRow, oid: string) {
  const start = Date.now();
  const MAX_MS = 12_000;
  const MAX_ATTEMPTS = 240;
  let attempts = 0;
  let last: Awaited<ReturnType<typeof receiveOnce>> | null = null;
  while (Date.now() - start < MAX_MS && attempts < MAX_ATTEMPTS) {
    attempts++;
    const res = await receiveOnce(token, order);
    last = res;
    if (res.ok) return { ok: true, code: res.code, msg: res.msg, attempts, ms: Date.now() - start };
    if (isOrderGone(res.msg, res.code)) return { ok: false, code: res.code, msg: res.msg, attempts, ms: Date.now() - start };
    if (attempts % 8 === 0) {
      blog(u.slot, "warn", `[GRAB RETRY] ${oid} · attempt ${attempts} · code=${res.code ?? "n/a"} · "${(res.msg || "").slice(0, 80)}" — retrying...`);
    }
    await sleep(25);
  }
  return { ok: false, code: last?.code, msg: last?.msg || "grab loop exhausted (timeout)", attempts, ms: Date.now() - start };
}

// ---------------------------------------------------------------- token pools
const POOL_SIZE = 10;
const POOL_HIT_LIMIT = 5;
const TOKEN_COOLDOWN_MS = 30_000;
const SESSION_MAX_AGE_MS = 7 * 60 * 1000;

type PoolToken = { token: string; hits: number; cooldownUntil: number; index: number };

const pools = new Map<string, PoolToken[]>();
const cursor = new Map<string, number>();
const cooldownUntil = new Map<string, number>();
const sessionStartedAt = new Map<string, number>();
const singleToken = new Map<string, string>();

function clearSlotMemory(id: string): void {
  pools.delete(id);
  cursor.delete(id);
  cooldownUntil.delete(id);
  sessionStartedAt.delete(id);
  singleToken.delete(id);
}

async function buildPool(u: LocalSlot): Promise<PoolToken[] | null> {
  const tokens: PoolToken[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const t = await rawLogin(u);
    if (t) tokens.push({ token: t, hits: 0, cooldownUntil: 0, index: tokens.length + 1 });
    await sleep(150);
  }
  if (tokens.length === 0) return null;
  pools.set(u.id, tokens);
  cursor.set(u.id, 0);
  sessionStartedAt.set(u.id, Date.now());
  blog(u.slot, "success", `[ENGINE STATUS · BROWSER] Multi-Session pool initialized: ${tokens.length}/${POOL_SIZE} tokens ready.`);
  return tokens;
}

function pickToken(id: string): PoolToken | null {
  const pool = pools.get(id);
  if (!pool || pool.length === 0) return null;
  const now = Date.now();
  const start = cursor.get(id) ?? 0;
  for (let i = 0; i < pool.length; i++) {
    const pos = (start + i) % pool.length;
    if (pool[pos].cooldownUntil <= now) {
      cursor.set(id, pos);
      return pool[pos];
    }
  }
  return null;
}

function rotate(id: string, current: PoolToken): number | null {
  const pool = pools.get(id);
  if (!pool) return null;
  const start = pool.findIndex((p) => p === current);
  const now = Date.now();
  for (let i = 1; i <= pool.length; i++) {
    const pos = (start + i) % pool.length;
    if (pool[pos].cooldownUntil <= now) {
      cursor.set(id, pos);
      return pool[pos].index;
    }
  }
  return null;
}

// ---------------------------------------------------------------- tick
async function tickSlot(u: LocalSlot): Promise<void> {
  if ((cooldownUntil.get(u.id) ?? 0) > Date.now()) return;

  const started = sessionStartedAt.get(u.id);
  if (started && Date.now() - started >= SESSION_MAX_AGE_MS) {
    blog(u.slot, "warn", `[SESSION HEALTH · BROWSER] 7-minute refresh reached — flushing tokens and re-initializing a fresh session.`);
    clearSlotMemory(u.id);
  }

  let pool = pools.get(u.id);
  if (!pool) {
    blog(u.slot, "info", `[ENGINE STATUS · BROWSER] Initializing Multi-Session engine (10 parallel tokens)...`);
    pool = (await buildPool(u)) ?? undefined;
  }

  const selected = pool && pool.length > 0 ? pickToken(u.id) : null;
  let token: string | null = selected?.token ?? null;
  if (!token) {
    token = singleToken.get(u.id) ?? (await rawLogin(u));
    if (!token) {
      blog(u.slot, "error", `[BROWSER MODE] Login failed — cannot poll this slot.`);
      patchLocalSlot(u.id, { status: "error", status_message: "Login failed" });
      return;
    }
    singleToken.set(u.id, token);
  }

  const tag = selected ? `Token #${selected.index}/${pool!.length}` : "Single-Session";
  blog(u.slot, "info", `[POLLING · BROWSER] Slot ${u.slot} → GET /bus/user/order/list · ${tag}`);

  let list = await getOrderList(token);

  if (list.status === 401 || (list.raw as { code?: number } | null)?.code === 401) {
    blog(u.slot, "warn", `[SERVER ALERT · BROWSER] ${tag} token expired (401). Re-logging in.`);
    const fresh = await rawLogin(u);
    if (!fresh) {
      if (selected) selected.cooldownUntil = Date.now() + TOKEN_COOLDOWN_MS;
      return;
    }
    if (selected) {
      selected.token = fresh;
      selected.hits = 0;
    } else {
      singleToken.set(u.id, fresh);
    }
    token = fresh;
    list = await getOrderList(token);
  }

  const rawText = typeof list.raw === "string" ? list.raw : JSON.stringify(list.raw ?? {});
  const rawSnippet = rawText.length > 600 ? rawText.slice(0, 600) + "…" : rawText;
  const innerCode = (list.raw as { code?: number } | null)?.code;
  const serverMsg = (list.raw as { msg?: string } | null)?.msg ?? "";
  const isError = list.rateLimited || list.status !== 200 || (innerCode !== undefined && innerCode !== 200);

  if (isError) {
    if (selected) {
      const next = rotate(u.id, selected);
      selected.cooldownUntil = Date.now() + TOKEN_COOLDOWN_MS;
      selected.hits = 0;
      blog(u.slot, "error", `[SERVER RESPONSE · BROWSER] Token #${selected.index} blocked. Response: ${serverMsg || list.error || `HTTP ${list.status}`}. ${next ? `Swapping to Token #${next}...` : "All tokens cooling down."} · [RAW DATA]: ${rawSnippet}`);
      return;
    }
    if (list.rateLimited || list.status === 429) {
      const secs = Math.max(1, Math.round(u.cooldown_seconds || 10));
      cooldownUntil.set(u.id, Date.now() + secs * 1000);
      patchLocalSlot(u.id, { status: "cooldown", status_message: `Cooling down ${secs}s (rate limit)` });
      blog(u.slot, "error", `[Firewall Blocked · BROWSER] Too Many Requests — Entering Cooldown for ${secs} Seconds`);
      return;
    }
    blog(u.slot, "error", `[SERVER ALERT · BROWSER] HTTP ${list.status} · [RAW DATA]: ${rawSnippet}`);
    return;
  }

  if (selected) {
    selected.hits += 1;
    blog(u.slot, "success", `[ENGINE STATUS · BROWSER] Token #${selected.index} active. Hits: ${selected.hits}/${POOL_HIT_LIMIT} · ${list.ms}ms · rows=${list.orders.length}`);
    if (selected.hits >= POOL_HIT_LIMIT) {
      selected.hits = 0;
      const next = rotate(u.id, selected);
      if (next) blog(u.slot, "info", `[ENGINE STATUS · BROWSER] Hit limit reached. Rotating forward to Token #${next}.`);
    }
  } else {
    blog(u.slot, "success", `[Hit Success · BROWSER] Single-Session · 200 OK · ${list.ms}ms · rows=${list.orders.length}`);
  }

  patchLocalSlot(u.id, {
    last_polled_at: new Date().toISOString(),
    status: "running",
    status_message: "Authorized / Running (Browser-Only)",
  });

  if (list.orders.length === 0) return;

  const aliasMap: Record<string, string[]> = {
    stcpay: ["stc", "stcpay"],
    "stc pay": ["stc", "stcpay"],
    stc: ["stc"],
    urpay: ["urpay", "ur pay", "ur-pay"],
    barq: ["barq"],
    bank: ["bank"],
    banks: ["bank"],
  };
  const allowed: string[] = [];
  for (const m of u.payment_methods || []) {
    const key = String(m).toLowerCase().trim();
    allowed.push(...(aliasMap[key] || [key]));
  }
  const minP = num(u.min_price);
  const maxP = num(u.max_price) || Number.MAX_SAFE_INTEGER;
  const seen = new Set(u.seen_order_ids || []);
  const newSeen: string[] = [];

  for (const o of list.orders) {
    const oid = pickOrderId(o);
    if (!oid || seen.has(oid)) continue;
    newSeen.push(oid);
    const amt = pickAmount(o);
    const pay = pickPayment(o);
    const payLabel = friendly(pay);
    const slotTag = `${u.label || u.username} (Slot ${u.slot})`;

    let skipReason = "";
    if (amt < minP || amt > maxP) skipReason = `Price ${amt} SAR outside range ${minP}–${maxP}`;
    else if (allowed.length > 0 && !allowed.some((t) => pay.includes(t)))
      skipReason = `Payment "${payLabel}" not in selected filters`;

    if (skipReason) {
      blog(u.slot, "warn", `[ORDER SKIPPED · BROWSER] ${oid} · ${amt} SAR · ${payLabel} — ${skipReason}`);
      sendDual(u, `⚠️ <b>[ORDER SKIPPED]</b>\nMode: Browser-Only\nUser: ${u.label || u.username}\nOrder #: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${payLabel}\nReason: ${skipReason}`);
      continue;
    }

    const grab = aggressiveGrab(u, token, o, oid);
    blog(u.slot, "success", `[DETECTION · BROWSER] Order ${oid} found — instant claim fired (top priority)`);

    void grab
      .then((res) => {
        const recipient = pickRecipient(o);
        const accountNo = pickAccountNo(o);
        const iban = pickIban(o);
        if (res.ok) {
          const cur = listLocalSlots().find((s) => s.id === u.id);
          patchLocalSlot(u.id, { orders_grabbed: (cur?.orders_grabbed || 0) + 1 });
          blog(u.slot, "success", `[ORDER GRABBED CONFIRMED · BROWSER] ${oid} · ${amt} SAR · ${payLabel} · attempts=${res.attempts} · ${res.ms}ms`);
          sendDual(
            u,
            `🟢 <b>[ORDER GRABBED CONFIRMED]</b>\nMode: Browser-Only\nSlot/ID: <b>${slotTag}</b>\nOrder No: <code>${oid}</code>\nAmount: <b>${amt}</b> Riyals\nPayment: ${payLabel}\nRecipient Name: ${recipient}\nAccount No: <code>${accountNo}</code>\nIBAN: <code>${iban}</code>\nStatus: 100% Successfully Saved to Account!\nAttempts: ${res.attempts}\nResponse Time: ${res.ms}ms`,
          );
        } else {
          const reason = res.msg || `code ${res.code ?? "n/a"}`;
          blog(u.slot, "warn", `[ORDER DETECTED BUT MISSED · BROWSER] ${oid} · ${amt} SAR · ${payLabel} · attempts=${res.attempts} · reason="${reason}"`);
          sendDual(
            u,
            `⚠️ <b>[ORDER DETECTED BUT MISSED]</b>\nMode: Browser-Only\nSlot/ID: <b>${slotTag}</b>\nOrder No: <code>${oid}</code>\nAmount: <b>${amt}</b> Riyals\nPayment: ${payLabel}\nRecipient Name: ${recipient}\nAccount No: <code>${accountNo}</code>\nIBAN: <code>${iban}</code>\nStatus: Order no longer available (claimed elsewhere).\nAttempts: ${res.attempts}\nResponse Time: ${res.ms}ms`,
          );
        }
      })
      .catch((e) => blog(u.slot, "error", `[GRAB HANDLER RECOVERED · BROWSER] ${oid} · ${e instanceof Error ? e.message : String(e)}`));
  }

  if (newSeen.length) {
    const cur = listLocalSlots().find((s) => s.id === u.id);
    const merged = Array.from(new Set([...(cur?.seen_order_ids || []), ...newSeen])).slice(-200);
    patchLocalSlot(u.id, { seen_order_ids: merged });
  }
}

// ---------------------------------------------------------------- scheduler
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const busy = new Set<string>();
const nextAt = new Map<string, number>();

export function isBrowserEngineRunning(): boolean {
  return running;
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(loop, 200);
}

async function loop(): Promise<void> {
  if (!running) return;
  try {
    const active = activeLocalSlots();
    const activeIds = new Set(active.map((s) => s.id));
    for (const id of Array.from(pools.keys())) if (!activeIds.has(id)) clearSlotMemory(id);

    const now = Date.now();
    for (const u of active) {
      if (busy.has(u.id)) continue;
      const due = nextAt.get(u.id) ?? 0;
      if (due > now) continue;
      busy.add(u.id);
      void tickSlot(u)
        .catch((e) => blog(u.slot, "error", `[BROWSER TICK RECOVERED] ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          busy.delete(u.id);
          const interval = Math.max(200, Math.round(u.polling_interval_ms || 1000));
          nextAt.set(u.id, Math.max(cooldownUntil.get(u.id) ?? 0, Date.now() + interval));
        });
    }
  } catch (e) {
    blog(null, "error", `[BROWSER LOOP RECOVERED] ${e instanceof Error ? e.message : String(e)}`);
  }
  schedule();
}

export function startBrowserEngine(): void {
  if (running) return;
  running = true;
  blog(null, "success", "[BROWSER-ONLY MODE] Client-side engine started — polling now runs in this tab (0 cloud credits). Keep this tab open.");
  schedule();
}

export function stopBrowserEngine(): void {
  if (!running) return;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  for (const id of Array.from(pools.keys())) clearSlotMemory(id);
  nextAt.clear();
  blog(null, "warn", "[BROWSER-ONLY MODE] Client-side engine stopped.");
}

/** One manual cycle: force every active slot to tick now. */
export async function runBrowserCycleNow(): Promise<{ ticked: number }> {
  const active = activeLocalSlots();
  for (const u of active) nextAt.set(u.id, 0);
  await Promise.all(
    active.map((u) =>
      tickSlot(u).catch((e) => blog(u.slot, "error", `[BROWSER TICK RECOVERED] ${e instanceof Error ? e.message : String(e)}`)),
    ),
  );
  return { ticked: active.length };
}

export function resetBrowserSlot(id: string): void {
  clearSlotMemory(id);
  nextAt.delete(id);
}
