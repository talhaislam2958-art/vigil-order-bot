// Server-only bot engine. Talks to h5.parttime.mobi and Telegram.
// Imported only by server function handlers and the public cron route handler.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://h5.parttime.mobi/prod-api";
const COOLDOWN_MS = 10_000;

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
    await sendTelegram(
      u.telegram_bot_token,
      u.telegram_chat_id,
      `✅ User <b>${u.label || u.username}</b> session refreshed and actively monitoring orders.`,
    );
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
};


/** Exact polling interval as configured on the dashboard (no jitter, no fingerprint shifting). */
export function nextJitterMs(baseMs: number): number {
  return Math.max(200, baseMs || 4000);
}

const perUserCooldownUntil = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasTooManyRequests(payload: unknown, error?: string): boolean {
  const haystack = [error, typeof payload === "string" ? payload : JSON.stringify(payload ?? {})]
    .filter(Boolean)
    .join(" ");
  return /too many requests/i.test(haystack);
}

async function applyRateLimitCooldown(u: BotUser): Promise<void> {
  perUserCooldownUntil.set(u.id, Date.now() + COOLDOWN_MS);
  await setStatus(u.id, "cooldown", `Cooling down ${COOLDOWN_MS / 1000}s (rate limit)`);
  await log(
    u.id,
    u.slot,
    "warn",
    `[ANTI-FIREWALL] Rate limit threshold approached. Cooling down for ${COOLDOWN_MS / 1000}s...`,
  );
  await sleep(COOLDOWN_MS);
}

async function getOrderList(
  token: string,
): Promise<{ status: number; orders: OrderRow[]; raw: unknown; error?: string; rateLimited: boolean; ms: number }> {
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
  // Real server uses orderNo (e.g. "WO20678984955..."). Fall back to other keys.
  return String(o.orderNo ?? o.orderId ?? o.id ?? "");
}

async function receiveOrder(token: string, order: OrderRow) {
  try {
    // CRITICAL: the live endpoint expects the FULL order object as body (Content-Length ~736),
    // not {orderId}. Captured from production DevTools.
    const r = await fetch(`${BASE}/bus/user/order/receive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...MOBILE_HEADERS,
      },
      body: JSON.stringify(order),
    });
    const text = await r.text();
    let j: { code?: number; msg?: string } = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { msg: text.slice(0, 200) };
    }
    // STRICT confirmation: ONLY treat code === 200 as a true server-confirmed grab.
    // HTTP 2xx without code === 200 is NOT a confirmed capture (server uses code in body).
    const confirmed = j.code === 200;
    return { status: r.status, ok: confirmed, code: j.code, msg: j.msg, raw: text };
  } catch (e) {
    return { status: 0, ok: false, code: undefined, msg: e instanceof Error ? e.message : String(e), raw: "" };
  }
}

/** Run one polling tick for one user. Re-logins automatically on 401/token errors. */
export async function tickUser(u: BotUser): Promise<void> {
  const cooldownUntil = perUserCooldownUntil.get(u.id) ?? 0;
  if (cooldownUntil > Date.now()) return; // honor per-user cooldown

  let token = u.auth_token;
  if (!token) {
    token = await loginUser(u);
    if (!token) return;
  }

  await log(
    u.id,
    u.slot,
    "info",
    `[POLLING] Slot ${u.slot} → GET ${BASE}/bus/user/order/list (real fetch)`,
  );
  let list = await getOrderList(token);
  if (list.status === 401 || (list.raw as { code?: number })?.code === 401) {
    await log(u.id, u.slot, "warn", `[SERVER ALERT] Slot ${u.slot} token expired (401). Re-logging in.`);
    token = await loginUser(u);
    if (!token) return;
    list = await getOrderList(token);
  }

  // Always print the exact raw server response for every fetch — 1:1 with the [POLLING] line above.
  const rawText =
    typeof list.raw === "string" ? list.raw : JSON.stringify(list.raw ?? {});
  const rawSnippet = rawText.length > 1200 ? rawText.slice(0, 1200) + "…" : rawText;
  const serverMsg = (list.raw as { msg?: string } | null)?.msg ?? "";

  if (list.error && list.status !== 200) {
    await log(
      u.id,
      u.slot,
      "error",
      `[API ERROR] Slot ${u.slot} HTTP ${list.status} · ${list.ms}ms · ${list.error}`,
    );
  }

  if (list.rateLimited || list.status === 429 || (list.status === 500 && hasTooManyRequests(list.raw, list.error))) {
    await log(
      u.id,
      u.slot,
      "error",
      `[SERVER ALERT] Slot ${u.slot} received: ${serverMsg || "Too many requests. Please try again later."} (HTTP ${list.status}) · [RAW DATA]: ${rawSnippet}`,
    );
    await applyRateLimitCooldown(u);
    return;
  }
  if (list.status !== 200) {
    await log(
      u.id,
      u.slot,
      "error",
      `[SERVER ALERT] Slot ${u.slot} HTTP ${list.status} · [RAW DATA]: ${rawSnippet}`,
    );
    return;
  }

  await log(
    u.id,
    u.slot,
    "info",
    `[HTTP 200] Slot ${u.slot} · ${list.ms}ms · rows=${list.orders.length} · [RAW DATA]: ${rawSnippet}`,
  );


  if (list.orders.length === 0) {
    await supabaseAdmin
      .from("bot_users")
      .update({ last_polled_at: new Date().toISOString(), status: "running", status_message: "Authorized / Running" })
      .eq("id", u.id);
    return;
  }

  const orders = list.orders;
  const responseMs = list.ms;

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

    let skipReason = "";
    if (amt < Number(u.min_price) || amt > Number(u.max_price)) {
      skipReason = `Price ${amt} SAR outside range ${u.min_price}–${u.max_price}`;
    } else if (allowedTokens.length > 0 && !allowedTokens.some((t) => pay.includes(t))) {
      skipReason = `Payment "${payLabel}" not in selected filters`;
    }
    if (skipReason) {
      await log(u.id, u.slot, "warn", `[ORDER SKIPPED] ${oid} · ${amt} SAR · ${payLabel} — ${skipReason}`);
      await sendTelegram(
        u.telegram_bot_token,
        u.telegram_chat_id,
        `⚠️ <b>Order skipped</b>\nUser: ${userTag}\nOrder #: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${payLabel}\nReason: ${skipReason}`,
      );
      continue;
    }

    // INSTANT GRAB: fire receive immediately, before logs/telegram
    const grabStart = Date.now();
    const grabPromise = receiveOrder(token, o);
    await log(u.id, u.slot, "success", `[DETECTION] Order ${oid} found, initiating immediate grab!`);
    const slotTag = `${u.label || u.username} (Slot ${u.slot})`;
    void grabPromise.then(async (res) => {
      const grabMs = Date.now() - grabStart;
      // STRICT: only an explicit code===200 from /order/receive counts as a confirmed grab.
      if (res.ok && res.code === 200) {
        await supabaseAdmin
          .from("bot_users")
          .update({ orders_grabbed: (u.orders_grabbed || 0) + 1 })
          .eq("id", u.id);
        u.orders_grabbed = (u.orders_grabbed || 0) + 1;
        await log(
          u.id,
          u.slot,
          "success",
          `[GRAB CONFIRMED] ${oid} · ${amt} SAR · ${payLabel} · server msg="${res.msg ?? ""}" · ${gramMsSafe(grabMs)}ms`,
        );
        await sendTelegram(
          u.telegram_bot_token,
          u.telegram_chat_id,
          `🚨 <b>[ORDER GRABBED CONFIRMED]</b>\n` +
            `Slot/ID: <b>${slotTag}</b>\n` +
            `Order No: <code>${oid}</code>\n` +
            `Amount: <b>${amt}</b> Riyals\n` +
            `Payment: ${payLabel}\n` +
            `Status: 100% Successfully Saved to Account!\n` +
            `Response Time: ${grabMs}ms`,
        );
      } else {
        const rawMsg = res.msg || `HTTP ${res.status}`;
        await log(
          u.id,
          u.slot,
          "warn",
          `[GRAB MISSED] ${oid} · ${amt} SAR · ${payLabel} · code=${res.code ?? "n/a"} · reason="${rawMsg}"`,
        );
        await sendTelegram(
          u.telegram_bot_token,
          u.telegram_chat_id,
          `⚠️ <b>[ORDER DETECTED BUT MISSED]</b>\n` +
            `Slot/ID: <b>${slotTag}</b>\n` +
            `Order No: <code>${oid}</code>\n` +
            `Amount: <b>${amt}</b> Riyals\n` +
            `Payment: ${payLabel}\n` +
            `Status: Detected on server but could not be received (Lost the race to another bot).\n` +
            `Reason: <code>${escapeHtml(rawMsg)}</code>`,
        );
      }
    });
  }

  if (newSeen.length) {
    const merged = Array.from(new Set([...(u.seen_order_ids || []), ...newSeen])).slice(-200);
    await supabaseAdmin.from("bot_users").update({ seen_order_ids: merged }).eq("id", u.id);
  }
}

/** Polls every active user with adaptive per-user jitter until budget exhausted. */
export async function runPollCycle(budgetMs = 8000): Promise<{ ticked: number }> {
  const start = Date.now();
  const { data: users, error } = await supabaseAdmin
    .from("bot_users")
    .select("*")
    .eq("is_active", true);
  if (error || !users) return { ticked: 0 };

  const state = users.map((u) => ({ u: u as BotUser, nextAt: 0 }));
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
        s.nextAt = Date.now() + nextJitterMs(s.u.polling_interval_ms);
      }),
    );
  }
  return { ticked: ticks };
}
