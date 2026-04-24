import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleWebhook } from "./webhook.js";
import { assertValidBaseUrl, handleAuthorize, handleCallback, setBaseUrl } from "./oauth.js";

// Hard-fail at startup: a misconfigured BASE_URL keeps the open-redirect
// surface live, so the service is unsafe to run without it.
try {
  setBaseUrl(assertValidBaseUrl(process.env.BASE_URL));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "linear-routines-bridge",
    status: "running",
    version: "0.1.0",
  });
});

// Linear OAuth
app.get("/oauth/authorize", handleAuthorize);
app.get("/oauth/callback", handleCallback);

// Linear webhook
app.post("/webhook", handleWebhook);

// Start server
const port = parseInt(process.env.PORT ?? "3001", 10);

console.log(`linear-routines-bridge starting on port ${port}`);
console.log(`OAuth:   http://localhost:${port}/oauth/authorize`);
console.log(`Webhook: http://localhost:${port}/webhook`);

serve({ fetch: app.fetch, port });
