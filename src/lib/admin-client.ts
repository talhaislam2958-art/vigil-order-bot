export type BotUserRow = {
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
  status: string;
  status_message: string;
  last_polled_at: string | null;
  orders_grabbed: number;
  auth_token_at: string | null;
};

export type LogRow = {
  id: number;
  slot: number | null;
  level: string;
  message: string;
  created_at: string;
};

type Envelope<T> = { data: T };

async function callAdmin<T>(action: string, data: unknown = {}): Promise<T> {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, data }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.result as T;
}

export const getSetupState = () => callAdmin<{ needsSetup: boolean }>("getSetupState");
export const setupMaster = ({ data }: Envelope<{ password: string }>) => callAdmin<{ ok: true }>("setupMaster", data);
export const loginMaster = ({ data }: Envelope<{ password: string }>) => callAdmin<{ token: string; expires_at: string }>("loginMaster", data);
export const logoutMaster = ({ data }: Envelope<{ token: string }>) => callAdmin<{ ok: true }>("logoutMaster", data);
export const listUsers = ({ data }: Envelope<{ token: string }>) => callAdmin<BotUserRow[]>("listUsers", data);
export const updateUser = ({ data }: Envelope<{ token: string; id: string; patch: Partial<BotUserRow> }>) => callAdmin<{ ok: true }>("updateUser", data);
export const verifyUser = ({ data }: Envelope<{ token: string; id: string; username: string; password: string }>) => callAdmin<{ ok: boolean; status?: string; message?: string }>("verifyUser", data);
export const testTelegram = ({ data }: Envelope<{ token: string; bot_token: string; chat_id: string }>) => callAdmin<{ ok: true }>("testTelegram", data);
export const getLogs = ({ data }: Envelope<{ token: string; limit: number; slot?: number }>) => callAdmin<LogRow[]>("getLogs", data);
export const clearLogs = ({ data }: Envelope<{ token: string; slot?: number }>) => callAdmin<{ ok: true }>("clearLogs", data);
export const manualPoll = ({ data }: Envelope<{ token: string }>) => callAdmin<{ ticked: number }>("manualPoll", data);
export const deleteUser = ({ data }: Envelope<{ token: string; id: string }>) => callAdmin<{ ok: true }>("deleteUser", data);
export const getAdminTelegramSettings = ({ data }: Envelope<{ token: string }>) => callAdmin<{ bot_token: string; chat_id: string }>("getAdminTelegramSettings", data);
export const setAdminTelegramSettings = ({ data }: Envelope<{ token: string; bot_token: string; chat_id: string }>) => callAdmin<{ ok: true }>("setAdminTelegramSettings", data);
export const testAdminTelegram = ({ data }: Envelope<{ token: string }>) => callAdmin<{ ok: true }>("testAdminTelegram", data);
