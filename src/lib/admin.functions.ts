// Server functions for the admin dashboard. Authorization is by master-session-token,
// not Supabase auth, so these are CALLABLE without a Supabase user. Every handler
// validates the session token against the admin_sessions table (server-only access).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getAdminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function requireSession(token: string) {
  if (!token) throw new Error("Unauthorized");
  const supabaseAdmin = await getAdminClient();
  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .select("token, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) throw new Error("Unauthorized");
  if (new Date(data.expires_at).getTime() < Date.now()) throw new Error("Session expired");
}

// ----- Master password setup / login -----

export const getSetupState = createServerFn({ method: "GET" }).handler(async () => {
  const supabaseAdmin = await getAdminClient();
  const { data } = await supabaseAdmin.from("app_config").select("master_password_hash").eq("id", 1).maybeSingle();
  return { needsSetup: !data?.master_password_hash };
});

export const setupMaster = createServerFn({ method: "POST" })
  .inputValidator((d: { password: string }) => z.object({ password: z.string().min(6).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const supabaseAdmin = await getAdminClient();
    const { data: cfg } = await supabaseAdmin.from("app_config").select("master_password_hash").eq("id", 1).maybeSingle();
    if (cfg?.master_password_hash) throw new Error("Master code already set");
    const salt = crypto.randomUUID();
    const hash = await sha256Hex(salt + ":" + data.password);
    await supabaseAdmin.from("app_config").update({ master_password_hash: hash, master_salt: salt }).eq("id", 1);
    return { ok: true };
  });

export const loginMaster = createServerFn({ method: "POST" })
  .inputValidator((d: { password: string }) => z.object({ password: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const supabaseAdmin = await getAdminClient();
    const { data: cfg } = await supabaseAdmin
      .from("app_config")
      .select("master_password_hash, master_salt")
      .eq("id", 1)
      .maybeSingle();
    if (!cfg?.master_password_hash || !cfg.master_salt) throw new Error("Master code not set");
    const hash = await sha256Hex(cfg.master_salt + ":" + data.password);
    if (hash !== cfg.master_password_hash) throw new Error("Incorrect master code");
    const { data: sess, error } = await supabaseAdmin
      .from("admin_sessions")
      .insert({})
      .select("token, expires_at")
      .single();
    if (error || !sess) throw new Error("Could not create session");
    return { token: sess.token as string, expires_at: sess.expires_at as string };
  });

export const logoutMaster = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const supabaseAdmin = await getAdminClient();
    await supabaseAdmin.from("admin_sessions").delete().eq("token", data.token);
    return { ok: true };
  });

// ----- Global admin Telegram settings -----

export const getAdminTelegramSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    const { data: row } = await supabaseAdmin
      .from("app_config")
      .select("admin_telegram_bot_token, admin_telegram_chat_id")
      .eq("id", 1)
      .maybeSingle();
    return {
      bot_token: (row?.admin_telegram_bot_token as string) || "",
      chat_id: (row?.admin_telegram_chat_id as string) || "",
    };
  });

export const setAdminTelegramSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        token: z.string().uuid(),
        bot_token: z.string().max(300).default(""),
        chat_id: z.string().max(100).default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    await supabaseAdmin
      .from("app_config")
      .update({
        admin_telegram_bot_token: data.bot_token,
        admin_telegram_chat_id: data.chat_id,
      } as never)
      .eq("id", 1);
    const { invalidateAdminTelegramCache } = await import("./bot-engine.server");
    invalidateAdminTelegramCache();
    return { ok: true };
  });

export const testAdminTelegram = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const { getAdminTelegram, sendTelegram } = await import("./bot-engine.server");
    const a = await getAdminTelegram(true);
    if (!a.bot_token || !a.chat_id) throw new Error("Admin Telegram not configured");
    const r = await sendTelegram(a.bot_token, a.chat_id, "✅ <b>Global Admin Telegram</b> connected. You will now receive mirrored alerts from every active slot.");
    if (!r.ok) throw new Error(r.error || "Telegram test failed");
    return { ok: true };
  });


// ----- Bot users CRUD -----

export const listUsers = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    const { data: rows, error } = await supabaseAdmin
      .from("bot_users")
      .select(
        "id,slot,label,username,password,telegram_bot_token,telegram_chat_id,min_price,max_price,payment_methods,polling_interval_ms,cooldown_seconds,is_active,status,status_message,last_polled_at,orders_grabbed,auth_token_at",
      )
      .order("slot", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

const updateSchema = z.object({
  token: z.string().uuid(),
  id: z.string().uuid(),
  patch: z
    .object({
      label: z.string().max(100).optional(),
      username: z.string().max(200).optional(),
      password: z.string().max(200).optional(),
      telegram_bot_token: z.string().max(300).optional(),
      telegram_chat_id: z.string().max(100).optional(),
      min_price: z.number().min(0).max(1e9).optional(),
      max_price: z.number().min(0).max(1e9).optional(),
      payment_methods: z.array(z.string().max(40)).max(20).optional(),
      polling_interval_ms: z.number().int().min(200).max(60000).optional(),
      cooldown_seconds: z.number().int().min(1).max(300).optional(),
      is_active: z.boolean().optional(),
    })
    .strict(),
});

export const updateUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => updateSchema.parse(d))
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    // If activating, clear stale state and trigger initial login
    const patch: Record<string, unknown> = { ...data.patch };
    if (data.patch.is_active === true) {
      patch.status = "starting";
      patch.status_message = "Authenticating...";
      patch.auth_token = null;
      patch.seen_order_ids = [];
    } else if (data.patch.is_active === false) {
      patch.status = "idle";
      patch.status_message = "";
      patch.auth_token = null;
      const { clearTokenPool } = await import("./bot-engine.server");
      clearTokenPool(data.id);
    }
    const { error } = await supabaseAdmin.from("bot_users").update(patch as never).eq("id", data.id);
    if (error) throw new Error(error.message);

    if (data.patch.is_active === true) {
      // Kick off an initial login + tick in the background (don't await fully)
      const { data: row } = await supabaseAdmin.from("bot_users").select("*").eq("id", data.id).single();
      if (row) {
        const { tickUser } = await import("./bot-engine.server");
        // fire and forget — but await briefly so login completes before response
        try {
          await tickUser(row as Parameters<typeof tickUser>[0]);
        } catch {
          /* logged inside */
        }
      }
    }
    return { ok: true };
  });

export const verifyUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        token: z.string().uuid(),
        id: z.string().uuid(),
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    await supabaseAdmin
      .from("bot_users")
      .update({
        username: data.username,
        password: data.password,
        is_active: false,
        auth_token: null,
        status: "starting",
        status_message: "Verifying credentials...",
      })
      .eq("id", data.id);

    let r: Response;
    try {
      r = await fetch("https://h5.parttime.mobi/prod-api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: data.username, password: data.password }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error";
      await supabaseAdmin
        .from("bot_users")
        .update({ status: "error", status_message: msg })
        .eq("id", data.id);
      return { ok: false as const, status: "error", message: msg };
    }
    const j = (await r.json().catch(() => ({}))) as { token?: string; code?: number; msg?: string };

    if (j.token) {
      await supabaseAdmin
        .from("bot_users")
        .update({
          auth_token: j.token,
          auth_token_at: new Date().toISOString(),
          status: "authorized",
          status_message: "Authorized — configure filters to start",
        })
        .eq("id", data.id);
      const { log } = await import("./bot-engine.server");
      await log(data.id, null, "success", "Credentials verified");
      return { ok: true as const };
    }

    const m = (j.msg || "").toLowerCase();
    let status = "error";
    let status_message = j.msg || `HTTP ${r.status}`;
    if (m.includes("password") || m.includes("user") || m.includes("account") || j.code === 500) {
      status = "invalid_creds";
      status_message = "Invalid Username or Password";
    } else if (m.includes("ban") || m.includes("forbid") || m.includes("permission") || j.code === 403) {
      status = "suspended";
      status_message = "No Permission / Account Suspended";
    }
    await supabaseAdmin
      .from("bot_users")
      .update({ status, status_message })
      .eq("id", data.id);
    return { ok: false as const, status, message: status_message };
  });

export const testTelegram = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        token: z.string().uuid(),
        bot_token: z.string().min(10),
        chat_id: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const { sendTelegram } = await import("./bot-engine.server");
    const r = await sendTelegram(data.bot_token, data.chat_id, "✅ Telegram configuration successful!");
    if (!r.ok) throw new Error(r.error || "Telegram test failed");
    return { ok: true };
  });

export const getLogs = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        token: z.string().uuid(),
        limit: z.number().int().min(1).max(500).default(80),
        slot: z.number().int().min(1).max(99).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    let q = supabaseAdmin
      .from("bot_logs")
      .select("id,slot,level,message,created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.slot !== undefined) q = q.eq("slot", data.slot);
    const { data: rows } = await q;
    return rows ?? [];
  });

export const clearLogs = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ token: z.string().uuid(), slot: z.number().int().min(1).max(99).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    let q = supabaseAdmin.from("bot_logs").delete();
    if (data.slot !== undefined) q = q.eq("slot", data.slot);
    else q = q.gte("id", 0);
    await q;
    return { ok: true };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ token: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const supabaseAdmin = await getAdminClient();
    const { data: row } = await supabaseAdmin
      .from("bot_users")
      .select("slot")
      .eq("id", data.id)
      .maybeSingle();
    await supabaseAdmin
      .from("bot_users")
      .update({
        label: "",
        username: "",
        password: "",
        telegram_bot_token: "",
        telegram_chat_id: "",
        min_price: 0,
        max_price: 999999,
        payment_methods: [],
        polling_interval_ms: 1000,
        cooldown_seconds: 10,
        is_active: false,
        auth_token: null,
        auth_token_at: null,
        status: "idle",
        status_message: "",
        seen_order_ids: [],
        orders_grabbed: 0,
        last_polled_at: null,
      } as never)
      .eq("id", data.id);
    if (row?.slot) await supabaseAdmin.from("bot_logs").delete().eq("slot", row.slot);
    return { ok: true };
  });

export const manualPoll = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireSession(data.token);
    const { runPollCycle } = await import("./bot-engine.server");
    const r = await runPollCycle(5000);
    return r;
  });
