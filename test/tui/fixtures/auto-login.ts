import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const authFailureLine = "[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }";
const mode = process.env.AUTO_LOGIN_FIXTURE_MODE ?? "recover";
let attempts = 0;

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  submitPrompt: async (input) => {
    const text = typeof input === "object" && input !== null && "text" in input
      ? String((input as { text?: unknown }).text)
      : String(input);
    if (text !== "Retry me please") return { response: `Sent: ${text}` };
    attempts += 1;
    if (attempts === 1) {
      if (mode === "plain-error") throw new Error("HTTP 404 while fetching unrelated docs");
      process.stderr.write(`${authFailureLine}\n`);
      throw new Error("Turn execution failed");
    }
    if (mode === "always-fails") {
      process.stderr.write(`${authFailureLine}\n`);
      throw new Error("Turn execution failed");
    }
    return { response: `Recovered on attempt ${attempts}` };
  }
});
