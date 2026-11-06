/**
 * Isolate tests from the developer's machine. Import this before anything from src/:
 * a default credentials path would read and overwrite a real ./.credentials.json,
 * and the SDK loads .env on import.
 */

import os from "node:os";
import path from "node:path";

process.env.ALLEVITAS_CREDENTIALS_PATH = path.join(os.tmpdir(), `allevitas-test-${process.pid}`, "credentials.json");
process.env.ALLEVITAS_KEYRING = "off";
for (const key of ["ALLEVITAS_AGENT_KEY", "ALLEVITAS_TOKEN", "ALLEVITAS_ACCOUNT_ID", "ALLEVITAS_RECOVERY_KEY_FILE"]) {
  process.env[key] = "";
}
// Whether the MCP server solves challenges itself depends on these, so no developer key may leak in
for (const key of [
  "ALLEVITAS_LLM_PROVIDER",
  "LLM_PROVIDER",
  "ALLEVITAS_LLM_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
]) {
  process.env[key] = "";
}
