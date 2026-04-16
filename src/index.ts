import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleWebhook } from "./webhook.js";
import { handleAuthorize, handleCallback } from "./oauth.js";

const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "claude-linear-agent",
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

console.log(`claude-linear-agent starting on port ${port}`);
console.log(`OAuth:   http://localhost:${port}/oauth/authorize`);
console.log(`Webhook: http://localhost:${port}/webhook`);

serve({ fetch: app.fetch, port });
