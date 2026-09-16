// Execution mode manager (client-side).
// "cloud"   -> Lovable Cloud backend + scheduled polling engine.
// "browser" -> everything runs inside this browser tab, zero cloud credits.

export type ExecMode = "cloud" | "browser";

const MODE_KEY = "orb_exec_mode";

let mode: ExecMode = "cloud";
let fellBackAutomatically = false;
const listeners = new Set<(m: ExecMode, auto: boolean) => void>();

export function initExecMode(): ExecMode {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "browser" || saved === "cloud") mode = saved;
  }
  return mode;
}

export function getExecMode(): ExecMode {
  return mode;
}

export function wasAutoFallback(): boolean {
  return fellBackAutomatically;
}

export function setExecMode(next: ExecMode, auto = false): void {
  if (mode === next && fellBackAutomatically === auto) return;
  mode = next;
  fellBackAutomatically = auto;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* storage may be blocked; mode still works in-memory */
    }
  }
  for (const fn of listeners) fn(mode, auto);
}

export function subscribeExecMode(fn: (m: ExecMode, auto: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Detects "the cloud backend is not usable right now": network unreachable,
 * paused/suspended project, exhausted run credits, worker 5xx, or a missing
 * database. Auth/validation errors are NOT outages.
 */
export function isCloudOutage(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  if (!msg) return true;
  if (/unauthor|session expired|incorrect master|not set|invalid/.test(msg)) return false;
  return /failed to fetch|networkerror|network error|load failed|econn|timeout|timed out|abort|502|503|504|500|internal server error|service unavailable|unavailable|paused|suspend|quota|credit|limit reached|exceeded|billing|not connected|missing supabase|unreachable|offline/.test(
    msg,
  );
}

/** Returns true when this failure caused an automatic fallback to browser mode. */
export function reportCloudFailure(e: unknown): boolean {
  if (mode !== "cloud") return false;
  if (!isCloudOutage(e)) return false;
  setExecMode("browser", true);
  return true;
}
