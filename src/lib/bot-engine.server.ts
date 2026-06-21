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

async function getOrderList(token: string): Promise<{ status: number; rows: OrderRow[]; raw: unknown }> {
  const r = await fetch(
    `${BASE}/bus/user/order/list?pageNum=1&pageSize=15&orderByColumn=createTime+asc,&receiverName=&isAsc=asc`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const j = (await r.json().catch(() => ({}))) as { rows?: OrderRow[]; code?: number };
  return { status: r.status, rows: Array.isArray(j.rows) ? j.rows : [], raw: j };
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
  const r = await fetch(`${BASE}/bus/user/order/receive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId }),
  });
  const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string };
  return { status: r.status, ok: j.code === 200 || r.ok, msg: j.msg };
}

/** Run one polling tick for one user. Re-logins automatically on 401/token errors. */
export async function tickUser(u: BotUser): Promise<void> {
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
  if (list.status !== 200) {
    await log(u.id, u.slot, "error", `getOrderList HTTP ${list.status}`);
    return;
  }

  await supabaseAdmin
    .from("bot_users")
    .update({ last_polled_at: new Date().toISOString(), status: "running", status_message: "Authorized / Running" })
    .eq("id", u.id);

  const seen = new Set(u.seen_order_ids || []);
  const allowed = (u.payment_methods || []).map((s) => s.toLowerCase());
  const newSeen: string[] = [];

  for (const o of list.rows) {
    const oid = pickOrderId(o);
    if (!oid || seen.has(oid)) continue;
    newSeen.push(oid);
    const amt = pickAmount(o);
    const pay = pickPayment(o);

    if (amt < Number(u.min_price) || amt > Number(u.max_price)) continue;
    if (allowed.length > 0 && !allowed.some((p) => pay.includes(p))) continue;

    const res = await receiveOrder(token, oid);
    if (res.ok) {
      await supabaseAdmin.rpc("noop").catch(() => {});
      await supabaseAdmin
        .from("bot_users")
        .update({ orders_grabbed: (u.orders_grabbed || 0) + 1 })
        .eq("id", u.id);
      u.orders_grabbed = (u.orders_grabbed || 0) + 1;
      await log(u.id, u.slot, "success", `Grabbed order ${oid} amount=${amt} pay=${pay}`);
      await sendTelegram(
        u.telegram_bot_token,
        u.telegram_chat_id,
        `🎯 <b>Order grabbed</b>\nUser: ${u.label || u.username}\nOrder ID: <code>${oid}</code>\nAmount: ${amt} SAR\nPayment: ${pay}`,
      );
    } else {
      await log(u.id, u.slot, "warn", `Receive failed for ${oid}: ${res.msg || res.status}`);
    }
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
      const sleep = Math.max(50, Math.min(...state.map((s) => s.nextAt - now)));
      await new Promise((r) => setTimeout(r, sleep));
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
        s.nextAt = Date.now() + Math.max(200, s.u.polling_interval_ms);
      }),
    );
  }
  return { ticked: ticks };
}
