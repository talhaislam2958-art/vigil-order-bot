import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  Loader2,
  LogOut,
  Play,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
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
  manualPoll,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Order Receiver Bot — Control Center" },
      { name: "description", content: "Multi-user automatic order receiver dashboard with 24/7 polling, Telegram alerts, and per-user filters." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: App,
});

const TOKEN_KEY = "orb_master_token";

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [bootChecked, setBootChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
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
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!token) {
    return (
      <>
        <Toaster theme="dark" position="top-right" />
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
      <Toaster theme="dark" position="top-right" />
      <Dashboard
        token={token}
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
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-2xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Order Receiver Bot</h1>
            <p className="text-xs text-muted-foreground">
              {needsSetup ? "Set master access code" : "Enter master access code"}
            </p>
          </div>
        </div>
        <label className="mb-3 block text-xs font-medium text-muted-foreground">
          Master code
        </label>
        <input
          autoFocus
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="••••••••"
        />
        {needsSetup && (
          <>
            <label className="mt-4 mb-3 block text-xs font-medium text-muted-foreground">
              Confirm code
            </label>
            <input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
            />
          </>
        )}
        <button
          disabled={busy}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {needsSetup ? "Set code" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

type BotUser = Awaited<ReturnType<typeof listUsers>>[number];
type LogRow = Awaited<ReturnType<typeof getLogs>>[number];

const PAYMENTS = ["stcpay", "urpay", "barq", "applepay", "mada", "bank"];

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
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
      const [u, l] = await Promise.all([list({ data: { token } }), getLogsFn({ data: { token, limit: 80 } })]);
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Bot className="size-5" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Order Receiver Bot</h1>
              <p className="text-xs text-muted-foreground">
                {activeCount} active · {totalGrabs} grabs total
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setPolling(true);
                try {
                  const r = await pollFn({ data: { token } });
                  toast.success(`Manual poll done · ${r.ticked} ticks`);
                  await refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setPolling(false);
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              {polling ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Run cycle now
            </button>
            <button
              onClick={() => router.invalidate().then(refresh)}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </button>
            <button
              onClick={async () => {
                await logoutFn({ data: { token } }).catch(() => {});
                onLogout();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              <LogOut className="size-3.5" />
              Lock
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          {loading && users.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            users.map((u) => <UserCard key={u.id} u={u} token={token} onChanged={refresh} />)
          )}
        </section>

        <aside className="space-y-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Live activity</h2>
            </div>
            <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1 font-mono text-[11px]">
              {logs.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
              {logs.map((l) => (
                <div key={l.id} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(l.created_at).toLocaleTimeString()}
                  </span>
                  <span
                    className={
                      l.level === "error"
                        ? "text-destructive"
                        : l.level === "success"
                          ? "text-success"
                          : l.level === "warn"
                            ? "text-warning"
                            : "text-foreground"
                    }
                  >
                    [{l.slot ?? "-"}] {l.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">Cron status</p>
            <p className="mt-1">Server-side polling runs every ~10s via cron. Per-user interval governs in-cycle request pacing.</p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function StatusPill({ status, msg }: { status: string; msg: string }) {
  const map: Record<string, { c: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
    idle: { c: "bg-muted text-muted-foreground", label: "Idle", Icon: CircleDot },
    starting: { c: "bg-warning/20 text-warning", label: "Starting…", Icon: Loader2 },
    running: { c: "bg-success/20 text-success", label: "Authorized / Running", Icon: CheckCircle2 },
    invalid_creds: { c: "bg-destructive/20 text-destructive", label: "Invalid Username or Password", Icon: XCircle },
    suspended: { c: "bg-destructive/20 text-destructive", label: "No Permission / Account Suspended", Icon: XCircle },
    error: { c: "bg-destructive/20 text-destructive", label: msg || "Error", Icon: XCircle },
  };
  const s = map[status] ?? map.idle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${s.c}`}>
      <s.Icon className={`size-3 ${status === "starting" ? "animate-spin" : ""}`} />
      {s.label}
    </span>
  );
}

function UserCard({ u, token, onChanged }: { u: BotUser; token: string; onChanged: () => void }) {
  const updateFn = useServerFn(updateUser);
  const testFn = useServerFn(testTelegram);
  const [local, setLocal] = useState<Partial<BotUser>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const v = { ...u, ...local };
  const dirty = Object.keys(local).length > 0;

  async function save() {
    setSaving(true);
    try {
      // Build patch with type narrowing
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(local)) patch[k] = (local as Record<string, unknown>)[k];
      await updateFn({ data: { token, id: u.id, patch: patch as never } });
      setLocal({});
      toast.success(`Slot ${u.slot} saved`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(next: boolean) {
    setToggling(true);
    try {
      // First save any pending edits along with the toggle
      const patch: Record<string, unknown> = { ...local, is_active: next };
      await updateFn({ data: { token, id: u.id, patch: patch as never } });
      setLocal({});
      toast.success(next ? `Slot ${u.slot} activated` : `Slot ${u.slot} deactivated`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setToggling(false);
    }
  }

  async function tgTest() {
    if (!v.telegram_bot_token || !v.telegram_chat_id) {
      toast.error("Set bot token and chat id first");
      return;
    }
    setTesting(true);
    try {
      await testFn({
        data: { token, bot_token: v.telegram_bot_token, chat_id: v.telegram_chat_id },
      });
      toast.success("Telegram test sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Telegram failed");
    } finally {
      setTesting(false);
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

  return (
    <article className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-surface-2 text-sm font-bold">
            {u.slot}
          </div>
          <input
            value={v.label ?? ""}
            onChange={(e) => setF("label", e.target.value)}
            placeholder={`Slot ${u.slot} label`}
            className="rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-border focus:border-border focus:outline-none"
          />
          <StatusPill status={v.status} msg={v.status_message} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            Grabs: <b className="text-foreground">{v.orders_grabbed}</b>
          </span>
          <button
            onClick={() => toggle(!v.is_active)}
            disabled={toggling}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              v.is_active
                ? "bg-success text-success-foreground"
                : "border border-border bg-surface text-foreground hover:bg-surface-2"
            }`}
          >
            {toggling ? <Loader2 className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
            {v.is_active ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Username / Phone">
          <input
            value={v.username ?? ""}
            onChange={(e) => setF("username", e.target.value)}
            className={input}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={v.password ?? ""}
            onChange={(e) => setF("password", e.target.value)}
            className={input}
          />
        </Field>
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
        <Field label="Polling interval (ms)">
          <input
            type="number"
            min={200}
            step={100}
            value={v.polling_interval_ms ?? 1000}
            onChange={(e) => setF("polling_interval_ms", Number(e.target.value))}
            className={input}
          />
        </Field>
        <Field label="Last poll">
          <div className="rounded-md border border-border bg-input px-3 py-2 text-xs text-muted-foreground">
            {v.last_polled_at ? new Date(v.last_polled_at).toLocaleTimeString() : "—"}
          </div>
        </Field>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Payment methods
        </p>
        <div className="flex flex-wrap gap-2">
          {PAYMENTS.map((p) => {
            const on = (v.payment_methods || []).includes(p);
            return (
              <button
                key={p}
                onClick={() => togglePay(p)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  on
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-surface text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={tgTest}
          disabled={testing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Test Telegram
        </button>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
          Save changes
        </button>
      </div>
    </article>
  );
}

const input =
  "w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
