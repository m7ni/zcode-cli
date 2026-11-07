import { test } from "bun:test";
import { join } from "node:path";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

function sessionEnv(workspace: ScenarioWorkspace, loginCommand: string, mode: string): Record<string, string> {
  return {
    AUTO_LOGIN_FIXTURE_MODE: mode,
    NO_UPDATE_NOTIFIER: "1",
    ZCODE_LOGIN_LOCK_PATH: join(workspace.directory, "login.lock"),
    ZCODE_NO_NOTIFY: "1",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(workspace.directory, "provider_config.json"),
    ZCODE_TEST_LOGIN_CMD: loginCommand
  };
}

const fakeConfigJson = `{"schemaVersion":1,"config":{"defaultModelSelection":{"providerId":"scenario-fake","modelId":"test-model"},"providerConfigRules":{"providerRules":[{"providerId":"scenario-fake","config":{"access":{"apiKey":"fake-key"}}}]}}}`;

const successLoginCommand = `printf '%s' '${fakeConfigJson}' > "$ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" && echo 'Continue at https://fake-zai-login.example/device'`;

test("an auth-failed turn triggers auto-login and replays the prompt once", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-auto-login-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/auto-login.ts")],
    workspace,
    env: sessionEnv(workspace, successLoginCommand, "recover")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Retry me please\r");
  await session.waitForScreen("expired banner", /ZCode login expired/u);
  await session.waitForScreen("fallback url", /https:\/\/fake-zai-login\.example\/device/u);
  await session.waitForScreen("resumed", /Resuming your last message/u);
  await session.waitForScreen("recovered", /Recovered on attempt 2/u);
  await session.exit();
}, 30_000);

test("a failed login command surfaces the manual path without replaying the prompt", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-auto-login-fail-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/auto-login.ts")],
    workspace,
    env: sessionEnv(workspace, "echo 'boom: browser unavailable' >&2; exit 3", "recover")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Retry me please\r");
  await session.waitForScreen("manual login hint", /Run \/login to sign in manually/u);
  await session.assertScreenExcludes("no replay", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("a non-auth turn failure never starts the login flow", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-auto-login-plain-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/auto-login.ts")],
    workspace,
    env: sessionEnv(workspace, successLoginCommand, "plain-error")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Retry me please\r");
  await session.waitForScreen("plain error", /HTTP 404 while fetching unrelated docs/u);
  await session.assertScreenExcludes("no auto login banner", /ZCode login expired/u);
  await session.assertScreenExcludes("no replay", /Recovered on attempt/u);
  await session.exit();
}, 30_000);

test("a second auth failure after the replay surfaces as a plain error, not another login", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-auto-login-cap-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/auto-login.ts")],
    workspace,
    env: sessionEnv(workspace, successLoginCommand, "always-fails")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Retry me please\r");
  await session.waitForScreen("expired banner", /ZCode login expired/u);
  await session.waitForScreen("plain failure after replay", /Turn execution failed/u);
  await session.exit();
}, 30_000);

test("Esc cancels the automatic login wait", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-auto-login-cancel-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/auto-login.ts")],
    workspace,
    env: sessionEnv(workspace, "sleep 30", "recover")
  });
  await session.waitForScreen("ready", /scenario\/model|ZCode|Ask/u);
  session.send("Retry me please\r");
  await session.waitForScreen("waiting banner", /ZCode login expired/u);
  session.send("\x1b");
  await session.waitForScreen("cancelled notice", /Automatic login cancelled/u);
  await session.assertScreenExcludes("no replay after cancel", /Recovered on attempt/u);
  await session.exit();
}, 30_000);
