import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  Eraser,
  Gauge,
  Loader2,
  LogOut,
  Moon,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  Sun,
  Terminal,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  getSetupState,
  setupMaster,
  loginMaster,
  logoutMaster,
  listUsers,
  updateUser,
  verifyUser,
  testTelegram,
  getLogs,
  clearLogs,
  manualPoll,
  deleteUser,
  getAdminTelegramSettings,
  setAdminTelegramSettings,
  testAdminTelegram,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Order Receiver Bot — Cyber Control Center" },
      { name: "description", content: "Multi-user 24/7 order receiver bot dashboard with neon cyber UI and Telegram alerts." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: App,
});

const TOKEN_KEY = "orb_master_token";
const THEME_KEY = "orb_theme";

type Theme = "dark" | "light";

const PAYMENT_OPTIONS: { key: string; label: string }[] = [
  { key: "stcpay", label: "STC Pay" },
  { key: "urpay", label: "Urpay" },
  { key: "barq", label: "Barq" },
  { key: "bank", label: "Banks" },
];

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const saved = (typeof window !== "undefined" && (localStorage.getItem(THEME_KEY) as Theme)) || "dark";
    setTheme(saved);
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [bootChecked, setBootChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [theme, setTheme] = useTheme();
  const checkSetup = useServerFn(getSetupState);

  useEffect(() => {
    setToken(typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null);
    checkSetup()
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => {})
      .finally(() => setBootChecked(true));
  }, [checkSetup]);

  if (!bootChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin neon-text" />
      </div>
    );
  }

  if (!token) {
    return (
      <>
        <Toaster theme={theme} position="top-right" />
        <Gate
          needsSetup={needsSetup}
          onUnlocked={(t) => {
            localStorage.setItem(TOKEN_KEY, t);
            setToken(t);
          }}
          onSetupDone={() => setNeedsSetup(false)}
        />
      </>
    );
  }

  return (
    <>
      <Toaster theme={theme} position="top-right" />
      <Dashboard
        token={token}
        theme={theme}
        setTheme={setTheme}
        onLogout={() => {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
        }}
      />
    </>
  );
}

function Gate({
  needsSetup,
  onUnlocked,
  onSetupDone,
}: {
  needsSetup: boolean;
  onUnlocked: (t: string) => void;
  onSetupDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const setup = useServerFn(setupMaster);
  const login = useServerFn(loginMaster);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (needsSetup) {
        if (pw.length < 6) throw new Error("Use at least 6 characters");
        if (pw !== pw2) throw new Error("Passwords do not match");
        await setup({ data: { password: pw } });
        toast.success("Master code set. Please sign in.");
        onSetupDone();
        setPw("");
        setPw2("");
      } else {
        const r = await login({ data: { password: pw } });
        onUnlocked(r.token);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="cyber-card w-full max-w-sm rounded-2xl p-8"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="neon-border grid size-11 place-items-center rounded-xl bg-background">
            <ShieldCheck className="size-5 neon-text" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-wide neon-text">ORDER RECEIVER // BOT</h1>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {needsSetup ? "Initialize master code" : "Master access required"}
            </p>
          </div>
        </div>
        <label className="mb-2 block text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Master code
        </label>
        <input
          autoFocus
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="••••••••"
        />
        {needsSetup && (
          <>
            <label className="mt-4 mb-2 block text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Confirm code
            </label>
            <input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
            />
          </>
        )}
        <button
          disabled={busy}
          className="neon-border mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {needsSetup ? "Initialize" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

type BotUser = Awaited<ReturnType<typeof listUsers>>[number];
type LogRow = Awaited<ReturnType<typeof getLogs>>[number];

function Dashboard({ token, onLogout, theme, setTheme }: { token: string; onLogout: () => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const router = useRouter();
  const list = useServerFn(listUsers);
  const logoutFn = useServerFn(logoutMaster);
  const pollFn = useServerFn(manualPoll);
  const getLogsFn = useServerFn(getLogs);
  const [users, setUsers] = useState<BotUser[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  async function refresh() {
    try {
      const [u, l] = await Promise.all([
        list({ data: { token } }),
        getLogsFn({ data: { token, limit: 200 } }),
      ]);
      setUsers(u);
      setLogs(l);
    } catch (e) {
      if (e instanceof Error && /unauthor|session/i.test(e.message)) {
        toast.error("Session expired");
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const activeCount = useMemo(() => users.filter((u) => u.is_active).length, [users]);
  const totalGrabs = useMemo(() => users.reduce((s, u) => s + (u.orders_grabbed || 0), 0), [users]);

  return (
    <div className="min-h-screen w-full overflow-x-hidden">
      <header className="sticky top-0 z-10 w-full border-b border-border/60 bg-background">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:flex sm:flex-wrap sm:justify-between sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="neon-border grid size-10 shrink-0 place-items-center rounded-xl bg-background">
              <Bot className="size-5 neon-text" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold uppercase tracking-widest neon-text">
                Order Receiver // 24/7
              </h1>
              <p className="truncate text-[11px] font-mono text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="pulse-dot inline-block size-1.5 rounded-full bg-[var(--neon)]" />
                  ONLINE
                </span>
                {" · "}
                <span className="text-foreground">{activeCount}</span>a
                {" · "}
                <span className="text-foreground">{totalGrabs}</span>g
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="Toggle theme"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider hover:bg-surface-2"
            >
              {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button
              onClick={async () => {
                setPolling(true);
                try {
                  const r = await pollFn({ data: { token } });
                  toast.success(`Manual poll · ${r.ticked} ticks`);
                  await refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setPolling(false);
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider hover:bg-surface-2"
            >
              {polling ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5 neon-text" />}
              Run cycle
            </button>
            <button
              onClick={() => router.invalidate().then(refresh)}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider hover:bg-surface-2"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </button>
            <button
              onClick={async () => {
                await logoutFn({ data: { token } }).catch(() => {});
                onLogout();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider hover:bg-surface-2"
            >
              <LogOut className="size-3.5" />
              Lock
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl gap-6 px-3 py-6 sm:px-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 space-y-4">
          {loading && users.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            users.map((u) => (
              <UserCard
                key={u.id}
                u={u}
                token={token}
                logs={logs.filter((l) => l.slot === u.slot).slice(0, 12)}
                onChanged={refresh}
              />
            ))
          )}
        </section>

        <aside className="min-w-0 space-y-3 lg:sticky lg:top-20 lg:self-start">
          <div className="cyber-card w-full rounded-2xl p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Activity className="size-4 shrink-0 neon-text" />
                <h2 className="truncate text-xs font-bold uppercase tracking-widest">Global Activity</h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">{logs.length}</span>
                <button
                  onClick={async () => {
                    try {
                      const { clearLogs: clr } = await import("@/lib/admin.functions");
                      await clr({ data: { token } });
                      await refresh();
                      toast.success("Global logs cleared");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  <Eraser className="size-3" />
                  Clear
                </button>
              </div>
            </div>
            <div className="terminal max-h-[60vh] w-full space-y-1 overflow-y-auto overflow-x-hidden rounded-lg p-3 text-[11px]">
              {logs.length === 0 && <p className="text-muted-foreground">// no activity yet</p>}
              {logs.map((l) => (
                <LogLine key={l.id} l={l} />
              ))}
            </div>
          </div>
          <AdminTelegramPanel token={token} />
          <div className="w-full rounded-xl border border-border/60 bg-surface/40 p-3 text-[11px] text-muted-foreground">
            <p className="font-bold uppercase tracking-widest text-foreground">⚡ 24/7 Cloud Engine</p>
            <p className="mt-1 font-mono">
              Runs on built-in cloud (Edge + scheduled jobs every ~10s). Keeps running when your browser is closed.
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function AdminTelegramPanel({ token }: { token: string }) {
  const getFn = useServerFn(getAdminTelegramSettings);
  const setFn = useServerFn(setAdminTelegramSettings);
  const testFn = useServerFn(testAdminTelegram);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let alive = true;
    getFn({ data: { token } })
      .then((r) => {
        if (!alive) return;
        setBotToken(r.bot_token || "");
        setChatId(r.chat_id || "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, [token, getFn]);

  async function save() {
    setSaving(true);
    try {
      await setFn({ data: { token, bot_token: botToken.trim(), chat_id: chatId.trim() } });
      toast.success("Global admin Telegram saved · mirroring active");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }
  async function testIt() {
    setTesting(true);
    try {
      await testFn({ data: { token } });
      toast.success("Admin Telegram test sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setTesting(false);
    }
  }

  const configured = !!(botToken && chatId);

  return (
    <div className="cyber-card w-full rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 neon-text" />
          <h2 className="truncate text-xs font-bold uppercase tracking-widest">Global Admin Telegram</h2>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
            configured ? "bg-[var(--neon)]/15 text-[var(--neon)]" : "bg-muted text-muted-foreground"
          }`}
        >
          {configured ? "Mirror ON" : "Mirror OFF"}
        </span>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">
        Mirrors every slot's notifications (detected · grabbed · skipped · cooldown) into one master admin chat.
      </p>
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Admin Bot Token
          </span>
          <input
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF…"
            disabled={!loaded}
            className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Admin Chat ID
          </span>
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="-1001234567890"
            disabled={!loaded}
            className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            autoComplete="off"
          />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={testIt}
          disabled={testing || !configured}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-surface-2 disabled:opacity-50"
        >
          {testing ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
          Test
        </button>
        <button
          onClick={save}
          disabled={saving || !loaded}
          className="neon-border inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

function LogLine({ l }: { l: LogRow }) {
  const color =
    l.level === "error"
      ? "text-[var(--neon-red)]"
      : l.level === "success"
        ? "text-[var(--neon)]"
        : l.level === "warn"
          ? "text-[var(--warning)]"
          : "text-foreground/90";
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">
        {new Date(l.created_at).toLocaleTimeString()}
      </span>
      <span className={`shrink-0 ${color}`}>
        [{l.slot ?? "·"}]
      </span>
      <span className={color}>{l.message}</span>
    </div>
  );
}

function StatusPill({ status, msg }: { status: string; msg: string }) {
  const map: Record<string, { c: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
    idle: { c: "bg-muted text-muted-foreground", label: "Not configured", Icon: CircleDot },
    starting: { c: "bg-warning/20 text-warning", label: "Verifying…", Icon: Loader2 },
    authorized: { c: "bg-success/15 text-success", label: "Authorized · idle", Icon: ShieldCheck },
    running: { c: "bg-[var(--neon)]/15 text-[var(--neon)] neon-border", label: "RUNNING", Icon: CheckCircle2 },
    invalid_creds: { c: "bg-destructive/20 text-destructive neon-red-border", label: "Invalid credentials", Icon: XCircle },
    suspended: { c: "bg-destructive/20 text-destructive neon-red-border", label: "Suspended", Icon: XCircle },
    error: { c: "bg-destructive/20 text-destructive", label: msg || "Error", Icon: XCircle },
  };
  const s = map[status] ?? map.idle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${s.c}`}>
      <s.Icon className={`size-3 ${status === "starting" ? "animate-spin" : ""}`} />
      {s.label}
    </span>
  );
}

function StepBadge({ n, state, label }: { n: number; state: "done" | "active" | "locked"; label: string }) {
  const styles =
    state === "done"
      ? "bg-[var(--neon)] text-primary-foreground border-[var(--neon)]"
      : state === "active"
        ? "bg-background text-[var(--neon)] neon-border"
        : "bg-surface text-muted-foreground border-border";
  return (
    <div className="flex items-center gap-2">
      <div className={`grid size-6 place-items-center rounded-full border text-[11px] font-bold ${styles}`}>
        {state === "done" ? <CheckCircle2 className="size-3.5" /> : n}
      </div>
      <span className={`text-[10px] font-bold uppercase tracking-widest ${state === "locked" ? "text-muted-foreground" : "text-foreground"}`}>
        {label}
      </span>
    </div>
  );
}

function UserCard({
  u,
  token,
  logs,
  onChanged,
}: {
  u: BotUser;
  token: string;
  logs: LogRow[];
  onChanged: () => void;
}) {
  const updateFn = useServerFn(updateUser);
  const verifyFn = useServerFn(verifyUser);
  const testFn = useServerFn(testTelegram);
  const clearFn = useServerFn(clearLogs);
  const deleteFn = useServerFn(deleteUser);

  const isVerified = u.status === "authorized" || u.status === "running" || !!u.auth_token_at;

  const [username, setUsername] = useState(u.username ?? "");
  const [password, setPassword] = useState(u.password ?? "");
  const [verifying, setVerifying] = useState(false);

  const [local, setLocal] = useState<Partial<BotUser>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setUsername(u.username ?? "");
    setPassword(u.password ?? "");
    setLocal({});
  }, [u.id, u.username, u.password]);

  const v = { ...u, ...local };
  const credsDirty = username !== (u.username ?? "") || password !== (u.password ?? "");

  async function verify() {
    if (!username.trim() || !password.trim()) return toast.error("Enter username and password");
    setVerifying(true);
    try {
      const r = await verifyFn({ data: { token, id: u.id, username: username.trim(), password } });
      if (r.ok) toast.success(`Slot ${u.slot} authorized`);
      else toast.error(r.message || "Verification failed");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setVerifying(false);
    }
  }

  async function saveAndStart() {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { ...local, is_active: true };
      await updateFn({ data: { token, id: u.id, patch: patch as never } });
      setLocal({});
      toast.success(`Slot ${u.slot} live · grabbing orders`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function stop() {
    setStopping(true);
    try {
      await updateFn({ data: { token, id: u.id, patch: { is_active: false } as never } });
      toast.success(`Slot ${u.slot} stopped`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setStopping(false);
    }
  }

  async function tgTest() {
    if (!v.telegram_bot_token || !v.telegram_chat_id) return toast.error("Set bot token and chat id first");
    setTesting(true);
    try {
      await testFn({ data: { token, bot_token: v.telegram_bot_token, chat_id: v.telegram_chat_id } });
      toast.success("Telegram test sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Telegram failed");
    } finally {
      setTesting(false);
    }
  }

  async function clearMyLogs() {
    setClearing(true);
    try {
      await clearFn({ data: { token, slot: u.slot } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setClearing(false);
    }
  }

  async function del() {
    if (typeof window !== "undefined" && !window.confirm(`Delete slot ${u.slot}? This stops polling and clears all credentials & filters.`)) return;
    setDeleting(true);
    try {
      await deleteFn({ data: { token, id: u.id } });
      toast.success(`Slot ${u.slot} reset`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setDeleting(false);
    }
  }

  const setF = <K extends keyof BotUser>(k: K, val: BotUser[K]) =>
    setLocal((p) => ({ ...p, [k]: val }));

  const togglePay = (p: string) => {
    const cur = new Set(v.payment_methods || []);
    if (cur.has(p)) cur.delete(p);
    else cur.add(p);
    setF("payment_methods", Array.from(cur));
  };

  const cooldownSec = (v as BotUser & { cooldown_seconds?: number }).cooldown_seconds ?? 10;

  const step1State: "done" | "active" | "locked" = isVerified ? "done" : "active";
  const step2State: "done" | "active" | "locked" = !isVerified ? "locked" : v.is_active ? "done" : "active";

  const lockedFail = u.status === "invalid_creds" || u.status === "suspended";
  const running = v.is_active;

  // No local simulation — every log line below is a real server event from bot_logs.



  return (
    <article
      className={`cyber-card overflow-hidden rounded-2xl transition ${
        running ? "neon-border" : lockedFail ? "neon-red-border" : ""
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/40 px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background font-mono text-sm font-bold neon-text">
            {String(u.slot).padStart(2, "0")}
          </div>
          <input
            value={v.label ?? ""}
            onChange={(e) => setF("label", e.target.value)}
            placeholder={`USER-${u.slot}`}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-bold tracking-wide hover:border-border focus:border-border focus:outline-none"
          />
          <StatusPill status={v.status} msg={v.status_message} />
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Grabs <b className="neon-text">{v.orders_grabbed}</b>
          </span>
          {running && (
            <button
              onClick={stop}
              disabled={stopping}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider hover:bg-surface-2 disabled:opacity-60"
            >
              {stopping ? <Loader2 className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
              Stop
            </button>
          )}
          <button
            onClick={del}
            disabled={deleting}
            title="Delete user / reset slot"
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-destructive hover:bg-destructive/20 disabled:opacity-60"
          >
            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Delete
          </button>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-4 border-b border-border/60 px-4 py-2.5">
        <StepBadge n={1} state={step1State} label="Credentials" />
        <div className="h-px flex-1 bg-border/60" />
        <StepBadge n={2} state={step2State} label="Filters & Telegram" />
      </div>

      {/* Step 1 */}
      <div className="px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Step 1 · Verify credentials
          </h3>
          {isVerified && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest neon-text">
              <CheckCircle2 className="size-3.5" /> Verified
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Username / Phone">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={input}
              autoComplete="off"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
              autoComplete="off"
            />
          </Field>
          <div className="flex items-end">
            <button
              onClick={verify}
              disabled={verifying || (!credsDirty && isVerified)}
              className="neon-border inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-bold uppercase tracking-wider text-primary-foreground transition hover:opacity-90 disabled:opacity-50 sm:w-auto"
            >
              {verifying ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {isVerified && !credsDirty ? "Re-verify" : "Activate"}
            </button>
          </div>
        </div>
        {lockedFail && (
          <p className="neon-red-border mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs font-bold uppercase tracking-wider neon-red-text">
            {v.status_message || (u.status === "invalid_creds" ? "Invalid Username or Password" : "No Permission / Account Suspended")}
          </p>
        )}
      </div>

      {/* Step 2 */}
      {isVerified ? (
        <div className="border-t border-border/60 bg-surface/20 px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Step 2 · Filters · Polling · Telegram
            </h3>
            {running && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest neon-text">
                <Activity className="size-3.5" /> Loop active
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Min price (SAR)">
              <input
                type="number"
                value={v.min_price ?? 0}
                onChange={(e) => setF("min_price", Number(e.target.value))}
                className={input}
              />
            </Field>
            <Field label="Max price (SAR)">
              <input
                type="number"
                value={v.max_price ?? 0}
                onChange={(e) => setF("max_price", Number(e.target.value))}
                className={input}
              />
            </Field>
            <Field label="Interval (MS) [Strict Fixed Mode]">
              <div className="relative">
                <Gauge className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="number"
                  min={200}
                  step={50}
                  value={v.polling_interval_ms ?? 1000}
                  onChange={(e) =>
                    setF("polling_interval_ms", Math.max(200, Math.min(60000, Math.round(Number(e.target.value) || 0))))
                  }
                  className={input + " pl-7"}
                  placeholder="e.g. 3000"
                />
              </div>
            </Field>
            <Field label="Cooldown Duration (Seconds)">
              <input
                type="number"
                min={1}
                max={300}
                step={1}
                value={cooldownSec}
                onChange={(e) => {
                  const secs = Math.max(1, Math.min(300, Math.round(Number(e.target.value) || 0)));
                  setF("cooldown_seconds" as keyof BotUser, secs as never);
                }}
                className={input}
                placeholder="10"
              />
            </Field>
            <Field label="Last poll">
              <div className="rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-muted-foreground">
                {v.last_polled_at ? new Date(v.last_polled_at).toLocaleTimeString() : "—"}
              </div>
            </Field>
            <Field label="Telegram Bot Token">
              <input
                value={v.telegram_bot_token ?? ""}
                onChange={(e) => setF("telegram_bot_token", e.target.value)}
                className={input}
                placeholder="123456:ABC..."
              />
            </Field>
            <Field label="Telegram Chat ID">
              <input
                value={v.telegram_chat_id ?? ""}
                onChange={(e) => setF("telegram_chat_id", e.target.value)}
                className={input}
                placeholder="-1001234567890"
              />
            </Field>
          </div>

          <div className="mt-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Payment methods
            </p>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_OPTIONS.map((p) => {
                const on = (v.payment_methods || []).includes(p.key);
                return (
                  <button
                    key={p.key}
                    onClick={() => togglePay(p.key)}
                    className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition ${
                      on
                        ? "neon-border bg-[var(--neon)]/10 neon-text"
                        : "border-border bg-surface text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {on ? "☑" : "☐"} {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={tgTest}
              disabled={testing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider hover:bg-surface-2 disabled:opacity-60"
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              Test Telegram
            </button>
            <button
              onClick={saveAndStart}
              disabled={saving}
              className="neon-border inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
              {running ? "Save configs" : "Save & start loop"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-border/60 bg-surface/20 px-4 py-4 text-xs text-muted-foreground">
          <CircleDot className="size-3.5" />
          Step 2 locked. Verify credentials above to unlock filters, Telegram and polling.
        </div>
      )}

      {/* Mini live terminal */}
      <div className="border-t border-border/60 bg-background/40 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="size-3.5 neon-text" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Live terminal · slot {u.slot}
            </span>
            {running && <span className="pulse-dot inline-block size-1.5 rounded-full bg-[var(--neon)]" />}
          </div>
          <button
            onClick={clearMyLogs}
            disabled={clearing}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {clearing ? <Loader2 className="size-3 animate-spin" /> : <Eraser className="size-3" />}
            Clear
          </button>
        </div>
        <div className="terminal max-h-44 min-h-[88px] w-full space-y-0.5 overflow-y-auto overflow-x-hidden rounded-md p-2.5 text-[11px] leading-relaxed break-words">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">// awaiting activity…</p>
          ) : (
            logs.map((l) => <LogLine key={l.id} l={l} />)
          )}

        </div>
      </div>
    </article>
  );
}

const input =
  "w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
