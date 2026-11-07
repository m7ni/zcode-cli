import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { formatRemainingMs, sendDesktopNotification, sleep } from "./auto-login.ts";

/** Auto-resume defaults to ON; ZCODE_QUOTA_AUTO_RESUME=0 (or =false) turns it off. */
export function quotaAutoResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ZCODE_QUOTA_AUTO_RESUME?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

/**
 * Gap between the window reset and the resume attempt. The vendored runtime
 * waits a full minute for its own runs; the TUI is slightly keener. Overridable
 * so tests can shrink it.
 */
export function quotaResumeMarginMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ZCODE_QUOTA_RESUME_MARGIN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/** A failed prompt is replayed at most this many times across quota windows. */
export const maxQuotaResumes = 3;

const quotaResetHoursMax = 24 * 7;
const quotaResetSanityMs = quotaResetHoursMax * 3_600_000;

const isoDatePattern = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu;

function finiteFutureDate(value: number, now: number): number | undefined {
  return Number.isFinite(value) && value > now && value <= now + quotaResetSanityMs ? value : undefined;
}

/**
 * Parses the reset time out of a provider 429 body. Z.AI documents
 * `next_flush_time` / "Resets at <datetime>"; any ISO-ish datetime within the
 * sanity window (48h…7d) counts, dates in the past never do.
 */
export function parseQuotaResetDate(text: string, now: number = Date.now()): number | undefined {
  const explicit = /next_flush_time["']?\s*[:=]\s*["']?([^"'\s,}]+)/iu.exec(text);
  const candidates: string[] = [];
  if (explicit?.[1]) candidates.push(explicit[1]);
  for (const match of text.matchAll(isoDatePattern)) candidates.push(match[0]);
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate.endsWith("Z") || /[+-]\d{2}:?\d{2}$/u.test(candidate)
      ? candidate
      : `${candidate.replace(" ", "T")}`);
    const accepted = finiteFutureDate(parsed, now);
    if (accepted !== undefined) return accepted;
  }
  return undefined;
}

function isQuotaStopText(text: string): boolean {
  if (/quota_exceeded|organization_usage_limit_exceeded|exceeded_current_quota_error/iu.test(text)) return true;
  if (/usage limit reached|usage cap is reached|quota is exhausted/iu.test(text)) return true;
  if (/\b(?:1316|1317)\b/u.test(text) && /usage|quota/iu.test(text)) return true;
  return /\bquota\b/iu.test(text) && /\b(?:exceeded|exhausted|reached)\b/iu.test(text);
}

interface QuotaSignalFields {
  kind?: unknown;
  resetAt?: unknown;
  retryAfterMs?: unknown;
  providerStop?: unknown;
  failure?: unknown;
  data?: unknown;
  cause?: unknown;
  message?: unknown;
  detail?: unknown;
  underlyingErrorMessage?: unknown;
  underlyingErrorDetail?: unknown;
  rawMessage?: unknown;
  code?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface QuotaStop {
  /** Epoch-ms when the usage window reopens; undefined when unknowable. */
  resetAt?: number;
  /** True when resetAt came from ZCODE_QUOTA_RESET_HOURS, not the provider. */
  estimated: boolean;
  message: string;
}

/**
 * Recognizes a hard quota stop on a failed turn. The signal may be structured
 * (a providerStop payload with kind "quota" and resetAt), textual (provider
 * codes or the documented 429 wording), or both; the reset time is derived in
 * the same order the vendored runtime uses: structured resetAt, then
 * retryAfterMs, then a parsed date, then the ZCODE_QUOTA_RESET_HOURS estimate.
 */
export function quotaStopFromError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): QuotaStop | undefined {
  const texts: string[] = [];
  let structuredResetAt: number | undefined;
  let structuredRetryAfterMs: number | undefined;
  let structuredQuota = false;

  const visit = (value: unknown, depth: number): void => {
    const record = asRecord(value);
    if (!record || depth > 3) return;
    const fields = record as QuotaSignalFields;
    if (fields.kind === "quota" || fields.providerStop !== undefined || fields.failure !== undefined) {
      if (fields.kind === "quota" || asRecord(fields.providerStop)?.kind === "quota"
        || asRecord(fields.failure)?.providerStop !== undefined) structuredQuota = true;
    }
    for (const key of ["resetAt", "retryAfterMs"] as const) {
      const numeric = typeof fields[key] === "number" ? fields[key] : Number(fields[key]);
      if (!Number.isFinite(numeric)) continue;
      if (key === "resetAt" && structuredResetAt === undefined) structuredResetAt = numeric;
      if (key === "retryAfterMs" && structuredRetryAfterMs === undefined && numeric > 0 && numeric <= quotaResetSanityMs) {
        structuredRetryAfterMs = numeric;
      }
    }
    for (const key of ["message", "detail", "underlyingErrorMessage", "underlyingErrorDetail", "rawMessage", "code"] as const) {
      if (typeof fields[key] === "string" && fields[key]) texts.push(fields[key]);
    }
    visit(fields.providerStop, depth + 1);
    visit(fields.failure, depth + 1);
    visit(fields.data, depth + 1);
    visit(fields.cause, depth + 1);
  };

  if (error instanceof Error) {
    texts.push(error.message);
    visit(error, 0);
    visit((error as { cause?: unknown }).cause, 1);
  } else {
    texts.push(String(error));
    visit(error, 0);
  }

  const text = texts.join("\n");
  const textualQuota = isQuotaStopText(text);
  if (!structuredQuota && !textualQuota) return undefined;

  const fromRetryAfter = structuredRetryAfterMs !== undefined
    ? finiteFutureDate(now + structuredRetryAfterMs, now)
    : undefined;
  const resetAt = finiteFutureDate(structuredResetAt ?? Number.NaN, now)
    ?? fromRetryAfter
    ?? parseQuotaResetDate(text, now)
    ?? quotaFallbackResetAt(env, now);
  return {
    resetAt,
    estimated: resetAt !== undefined
      && structuredResetAt === undefined
      && fromRetryAfter === undefined
      && parseQuotaResetDate(text, now) === undefined,
    message: texts.find((candidate) => candidate.trim().length > 0) ?? "Usage limit reached."
  };
}

function quotaFallbackResetAt(env: NodeJS.ProcessEnv, now: number): number | undefined {
  const hours = Number(env.ZCODE_QUOTA_RESET_HOURS);
  return Number.isFinite(hours) && hours > 0 && hours <= quotaResetHoursMax
    ? now + hours * 3_600_000
    : undefined;
}

export function defaultQuotaStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZCODE_QUOTA_STATE_PATH?.trim();
  if (override) return override;
  const cacheBase = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheBase, "zcode-app-cli", "quota.json");
}

export interface QuotaWaitState {
  resetAt: number;
  estimate: boolean;
  updatedAt: number;
}

/** Shared wait state so concurrent TUIs agree on the reset and restarts can show it. */
export async function readQuotaWaitState(
  path: string,
  now: number = Date.now()
): Promise<QuotaWaitState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<QuotaWaitState>;
    if (typeof value.resetAt !== "number" || typeof value.updatedAt !== "number") return undefined;
    if (value.resetAt <= now) return undefined;
    return { resetAt: value.resetAt, estimate: value.estimate === true, updatedAt: value.updatedAt };
  } catch {
    return undefined;
  }
}

export async function writeQuotaWaitState(path: string, state: QuotaWaitState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // Shared state is advisory; a failed write must not break the wait.
  }
}

export async function clearQuotaWaitState(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export interface QuotaResumeDeps {
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  marginMs?: number;
  tickMs?: number;
  onCountdown?: (text: string) => void;
}

export type QuotaWaitOutcome = "resume" | "cancelled";

/**
 * One wait cycle from a hard quota stop to the reopened window: live countdown,
 * cancellable, resumes the caller's prompt at resetAt + margin.
 */
export class QuotaResumeCoordinator {
  private readonly now: () => number;
  private readonly waitFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly marginMs: number;
  private readonly tickMs: number;
  private readonly onCountdown?: (text: string) => void;
  private activeController?: AbortController;

  constructor(deps: QuotaResumeDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.waitFn = deps.wait ?? sleep;
    this.marginMs = deps.marginMs ?? 30_000;
    this.tickMs = deps.tickMs ?? 1_000;
    this.onCountdown = deps.onCountdown;
  }

  isActive(): boolean {
    return this.activeController !== undefined;
  }

  cancel(): void {
    this.activeController?.abort();
  }

  async waitFor(resetAt: number, estimated: boolean): Promise<QuotaWaitOutcome> {
    if (this.activeController) return "cancelled";
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const resumeAt = resetAt + this.marginMs;
      for (;;) {
        if (controller.signal.aborted) return "cancelled";
        const remaining = resumeAt - this.now();
        if (remaining <= 0) return "resume";
        this.onCountdown?.(
          `usage window ${estimated ? "reopens ~" : "reopens in "}${formatRemainingMs(remaining)}`
          + " · auto-resumes · Esc cancels"
        );
        await this.waitFn(Math.min(this.tickMs, remaining), controller.signal);
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }
}

export function notifyQuotaPause(resetAt: number): void {
  sendDesktopNotification("ZCode usage limit reached", `Resuming automatically at ${formatResetTime(resetAt)}.`);
}

export function notifyQuotaResume(): void {
  sendDesktopNotification("Usage window reset", "Resuming your last message.");
}

export function formatResetTime(resetAt: number): string {
  return new Date(resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
