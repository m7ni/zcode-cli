import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const lockFileStaleMs = 11 * 60 * 1_000;
const loginTimeoutMs = 10 * 60 * 1_000;
const autoLoginCooldownMs = 2 * 60 * 1_000;
const lockPollIntervalMs = 500;
const statusTickMs = 1_000;
const maximumDiagnosticLines = 20;

/**
 * Auth failures worth an automatic login. The runtime reports its project
 * access token errors by code (`project_token_login_failed`) or through the
 * `[project-access-token]` observer payload; generic 401s must not match
 * unless the surrounding text is about credentials, because tool output can
 * legitimately quote bare HTTP statuses.
 */
export function isAuthFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  if (text.includes("project_token_login_failed")) return true;
  if (text.includes("project-access-token")
    && (text.includes("login") || text.includes("expired") || text.includes("refresh"))) {
    return true;
  }
  if (text.includes("not logged in") || text.includes("login required")) return true;
  const credentialScope = /credential|api[ _-]?key|auth(?:oriz|entic)at|token|oauth/u;
  if (/\b401\b/u.test(text) && credentialScope.test(text)) return true;
  if (text.includes("unauthorized") && credentialScope.test(text)) return true;
  return false;
}

export function defaultLoginLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZCODE_LOGIN_LOCK_PATH?.trim();
  if (override) return override;
  const cacheBase = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheBase, "zcode-app-cli", "login.lock");
}

/**
 * `zcode login zai-coding-plan`: the runtime's native Z.AI coding-plan browser
 * flow for this platform (the closest real subcommand to "login zai"; the
 * runtime's usage string accepts only the coding-plan and api-key variants).
 */
export function autoLoginZaiCommand(
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
  runtimeEntry: string = process.argv[1] ?? ""
): { program: string; args: string[] } {
  const testCommand = env.ZCODE_TEST_LOGIN_CMD?.trim();
  if (testCommand) {
    return process.platform === "win32"
      ? { program: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", testCommand] }
      : { program: env.SHELL ?? "/bin/sh", args: ["-lc", testCommand] };
  }
  const executable = env.ZCODE_APP_CLI_EXECUTABLE?.trim();
  const launcher = env.ZCODE_APP_CLI_ENTRY?.trim();
  if (executable && launcher) return { program: executable, args: [launcher, "login", "zai-coding-plan"] };
  if (!runtimeEntry) throw new Error("Unable to locate the ZCode runtime entry point for login.");
  return { program: runtimeExecutable, args: [runtimeEntry, "login", "zai-coding-plan"] };
}

let authFailureObserverInstalled = false;
let observedAuthFailureCount = 0;

/**
 * Passive line tap on process.stderr. The runtime reports project access token
 * failures (for example `[project-access-token] { family: 'zai', stage:
 * 'resolve', code: 'project_token_login_failed' }`) on stderr and then rejects
 * the turn with a generic "Turn execution failed", so the signal must be
 * observed where it is printed. Every write still reaches the original stream.
 */
export function observeAuthFailuresOnStderr(): void {
  if (authFailureObserverInstalled) return;
  authFailureObserverInstalled = true;
  const stream = process.stderr;
  const originalWrite = stream.write.bind(stream);
  let buffer = "";
  stream.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
    try {
      buffer = `${buffer}${typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")}`.slice(-8_192);
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (isAuthFailureMessage(line)) observedAuthFailureCount += 1;
      }
    } catch {
      // Observation must never interfere with the write itself.
    }
    return originalWrite(chunk as Uint8Array | string, ...(rest as []));
  }) as typeof stream.write;
}

/** Monotonic count of auth-failure lines seen on stderr; snapshots bracket a turn. */
export function authFailuresObserved(): number {
  return observedAuthFailureCount;
}

/** Best-effort desktop notification; missing notify-send (ENOENT) is not an error. */
export function notifyLoginExpired(title: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.ZCODE_NO_NOTIFY === "1" || env.ZCODE_NO_NOTIFY?.trim().toLowerCase() === "true") return;
  if (process.platform !== "linux") return;
  try {
    const child = spawn("notify-send", ["-u", "critical", "--app-name=ZCode", title, body], {
      stdio: "ignore"
    });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // Notification delivery is optional.
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LoginLockOptions {
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

export type LoginLockResult =
  | { status: "acquired" }
  | { status: "released-by-peer" }
  | { status: "timeout" }
  | { status: "cancelled" };

interface LockPayload {
  createdAt: number;
  pid: number;
}

/**
 * Cross-process single-flight for the login flow: exactly one holder opens the
 * browser, the others wait for the lock to clear. The file holds pid and
 * timestamp so a crashed holder's lock is reclaimable once stale.
 */
export class LoginLock {
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private payload?: LockPayload;

  constructor(
    private readonly path: string,
    options: LoginLockOptions = {}
  ) {
    this.isAlive = options.isProcessAlive ?? isProcessAlive;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? lockPollIntervalMs;
    this.staleAfterMs = options.staleAfterMs ?? lockFileStaleMs;
  }

  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<LoginLockResult> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = this.now() + timeoutMs;
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const created = await this.tryCreate();
      if (created) return { status: "acquired" };
      const stale = await this.isStale();
      if (!stale) break;
      await unlink(this.path).catch(() => undefined);
    }
    while (this.now() < deadline) {
      if (signal?.aborted) return { status: "cancelled" };
      if (!await this.exists()) return { status: "released-by-peer" };
      await sleep(this.pollIntervalMs, signal);
      if (signal?.aborted) return { status: "cancelled" };
      const stale = await this.isStale();
      if (stale) {
        // The holder crashed or hung past the stale window; take over.
        await unlink(this.path).catch(() => undefined);
        const created = await this.tryCreate();
        if (created) return { status: "acquired" };
      }
    }
    return { status: "timeout" };
  }

  async release(): Promise<void> {
    const payload = this.payload;
    this.payload = undefined;
    if (!payload) return;
    const current = await this.read();
    if (current && current.pid === payload.pid && current.createdAt === payload.createdAt) {
      await unlink(this.path).catch(() => undefined);
    }
  }

  private async tryCreate(): Promise<boolean> {
    const payload: LockPayload = { createdAt: this.now(), pid: process.pid };
    let handle;
    try {
      handle = await open(this.path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`);
    } finally {
      await handle.close();
    }
    this.payload = payload;
    return true;
  }

  private async read(): Promise<LockPayload | undefined> {
    try {
      const value = JSON.parse((await readFile(this.path, "utf8")).trim()) as LockPayload;
      if (typeof value.createdAt === "number" && typeof value.pid === "number") return value;
    } catch {
      // Unreadable locks are treated as live; staleness reclaims them.
    }
    return undefined;
  }

  private async exists(): Promise<boolean> {
    // Direct file probe: read() resolves undefined for missing *and* unreadable
    // locks, and unreadable ones must stay "live" until the stale window.
    try {
      await access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  private async isStale(): Promise<boolean> {
    const payload = await this.read();
    if (!payload) return false;
    if (this.now() - payload.createdAt >= this.staleAfterMs) return true;
    return !this.isAlive(payload.pid);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function formatRemainingMs(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface AutoLoginChildProcess {
  kill(): void;
  exited: Promise<number>;
  setOutputListener(listener: (line: string) => void): void;
}

export type AutoLoginSpawner = (
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => AutoLoginChildProcess;

function defaultSpawnLogin(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv
): AutoLoginChildProcess {
  const child = spawn(program, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let buffer = "";
  const listeners: Array<(line: string) => void> = [];
  const onOutput = (chunk: Buffer | string) => {
    buffer = `${buffer}${String(chunk)}`.slice(-8_192);
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) for (const listener of listeners) listener(trimmed.slice(0, 200));
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });
  return {
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child is already gone.
      }
    },
    exited,
    setOutputListener: (listener) => {
      listeners.push(listener);
    }
  };
}

export type AutoLoginEvent =
  | { type: "started"; detail?: string }
  | { type: "status"; text: string }
  | { type: "child-output"; line: string }
  | { type: "succeeded"; summary: string }
  | { type: "failed"; reason: string }
  | { type: "cancelled"; reason: string };

export interface AutoLoginDeps {
  emit: (event: AutoLoginEvent) => void;
  env?: NodeJS.ProcessEnv;
  lockPath: string;
  loginCommand: { program: string; args: string[] };
  now?: () => number;
  spawnLogin?: AutoLoginSpawner;
  readAccess: () => Promise<unknown>;
  notify?: (title: string, body: string) => void;
  cooldownMs?: number;
  loginTimeoutMs?: number;
  lockOptions?: LoginLockOptions;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type AutoLoginOutcome = "retry" | "done";

/**
 * Drives one automatic login cycle after an auth failure: banner, browser
 * login (single-flight across processes), a bounded wait with cancel, and a
 * single retry signal for the caller to resubmit the failed prompt. A
 * cooldown keeps a still-failing session from looping.
 */
export class AutoLoginCoordinator {
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly loginTimeout: number;
  private readonly cooldownMs: number;
  private activeController?: AbortController;
  private lastAttemptAt = -Infinity;

  constructor(private readonly deps: AutoLoginDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms, signal) => sleep(ms, signal));
    this.loginTimeout = deps.loginTimeoutMs ?? loginTimeoutMs;
    this.cooldownMs = deps.cooldownMs ?? autoLoginCooldownMs;
  }

  isActive(): boolean {
    return this.activeController !== undefined;
  }

  cancel(reason: string): void {
    const controller = this.activeController;
    if (!controller) return;
    controller.abort();
    this.deps.emit({ type: "cancelled", reason });
  }

  async start(): Promise<AutoLoginOutcome> {
    if (this.isActive()) return "done";
    if (this.now() - this.lastAttemptAt < this.cooldownMs) {
      this.deps.emit({
        type: "failed",
        reason: "Automatic login was already attempted recently and the session is still unauthorized."
      });
      return "done";
    }
    this.lastAttemptAt = this.now();
    const controller = new AbortController();
    this.activeController = controller;
    try {
      return await this.run(controller.signal);
    } catch (error) {
      this.deps.emit({
        type: "failed",
        reason: error instanceof Error ? error.message : String(error)
      });
      return "done";
    } finally {
      this.activeController = undefined;
    }
  }

  private async run(signal: AbortSignal): Promise<AutoLoginOutcome> {
    this.deps.emit({ type: "started" });
    this.deps.notify?.(
      "ZCode login expired",
      "Opening your browser to sign in to Z.AI again…"
    );
    const lock = new LoginLock(this.deps.lockPath, this.deps.lockOptions);
    const acquired = await lock.acquire(this.loginTimeout, signal);
    if (acquired.status === "cancelled") {
      this.deps.emit({ type: "cancelled", reason: "Login wait cancelled." });
      return "done";
    }
    if (acquired.status === "timeout") {
      this.deps.emit({
        type: "failed",
        reason: "Timed out waiting for another ZCode process to finish signing in."
      });
      return "done";
    }
    if (acquired.status === "released-by-peer") {
      if (await this.deps.readAccess()) {
        this.deps.emit({ type: "succeeded", summary: "Login completed in another ZCode process." });
        return "retry";
      }
      this.deps.emit({
        type: "failed",
        reason: "Sign-in finished in another ZCode process but did not restore model access."
      });
      return "done";
    }
    try {
      return await this.runLoginChild(signal);
    } finally {
      await lock.release();
    }
  }

  private async runLoginChild(signal: AbortSignal): Promise<AutoLoginOutcome> {
    const spawnLogin = this.deps.spawnLogin ?? defaultSpawnLogin;
    const child = spawnLogin(
      this.deps.loginCommand.program,
      this.deps.loginCommand.args,
      this.deps.env ?? process.env
    );
    const diagnostics: string[] = [];
    child.setOutputListener((line) => {
      diagnostics.push(line);
      if (diagnostics.length > maximumDiagnosticLines) diagnostics.shift();
      this.deps.emit({ type: "child-output", line });
    });
    const deadline = this.now() + this.loginTimeout;
    let exitCode: number | undefined;
    while (exitCode === undefined) {
      if (signal.aborted) {
        child.kill();
        this.deps.emit({ type: "cancelled", reason: "Login cancelled before completion." });
        return "done";
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        child.kill();
        this.deps.emit({ type: "failed", reason: "Login timed out after 10 minutes." });
        return "done";
      }
      this.deps.emit({
        type: "status",
        text: `auto-login: waiting for browser sign-in · ${formatRemainingMs(remaining)} left · Esc cancels`
      });
      const tick = await Promise.race([
        child.exited.then((code) => code as number | undefined),
        this.wait(Math.min(statusTickMs, remaining), signal).then(() => undefined)
      ]);
      if (tick !== undefined) exitCode = tick;
    }
    if (exitCode === 0 && await this.deps.readAccess()) {
      this.deps.emit({ type: "succeeded", summary: "Signed in to Z.AI." });
      return "retry";
    }
    const detail = diagnostics.at(-1);
    this.deps.emit({
      type: "failed",
      reason: exitCode === 0
        ? "The login command finished but model access is still unavailable."
        : `The login command exited with status ${exitCode}${detail ? `: ${detail}` : "."}`
    });
    return "done";
  }
}
