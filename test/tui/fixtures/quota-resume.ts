import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const mode = process.env.QUOTA_FIXTURE_MODE ?? "once";
const resetInMs = Number(process.env.QUOTA_FIXTURE_RESET_IN_MS ?? 1_500);
let attempts = 0;

function quotaError(): Error {
  const resetAt = new Date(Date.now() + resetInMs).toISOString();
  return new Error(
    `Error code 1316: Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at ${resetAt}`
  );
}

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  submitPrompt: async (input) => {
    const text = typeof input === "object" && input !== null && "text" in input
      ? String((input as { text?: unknown }).text)
      : String(input);
    if (text !== "Long running question") return { response: `Sent: ${text}` };
    attempts += 1;
    if (mode === "plain") throw new Error("HTTP 500 upstream exploded");
    if (mode === "nodate") throw new Error("Error code 1316: Usage limit reached for the past 5 hours");
    if (mode === "nodate-once" && attempts === 1) {
      throw new Error("Error code 1316: Usage limit reached for the past 5 hours");
    }
    if (attempts === 1) throw quotaError();
    if (mode === "always") throw quotaError();
    return { response: `Recovered on attempt ${attempts}` };
  }
});
