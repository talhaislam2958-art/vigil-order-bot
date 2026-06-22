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
  // failure
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
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "X-Requested-With": "com.application.package",
};

const cleanCycleJitterMs = () => 1000 + Math.floor(Math.random() * 801);
let globalRateLimitCooldownUntil = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasTooManyRequests(payload: unknown, error?: string): boolean {
  const haystack = [error, typeof payload === "string" ? payload : JSON.stringify(payload ?? {})]
    .filter(Boolean)
    .join(" ");
  return haystack.includes("Too many requests");
}

async function applyRateLimitCooldown(u: BotUser): Promise<void> {
  globalRateLimitCooldownUntil = Date.now() + 4000;
  await setStatus(u.id, "cooldown", "Rate limit cooldown active");
  await log(u.id, u.slot, "warn", "[ANTI-BAN]: Rate limit hit, cooling down 4s...");
  await sleep(4000);
}

async function waitForGlobalCooldown(): Promise<void> {
  const waitMs = globalRateLimitCooldownUntil - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

async function getOrderList(
  token: string,
): Promise<{ status: number; orders: OrderRow[]; raw: unknown; error?: string; rateLimited: boolean }> {
  try {
    const r = await fetch(
      `${BASE}/bus/user/order/list?pageNum=1&pageSize=20&status=0&type=all&orderByColumn=createTime&isAsc=asc`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...MOBILE_HEADERS,
        },
      },
    );
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
      };
    }
    const response = { data: j as { rows?: OrderRow[] } };
    const orders = response.data.rows || [];
    return { status: r.status, orders, raw: j, rateLimited: hasTooManyRequests(j) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: 0, orders: [], raw: null, error, rateLimited: hasTooManyRequests(null, error) };
  }
}

type OrderRow = {
  orderId?: string | number;
  id?: string | number;
  amount?: number | string;
  money?: number | string;
  price?: number | string;
  payType?: string;
  payment?: string;
  paymentMethod?: string;
  [k: string]: unknown;
};

function pickAmount(o: OrderRow): number {
  const v = o.amount ?? o.money ?? o.price ?? 0;
  return Number(v) || 0;
}
function pickPayment(o: OrderRow): string {
  return String(o.payType ?? o.payment ?? o.paymentMethod ?? "").toLowerCase();
}
function pickOrderId(o: OrderRow): string {
  return String(o.orderId ?? o.id ?? "");
}

async function receiveOrder(token: string, orderId: string) {
  try {
    const r = await fetch(`${BASE}/bus/user/order/receive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...MOBILE_HEADERS,
      },
      body: JSON.stringify({ orderId }),
    });
    const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string };
    return { status: r.status, ok: j.code === 200 || r.ok, msg: j.msg };
  } catch (e) {
    return { status: 0, ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

/** Run one polling tick for one user. Re-logins automatically on 401/token errors. */
export async function tickUser(u: BotUser): Promise<void> {
  await waitForGlobalCooldown();
  let token = u.auth_token;
  if (!token) {
    token = await loginUser(u);
    if (!token) return;
  }

  let list = await getOrderList(token);
  if (list.status === 401 || (list.raw as { code?: number })?.code === 401) {
    await log(u.id, u.slot, "warn", "Token expired, re-logging in");
    token = await loginUser(u);
    if (!token) return;
    list = await getOrderList(token);
  }
  if (list.rateLimited || (list.status === 500 && hasTooManyRequests(list.raw, list.error))) {
    await applyRateLimitCooldown(u);
    list = await getOrderList(token);
  }
  if (list.status !== 200) {
    const raw = list.error || (typeof list.raw === "string" ? list.raw : JSON.stringify(list.raw)?.slice(0, 200));
    await log(u.id, u.slot, "error", `getOrderList HTTP ${list.status} ${raw ?? ""}`.trim());
    return;
  }

  if (list.orders.length === 0) {
    const dump = typeof list.raw === "string" ? list.raw : JSON.stringify(list.raw);
    console.log("[ORDER-LIST RAW]", dump);
    await supabaseAdmin
      .from("bot_users")
      .update({ last_polled_at: new Date().toISOString(), status: "running", status_message: "Authorized / Running" })
      .eq("id", u.id);
    await log(u.id, u.slot, "info", `[RAW PAYLOAD] ${(dump || "").slice(0, 500)}`);
    return;
  }

  const orders = list.orders;

  const seen = new Set(u.seen_order_ids || []);
  // Normalize filter aliases → tokens to match loosely against payment strings
  const aliasMap: Record<string, string[]> = {
    "stc pay": ["stc", "stcpay"],
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
      skipReason = `Payment "${payLabel}" (raw: "${pay}") not in selected filters [${allowedTokens.join(",")}]`;
    }
    if (skipReason) {
      await log(u.id, u.slot, "warn", `Skip ${oid}: ${skipReason}`);
      await sendTelegram(
        u.telegram_bot_token,
        u.telegram_chat_id,
        `⚠️ <b>Order skipped (Failed Filter Match)</b>\nUser: ${userTag}\nOrder #: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${payLabel}\nReason: ${skipReason}`,
      );
      continue;
    }

    // INSTANT GRAB: fire receive before any detection log/notification work to win the race
    const grabPromise = receiveOrder(token, oid);
    await log(u.id, u.slot, "success", "[DETECTION]: Order found, initiating immediate grab!");
    void grabPromise.then(async (res) => {
      if (res.ok) {
        await supabaseAdmin
          .from("bot_users")
          .update({ orders_grabbed: (u.orders_grabbed || 0) + 1 })
          .eq("id", u.id);
        u.orders_grabbed = (u.orders_grabbed || 0) + 1;
        await log(u.id, u.slot, "success", `✅ Grabbed ${oid} · ${amt} SAR · ${payLabel}`);
        await sendTelegram(
          u.telegram_bot_token,
          u.telegram_chat_id,
          `🟢 <b>ORDER GRABBED</b>\nUser: ${userTag}\nOrder #: <code>${oid}</code>\nAmount: <b>${amt} SAR</b>\nPayment: ${payLabel}`,
        );
      } else {
        const reason = res.msg || `Network Grab Race Lost / Server Error (HTTP ${res.status})`;
        await log(u.id, u.slot, "warn", `Miss ${oid}: ${reason}`);
        await sendTelegram(
          u.telegram_bot_token,
          u.telegram_chat_id,
          `🔴 <b>ORDER MISSED</b>\nUser: ${userTag}\nOrder #: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${payLabel}\nReason: ${reason}`,
        );
      }
    });

  }

  if (newSeen.length) {
    const merged = Array.from(new Set([...(u.seen_order_ids || []), ...newSeen])).slice(-200);
    await supabaseAdmin.from("bot_users").update({ seen_order_ids: merged }).eq("id", u.id);
  }
}

/** Polls every active user, honoring per-user polling_interval_ms within a budget. */
export async function runPollCycle(budgetMs = 8000): Promise<{ ticked: number }> {
  const start = Date.now();
  const { data: users, error } = await supabaseAdmin
    .from("bot_users")
    .select("*")
    .eq("is_active", true);
  if (error || !users) return { ticked: 0 };

  // Iterate per-user with their own loops until budget exhausted
  const state = users.map((u) => ({ u: u as BotUser, nextAt: 0 }));
  let ticks = 0;

  while (Date.now() - start < budgetMs) {
    const now = Date.now();
    const due = state.filter((s) => s.nextAt <= now);
    if (due.length === 0) {
      const sleepMs = Math.max(50, Math.min(...state.map((s) => s.nextAt - now)));
      await sleep(sleepMs);
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
        s.nextAt = Date.now() + cleanCycleJitterMs();
      }),
    );
  }
  return { ticked: ticks };
}
