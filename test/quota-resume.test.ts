import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearQuotaWaitState,
  defaultQuotaStatePath,
  maxQuotaResumes,
  parseQuotaResetDate,
  quotaAutoResumeEnabled,
  QuotaResumeCoordinator,
  quotaResumeMarginMs,
  quotaStopFromError,
  readQuotaWaitState,
  writeQuotaWaitState
} from "../packages/zcode-tui/src/quota-resume.ts";

const hourMs = 3_600_000;

test("auto-resume defaults to on and only explicit opt-outs disable it", () => {
  expect(quotaAutoResumeEnabled({})).toBe(true);
  expect(quotaAutoResumeEnabled({ ZCODE_QUOTA_AUTO_RESUME: "0" })).toBe(false);
  expect(quotaAutoResumeEnabled({ ZCODE_QUOTA_AUTO_RESUME: "false" })).toBe(false);
  expect(quotaAutoResumeEnabled({ ZCODE_QUOTA_AUTO_RESUME: "1" })).toBe(true);
  expect(quotaResumeMarginMs({})).toBe(30_000);
  expect(quotaResumeMarginMs({ ZCODE_QUOTA_RESUME_MARGIN_MS: "250" })).toBe(250);
  expect(maxQuotaResumes).toBe(3);
});

test("reset dates parse from provider wording, next_flush_time, and reject the past", () => {
  const now = Date.parse("2026-11-07T16:00:00Z");
  expect(parseQuotaResetDate("Usage limit reached … Resets at 2026-11-07T21:00:00.000Z", now))
    .toBe(Date.parse("2026-11-07T21:00:00.000Z"));
  expect(parseQuotaResetDate('{"error":{"next_flush_time":"2026-11-07 20:30:00"}}', now))
    .toBe(Date.parse("2026-11-07T20:30:00"));
  expect(parseQuotaResetDate("Resets at 2026-11-07T15:00:00Z", now)).toBeUndefined();
  expect(parseQuotaResetDate("no dates anywhere", now)).toBeUndefined();
});

test("a structured provider stop yields quota with its resetAt", () => {
  const now = Date.now();
  const error = new Error("Turn execution failed");
  (error as unknown as { failure?: unknown }).failure = {
    providerStop: { kind: "quota", resetAt: now + hourMs, providerCode: "quota_exceeded" }
  };
  const stop = quotaStopFromError(error, {}, now);
  expect(stop).toMatchObject({ resetAt: now + hourMs, estimated: false });
});

test("a textual 429 with a reset date is detected and parsed", () => {
  const now = Date.now();
  const message = `Usage limit reached for the past 5 hours. Insufficient balance for extra usage.`
    + ` Resets at ${new Date(now + 2 * hourMs).toISOString()}`;
  const stop = quotaStopFromError(new Error(message), {}, now);
  expect(stop?.resetAt).toBe(now + 2 * hourMs);
  expect(stop?.estimated).toBe(false);
  expect(stop?.message).toContain("Usage limit reached");
});

test("retryAfterMs offsets become the reset time", () => {
  const now = Date.now();
  const error = new Error("Provider stop: usage quota exceeded");
  (error as unknown as { retryAfterMs?: unknown }).retryAfterMs = 90_000;
  const stop = quotaStopFromError(error, {}, now);
  expect(stop?.resetAt).toBe(now + 90_000);
});

test("a quota stop without any reset time falls back to the env estimate, labelled", () => {
  const now = Date.now();
  const error = new Error("Error code 1316: usage limit reached for the past 5 hours");
  expect(quotaStopFromError(error, {}, now)).toMatchObject({ resetAt: undefined, estimated: false });
  expect(quotaStopFromError(error, { ZCODE_QUOTA_RESET_HOURS: "2" }, now))
    .toMatchObject({ resetAt: now + 2 * hourMs, estimated: true });
});

test("non-quota failures never match, including auth and bare HTTP errors", () => {
  const now = Date.now();
  expect(quotaStopFromError(new Error("Error: Turn execution failed"), {}, now)).toBeUndefined();
  expect(quotaStopFromError(new Error("HTTP 404 Not Found"), {}, now)).toBeUndefined();
  expect(quotaStopFromError(new Error("project_token_login_failed"), {}, now)).toBeUndefined();
  expect(quotaStopFromError(new Error("Request failed with 401: invalid api key"), {}, now)).toBeUndefined();
});

test("the wait coordinator counts down, resumes after the margin, and cancels", async () => {
  let fakeNow = 1_000_000;
  const countdowns: string[] = [];
  const coordinator = new QuotaResumeCoordinator({
    now: () => fakeNow,
    wait: async (ms) => {
      fakeNow += ms;
    },
    marginMs: 30_000,
    tickMs: 1_000,
    onCountdown: (text) => countdowns.push(text)
  });
  const outcome = coordinator.waitFor(fakeNow + 2_000, false);
  expect(coordinator.isActive()).toBe(true);
  expect(await outcome).toBe("resume");
  expect(coordinator.isActive()).toBe(false);
  expect(countdowns.at(-1)).toContain("auto-resumes");

  fakeNow = 1_000_000;
  let cancelledNow: number | undefined;
  const cancelling = new QuotaResumeCoordinator({
    now: () => fakeNow,
    wait: async (ms, signal) => {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          fakeNow += ms;
          resolve(undefined);
        }, 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          cancelledNow = fakeNow;
          resolve(undefined);
        }, { once: true });
      });
    },
    marginMs: 30_000,
    tickMs: 60_000
  });
  const waiting = cancelling.waitFor(fakeNow + hourMs, true);
  setTimeout(() => cancelling.cancel(), 5);
  expect(await waiting).toBe("cancelled");
  expect(cancelledNow).toBe(1_000_000);
});

test("shared wait state round-trips, expires, and clears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-quota-state-"));
  try {
    const path = join(directory, "quota.json");
    const now = Date.now();
    expect(await readQuotaWaitState(path, now)).toBeUndefined();
    await writeQuotaWaitState(path, { resetAt: now + hourMs, estimate: true, updatedAt: now });
    expect(await readFile(path, "utf8")).toContain("\"estimate\":true");
    expect(await readQuotaWaitState(path, now)).toMatchObject({ resetAt: now + hourMs, estimate: true });
    expect(await readQuotaWaitState(path, now + 2 * hourMs)).toBeUndefined();
    await writeFile(path, "{not json");
    expect(await readQuotaWaitState(path, now)).toBeUndefined();
    await writeQuotaWaitState(path, { resetAt: now + hourMs, estimate: false, updatedAt: now });
    await clearQuotaWaitState(path);
    expect(await readQuotaWaitState(path, now)).toBeUndefined();
    expect(defaultQuotaStatePath({ ZCODE_QUOTA_STATE_PATH: "/tmp/q.json" })).toBe("/tmp/q.json");
    expect(defaultQuotaStatePath({ XDG_CACHE_HOME: "/tmp/cache-x" })).toBe(
      join("/tmp/cache-x", "zcode-app-cli", "quota.json")
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
