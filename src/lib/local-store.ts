// Browser-only persistence layer. Holds the master password (salted SHA-256,
// never the plaintext), the local unlock session and all 15 slot configs so the
// bot fully works with no backend database available.

export type LocalSlot = {
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
  seen_order_ids: string[];
};

type LocalState = {
  master: { salt: string; hash: string } | null;
  session: { token: string; expires: number } | null;
  admin: { bot_token: string; chat_id: string };
  slots: LocalSlot[];
};

const STATE_KEY = "orb_local_state_v1";
const SLOT_COUNT = 15;
const SESSION_MS = 12 * 60 * 60 * 1000;

function blankSlot(slot: number): LocalSlot {
  return {
    id: `local-${slot}`,
    slot,
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
    status: "idle",
    status_message: "",
    last_polled_at: null,
    orders_grabbed: 0,
    auth_token_at: null,
    seen_order_ids: [],
  };
}

function emptyState(): LocalState {
  return {
    master: null,
    session: null,
    admin: { bot_token: "", chat_id: "" },
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => blankSlot(i + 1)),
  };
}

let cache: LocalState | null = null;

export function readState(): LocalState {
  if (cache) return cache;
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalState>;
      const base = emptyState();
      cache = {
        master: parsed.master ?? null,
        session: parsed.session ?? null,
        admin: { ...base.admin, ...(parsed.admin ?? {}) },
        slots: base.slots.map((s, i) => ({ ...s, ...(parsed.slots?.[i] ?? {}), id: s.id, slot: s.slot })),
      };
      return cache;
    }
  } catch {
    /* corrupted local data -> start fresh */
  }
  cache = emptyState();
  return cache;
}

function writeState(next: LocalState): void {
  cache = next;
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / full storage: keep working from memory */
  }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----- master password -----

export function localNeedsSetup(): boolean {
  return !readState().master;
}

export async function setupLocalMaster(password: string): Promise<void> {
  const st = readState();
  if (st.master) throw new Error("Local master code already set");
  const salt = crypto.randomUUID();
  writeState({ ...st, master: { salt, hash: await sha256Hex(salt + ":" + password) } });
}

export async function loginLocalMaster(password: string): Promise<{ token: string }> {
  const st = readState();
  if (!st.master) throw new Error("Local master code not set");
  const hash = await sha256Hex(st.master.salt + ":" + password);
  if (hash !== st.master.hash) throw new Error("Incorrect master code");
  const token = crypto.randomUUID();
  writeState({ ...st, session: { token, expires: Date.now() + SESSION_MS } });
  return { token };
}

export function isLocalSessionValid(token: string): boolean {
  const s = readState().session;
  return !!s && s.token === token && s.expires > Date.now();
}

export function logoutLocal(): void {
  const st = readState();
  writeState({ ...st, session: null });
}

/** Copy an existing cloud master code locally so browser mode unlocks with the same code. */
export async function mirrorMasterLocally(password: string): Promise<void> {
  const st = readState();
  const salt = st.master?.salt ?? crypto.randomUUID();
  writeState({ ...st, master: { salt, hash: await sha256Hex(salt + ":" + password) } });
}

// ----- slots -----

export function listLocalSlots(): LocalSlot[] {
  return readState().slots.map((s) => ({ ...s }));
}

export function getLocalSlot(id: string): LocalSlot | undefined {
  return readState().slots.find((s) => s.id === id);
}

export function activeLocalSlots(): LocalSlot[] {
  return readState().slots.filter((s) => s.is_active);
}

export function patchLocalSlot(id: string, patch: Partial<LocalSlot>): LocalSlot | undefined {
  const st = readState();
  let updated: LocalSlot | undefined;
  const slots = st.slots.map((s) => {
    if (s.id !== id) return s;
    updated = { ...s, ...patch };
    return updated;
  });
  writeState({ ...st, slots });
  return updated;
}

export function resetLocalSlot(id: string): void {
  const st = readState();
  const slots = st.slots.map((s) => (s.id === id ? blankSlot(s.slot) : s));
  writeState({ ...st, slots });
}

// ----- admin telegram -----

export function getLocalAdminTelegram(): { bot_token: string; chat_id: string } {
  return { ...readState().admin };
}

export function setLocalAdminTelegram(bot_token: string, chat_id: string): void {
  const st = readState();
  writeState({ ...st, admin: { bot_token, chat_id } });
}
