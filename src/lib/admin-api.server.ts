import { z } from "zod";

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function requireSession(token: string) {
  if (!token) throw new Error("Unauthorized");
  const client = await db();
  const { data, error } = await client.from("admin_sessions").select("token, expires_at").eq("token", token).maybeSingle();
  if (error || !data) throw new Error("Unauthorized");
  if (new Date(data.expires_at).getTime() < Date.now()) throw new Error("Session expired");
}

const updateSchema = z.object({
  token: z.string().uuid(), id: z.string().uuid(),
  patch: z.object({
    label: z.string().max(100).optional(), username: z.string().max(200).optional(), password: z.string().max(200).optional(),
    telegram_bot_token: z.string().max(300).optional(), telegram_chat_id: z.string().max(100).optional(),
    min_price: z.number().min(0).max(1e9).optional(), max_price: z.number().min(0).max(1e9).optional(),
    payment_methods: z.array(z.string().max(40)).max(20).optional(), polling_interval_ms: z.number().int().min(200).max(60000).optional(),
    cooldown_seconds: z.number().int().min(1).max(300).optional(), is_active: z.boolean().optional(),
  }).strict(),
});

const requestSchema = z.object({ action: z.string().min(1).max(60), data: z.unknown().default({}) });

export async function handleAdminRequest(input: unknown): Promise<unknown> {
  const { action, data: raw } = requestSchema.parse(input);
  const client = await db();

  if (action === "getSetupState") {
    const { data } = await client.from("app_config").select("master_password_hash").eq("id", 1).maybeSingle();
    return { needsSetup: !data?.master_password_hash };
  }
  if (action === "setupMaster") {
    const data = z.object({ password: z.string().min(6).max(200) }).parse(raw);
    const { data: cfg } = await client.from("app_config").select("master_password_hash").eq("id", 1).maybeSingle();
    if (cfg?.master_password_hash) throw new Error("Master code already set");
    const salt = crypto.randomUUID();
    await client.from("app_config").update({ master_password_hash: await sha256Hex(`${salt}:${data.password}`), master_salt: salt }).eq("id", 1);
    return { ok: true };
  }
  if (action === "loginMaster") {
    const data = z.object({ password: z.string().min(1).max(200) }).parse(raw);
    const { data: cfg } = await client.from("app_config").select("master_password_hash, master_salt").eq("id", 1).maybeSingle();
    if (!cfg?.master_password_hash || !cfg.master_salt) throw new Error("Master code not set");
    if (await sha256Hex(`${cfg.master_salt}:${data.password}`) !== cfg.master_password_hash) throw new Error("Incorrect master code");
    const { data: session, error } = await client.from("admin_sessions").insert({}).select("token, expires_at").single();
    if (error || !session) throw new Error("Could not create session");
    return session;
  }

  const tokenData = z.object({ token: z.string().uuid() }).passthrough().parse(raw);
  await requireSession(tokenData.token);

  if (action === "logoutMaster") {
    await client.from("admin_sessions").delete().eq("token", tokenData.token);
    return { ok: true };
  }
  if (action === "listUsers") {
    const { data, error } = await client.from("bot_users").select("id,slot,label,username,password,telegram_bot_token,telegram_chat_id,min_price,max_price,payment_methods,polling_interval_ms,cooldown_seconds,is_active,status,status_message,last_polled_at,orders_grabbed,auth_token_at").order("slot", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  if (action === "getAdminTelegramSettings") {
    const { data } = await client.from("app_config").select("admin_telegram_bot_token, admin_telegram_chat_id").eq("id", 1).maybeSingle();
    return { bot_token: data?.admin_telegram_bot_token || "", chat_id: data?.admin_telegram_chat_id || "" };
  }
  if (action === "setAdminTelegramSettings") {
    const data = z.object({ token: z.string().uuid(), bot_token: z.string().max(300), chat_id: z.string().max(100) }).parse(raw);
    await client.from("app_config").update({ admin_telegram_bot_token: data.bot_token, admin_telegram_chat_id: data.chat_id } as never).eq("id", 1);
    const { invalidateAdminTelegramCache } = await import("./bot-engine.server");
    invalidateAdminTelegramCache();
    return { ok: true };
  }
  if (action === "testAdminTelegram") {
    const { getAdminTelegram, sendTelegram } = await import("./bot-engine.server");
    const settings = await getAdminTelegram(true);
    if (!settings.bot_token || !settings.chat_id) throw new Error("Admin Telegram not configured");
    const sent = await sendTelegram(settings.bot_token, settings.chat_id, "✅ <b>Global Admin Telegram</b> connected. You will now receive mirrored alerts from every active slot.");
    if (!sent.ok) throw new Error(sent.error || "Telegram test failed");
    return { ok: true };
  }
  if (action === "updateUser") {
    const data = updateSchema.parse(raw);
    const patch: Record<string, unknown> = { ...data.patch };
    if (data.patch.is_active === true) Object.assign(patch, { status: "starting", status_message: "Authenticating...", auth_token: null, seen_order_ids: [] });
    if (data.patch.is_active === false) {
      Object.assign(patch, { status: "idle", status_message: "", auth_token: null });
      const { clearTokenPool } = await import("./bot-engine.server");
      clearTokenPool(data.id);
    }
    const { error } = await client.from("bot_users").update(patch as never).eq("id", data.id);
    if (error) throw new Error(error.message);
    if (data.patch.is_active === true) {
      const { data: row } = await client.from("bot_users").select("*").eq("id", data.id).single();
      if (row) {
        const { tickUser } = await import("./bot-engine.server");
        await tickUser(row as Parameters<typeof tickUser>[0]).catch(() => {});
      }
    }
    return { ok: true };
  }
  if (action === "verifyUser") {
    const data = z.object({ token: z.string().uuid(), id: z.string().uuid(), username: z.string().min(1).max(200), password: z.string().min(1).max(200) }).parse(raw);
    await client.from("bot_users").update({ username: data.username, password: data.password, is_active: false, auth_token: null, status: "starting", status_message: "Verifying credentials..." }).eq("id", data.id);
    let response: Response;
    try {
      response = await fetch("https://h5.parttime.mobi/prod-api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.username, password: data.password }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      await client.from("bot_users").update({ status: "error", status_message: message }).eq("id", data.id);
      return { ok: false, status: "error", message };
    }
    const body = await response.json().catch(() => ({})) as { token?: string; code?: number; msg?: string };
    if (body.token) {
      await client.from("bot_users").update({ auth_token: body.token, auth_token_at: new Date().toISOString(), status: "authorized", status_message: "Authorized — configure filters to start" }).eq("id", data.id);
      const { log } = await import("./bot-engine.server");
      await log(data.id, null, "success", "Credentials verified");
      return { ok: true };
    }
    const text = (body.msg || "").toLowerCase();
    let status = "error"; let message = body.msg || `HTTP ${response.status}`;
    if (/password|user|account/.test(text) || body.code === 500) { status = "invalid_creds"; message = "Invalid Username or Password"; }
    else if (/ban|forbid|permission/.test(text) || body.code === 403) { status = "suspended"; message = "No Permission / Account Suspended"; }
    await client.from("bot_users").update({ status, status_message: message }).eq("id", data.id);
    return { ok: false, status, message };
  }
  if (action === "testTelegram") {
    const data = z.object({ token: z.string().uuid(), bot_token: z.string().min(10), chat_id: z.string().min(1) }).parse(raw);
    const { sendTelegram } = await import("./bot-engine.server");
    const sent = await sendTelegram(data.bot_token, data.chat_id, "✅ Telegram configuration successful!");
    if (!sent.ok) throw new Error(sent.error || "Telegram test failed");
    return { ok: true };
  }
  if (action === "getLogs") {
    const data = z.object({ token: z.string().uuid(), limit: z.number().int().min(1).max(500).default(80), slot: z.number().int().min(1).max(99).optional() }).parse(raw);
    let query = client.from("bot_logs").select("id,slot,level,message,created_at").order("created_at", { ascending: false }).limit(data.limit);
    if (data.slot !== undefined) query = query.eq("slot", data.slot);
    const { data: rows } = await query;
    return rows ?? [];
  }
  if (action === "clearLogs") {
    const data = z.object({ token: z.string().uuid(), slot: z.number().int().min(1).max(99).optional() }).parse(raw);
    let query = client.from("bot_logs").delete();
    query = data.slot !== undefined ? query.eq("slot", data.slot) : query.gte("id", 0);
    await query;
    return { ok: true };
  }
  if (action === "deleteUser") {
    const data = z.object({ token: z.string().uuid(), id: z.string().uuid() }).parse(raw);
    const { clearTokenPool } = await import("./bot-engine.server"); clearTokenPool(data.id);
    const { data: row } = await client.from("bot_users").select("slot").eq("id", data.id).maybeSingle();
    await client.from("bot_users").update({ label: "", username: "", password: "", telegram_bot_token: "", telegram_chat_id: "", min_price: 0, max_price: 999999, payment_methods: [], polling_interval_ms: 1000, cooldown_seconds: 10, is_active: false, auth_token: null, auth_token_at: null, status: "idle", status_message: "", seen_order_ids: [], orders_grabbed: 0, last_polled_at: null } as never).eq("id", data.id);
    if (row?.slot) await client.from("bot_logs").delete().eq("slot", row.slot);
    return { ok: true };
  }
  if (action === "manualPoll") {
    const { runPollCycle } = await import("./bot-engine.server");
    return runPollCycle(5000);
  }
  throw new Error("Unknown action");
}
