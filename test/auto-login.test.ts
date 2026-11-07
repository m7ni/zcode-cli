import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoLoginZaiCommand,
  authFailuresObserved,
  AutoLoginCoordinator,
  type AutoLoginChildProcess,
  type AutoLoginEvent,
  type AutoLoginSpawner,
  defaultLoginLockPath,
  isAuthFailureMessage,
  LoginLock,
  observeAuthFailuresOnStderr
} from "../packages/zcode-tui/src/auto-login.ts";

const observerLine = "[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }";

test("auth detection matches credential failures without matching bare HTTP statuses", () => {
  expect(isAuthFailureMessage(observerLine)).toBe(true);
  expect(isAuthFailureMessage("[project-access-token] token expired; refresh failed")).toBe(true);
  expect(isAuthFailureMessage("Error: not logged in")).toBe(true);
  expect(isAuthFailureMessage("Request failed with 401: invalid api key")).toBe(true);
  expect(isAuthFailureMessage("401 Unauthorized: oauth token was rejected")).toBe(true);

  expect(isAuthFailureMessage(undefined)).toBe(false);
  expect(isAuthFailureMessage("Error: Turn execution failed")).toBe(false);
  expect(isAuthFailureMessage("Got 401 from example.com while fetching docs")).toBe(false);
  expect(isAuthFailureMessage("HTTP 404 Not Found")).toBe(false);
  expect(isAuthFailureMessage("unauthorized access to the file system")).toBe(false);
});

test("login command honors the test hook and the runtime entry point", () => {
  expect(autoLoginZaiCommand({ ZCODE_TEST_LOGIN_CMD: "true" }, "/usr/bin/node", "/app/bin/zcode.js"))
    .toEqual({ program: "/bin/sh", args: ["-lc", "true"] });
  expect(autoLoginZaiCommand({ ZCODE_APP_CLI_EXECUTABLE: "/usr/bin/node", ZCODE_APP_CLI_ENTRY: "/app/bin/zcode.js" }, "/usr/bin/node", "/app/bin/zcode.js"))
    .toEqual({ program: "/usr/bin/node", args: ["/app/bin/zcode.js", "login", "zai-coding-plan"] });
  expect(autoLoginZaiCommand({}, "/usr/bin/node", "/app/bin/zcode.js"))
    .toEqual({ program: "/usr/bin/node", args: ["/app/bin/zcode.js", "login", "zai-coding-plan"] });
  expect(() => autoLoginZaiCommand({}, "/usr/bin/node", "")).toThrow();
});

test("stderr observer counts auth-failure lines without swallowing output", () => {
  observeAuthFailuresOnStderr();
  const before = authFailuresObserved();
  const write = process.stderr.write.bind(process.stderr);
  write(`${observerLine}\n`);
  write("[project-access-token] { family: 'zai', stage: 'resolve', code: 'project");
  write("_login_failed' }\n");
  write("ordinary progress line\n");
  expect(authFailuresObserved()).toBe(before + 2);
  observeAuthFailuresOnStderr();
  write(`${observerLine}\n`);
  expect(authFailuresObserved()).toBe(before + 3);
});

test("login lock gives exactly one of two concurrent callers the browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-lock-"));
  try {
    const path = join(directory, "login.lock");
    const lock = new LoginLock(path, { pollIntervalMs: 10, staleAfterMs: 60_000 });
    const first = lock.acquire(5_000);
    const second = new LoginLock(path, { pollIntervalMs: 10, staleAfterMs: 60_000 }).acquire(5_000);
    expect(await first).toEqual({ status: "acquired" });
    const released = second.then((outcome) => {
      expect(outcome).toEqual({ status: "released-by-peer" });
    });
    await lock.release();
    await released;
    // A third caller acquires freely once the lock is gone.
    expect(await new LoginLock(path, { pollIntervalMs: 10 }).acquire(1_000)).toEqual({ status: "acquired" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lock left by a dead process is reclaimed as stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-stale-"));
  try {
    const path = join(directory, "login.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`);
    const lock = new LoginLock(path, { isProcessAlive: () => false, pollIntervalMs: 10 });
    expect(await lock.acquire(1_000)).toEqual({ status: "acquired" });
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeChild(events: { exitCode?: number; lines?: string[]; hold?: boolean }): AutoLoginChildProcess {
  let listener: (line: string) => void = () => undefined;
  let killRequested = false;
  const exited = new Promise<number>((resolve) => {
    if (events.hold) {
      const timer = setInterval(() => {
        if (killRequested) {
          clearInterval(timer);
          resolve(137);
        }
      }, 5);
      return;
    }
    setTimeout(() => {
      for (const line of events.lines ?? []) listener(line);
      resolve(events.exitCode ?? 0);
    }, 5);
  });
  return {
    kill: () => {
      killRequested = true;
    },
    exited,
    setOutputListener: (next) => {
      listener = next;
    }
  };
}

interface CoordinatorHarness {
  events: AutoLoginEvent[];
  start: () => Promise<"retry" | "done">;
  coordinator: AutoLoginCoordinator;
}

function coordinatorHarness(overrides: {
  child: { exitCode?: number; lines?: string[]; hold?: boolean };
  access?: boolean;
  lockPath: string;
  cooldownMs?: number;
}): CoordinatorHarness {
  const events: AutoLoginEvent[] = [];
  const spawner: AutoLoginSpawner = () => fakeChild(overrides.child);
  const coordinator = new AutoLoginCoordinator({
    emit: (event) => events.push(event),
    lockPath: overrides.lockPath,
    loginCommand: { program: "zcode-login-fake", args: [] },
    spawnLogin: spawner,
    readAccess: async () => overrides.access ?? false,
    cooldownMs: overrides.cooldownMs ?? 0,
    loginTimeoutMs: 2_000,
    lockOptions: { pollIntervalMs: 10 }
  });
  return { events, coordinator, start: () => coordinator.start() };
}

test("coordinator reports retry after a successful child login restores access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-flow-"));
  try {
    const harness = coordinatorHarness({
      child: { exitCode: 0, lines: ["Visit https://fake-zai.example/device to continue"] },
      access: true,
      lockPath: join(directory, "login.lock")
    });
    expect(await harness.start()).toBe("retry");
    expect(harness.events.map((event) => event.type)).toContain("started");
    expect(harness.events.at(-1)).toEqual({ type: "succeeded", summary: "Signed in to Z.AI." });
    expect(harness.events.some((event) => event.type === "child-output"
      && event.line.includes("https://fake-zai.example/device"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinator stops without retry when the login child fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-fail-"));
  try {
    const harness = coordinatorHarness({
      child: { exitCode: 3, lines: ["Error: browser did not open"] },
      access: true,
      lockPath: join(directory, "login.lock")
    });
    expect(await harness.start()).toBe("done");
    const failure = harness.events.find((event) => event.type === "failed");
    expect(failure).toMatchObject({ reason: expect.stringContaining("status 3") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinator stops when the child exits 0 but access is still missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-noaccess-"));
  try {
    const harness = coordinatorHarness({
      child: { exitCode: 0 },
      access: false,
      lockPath: join(directory, "login.lock")
    });
    expect(await harness.start()).toBe("done");
    expect(harness.events.at(-1)).toMatchObject({
      reason: "The login command finished but model access is still unavailable."
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinator can be cancelled while waiting for the browser sign-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-cancel-"));
  try {
    const harness = coordinatorHarness({ child: { hold: true }, lockPath: join(directory, "login.lock") });
    const outcome = harness.start();
    harness.coordinator.cancel("test cancel");
    expect(await outcome).toBe("done");
    expect(harness.events).toContainEqual({ type: "cancelled", reason: "test cancel" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cooldown keeps a still-failing session from looping through logins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-cooldown-"));
  try {
    const harness = coordinatorHarness({
      child: { exitCode: 1 },
      lockPath: join(directory, "login.lock"),
      cooldownMs: 60_000
    });
    expect(await harness.start()).toBe("done");
    expect(await harness.start()).toBe("done");
    const failures = harness.events.filter((event) => event.type === "failed");
    expect(failures.at(-1)?.reason).toContain("already attempted recently");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the lock loser adopts the winner's login and retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-auto-login-peer-"));
  try {
    const holder = new LoginLock(join(directory, "login.lock"), { pollIntervalMs: 10 });
    expect(await holder.acquire(1_000)).toEqual({ status: "acquired" });
    const harness = coordinatorHarness({
      child: { exitCode: 0 },
      access: true,
      lockPath: join(directory, "login.lock")
    });
    const outcome = harness.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await holder.release();
    expect(await outcome).toBe("retry");
    expect(harness.events).toContainEqual({ type: "succeeded", summary: "Login completed in another ZCode process." });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default lock path lives in the cache directory and honors the override", () => {
  expect(defaultLoginLockPath({ ZCODE_LOGIN_LOCK_PATH: "/tmp/custom.lock" })).toBe("/tmp/custom.lock");
  expect(defaultLoginLockPath({ XDG_CACHE_HOME: "/tmp/cache-home" })).toBe(
    join("/tmp/cache-home", "zcode-app-cli", "login.lock")
  );
});
