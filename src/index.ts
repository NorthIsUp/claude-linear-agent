import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleWebhook } from "./webhook.js";
import {
  assertValidBaseUrl,
  handleAuthorize,
  handleCallback,
  restorePersistedTokenIfAny,
  setBaseUrl,
} from "./oauth.js";

// Hard-fail at startup: a misconfigured BASE_URL keeps the open-redirect
// surface live, so the service is unsafe to run without it.
try {
  setBaseUrl(assertValidBaseUrl(process.env.BASE_URL));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Hard-fail when the Managed Agents credentials are missing. The bridge
// can't do anything useful without them, and waiting until the first
// webhook to surface the error leaves Linear sessions hanging.
const requiredAgentEnv = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_AGENT_ID",
  "CLAUDE_ENVIRONMENT_ID",
];
const missingAgentEnv = requiredAgentEnv.filter((k) => !process.env[k]);
if (missingAgentEnv.length > 0) {
  console.error(
    `Missing required env var(s): ${missingAgentEnv.join(", ")}. ` +
      `See .env.example for setup instructions.`
  );
  process.exit(1);
}

// Dev-only token restore. Opt-in via DEV_PERSIST_TOKEN=1 in .env.
// Call this before serve() so the first request after restart is authed.
restorePersistedTokenIfAny();

const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "linear-claude-bridge",
    status: "running",
    version: "0.2.0",
  });
});

// Linear OAuth
app.get("/oauth/authorize", handleAuthorize);
app.get("/oauth/callback", handleCallback);

// Linear webhook
app.post("/webhook", handleWebhook);

// Start server
const port = parseInt(process.env.PORT ?? "3001", 10);

console.log(`linear-claude-bridge starting on port ${port}`);
console.log(`OAuth:   http://localhost:${port}/oauth/authorize`);
console.log(`Webhook: http://localhost:${port}/webhook`);

serve({ fetch: app.fetch, port });
