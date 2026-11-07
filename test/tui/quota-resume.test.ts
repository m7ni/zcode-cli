import { test } from "bun:test";
import { join } from "node:path";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

function sessionEnv(
  workspace: ScenarioWorkspace,
  mode: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    NO_UPDATE_NOTIFIER: "1",
    QUOTA_FIXTURE_MODE: mode,
    QUOTA_FIXTURE_RESET_IN_MS: "1200",
    ZCODE_NO_NOTIFY: "1",
    ZCODE_QUOTA_RESUME_MARGIN_MS: "200",
    ZCODE_QUOTA_STATE_PATH: join(workspace.directory, "quota.json"),
    ...extra
  };
}

test("a hard quota stop waits out the window and resumes the prompt automatically", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-resume-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "once")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("quota banner", /usage window reached/u);
  await session.waitForScreen("resumed", /Usage window reopened/u);
  await session.waitForScreen("recovered", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("Esc cancels the quota wait instead of resuming", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-cancel-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "once", { QUOTA_FIXTURE_RESET_IN_MS: "30000" })
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("quota banner", /usage window reached/u);
  session.send("\x1b");
  await session.waitForScreen("cancelled notice", /Automatic resume cancelled/u);
  await session.assertScreenExcludes("no resume", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("a non-quota failure never enters the quota wait", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-plain-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "plain")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("plain error", /HTTP 500 upstream exploded/u);
  await session.assertScreenExcludes("no quota banner", /usage window reached/u);
  await session.exit();
}, 30_000);

test("a quota stop without a reset time explains itself and does nothing automatic", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-nodate-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "nodate")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("no reset notice", /No reset time was reported/u);
  await session.assertScreenExcludes("no resume", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("ZCODE_QUOTA_RESET_HOURS provides a labelled estimate and still resumes", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-estimate-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "nodate-once", { ZCODE_QUOTA_RESET_HOURS: "0.001" })
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("estimate banner", /\(estimated\)/u);
  await session.waitForScreen("recovered", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("repeated quota stops stop resuming after the retry budget", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-quota-cap-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/quota-resume.ts")],
    workspace,
    env: sessionEnv(workspace, "always", { QUOTA_FIXTURE_RESET_IN_MS: "800" })
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Long running question\r");
  await session.waitForScreen("quota banner", /usage window reached/u);
  await session.waitForScreen("budget exhausted", /retry budget exhausted/u);
  await session.assertScreenExcludes("never recovered", /Recovered on attempt/u);
  await session.exit();
}, 45_000);
