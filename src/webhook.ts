import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { triggerRoutine } from "./claude.js";
import { getLinearClient } from "./oauth.js";

// v82 @linear/sdk method shapes used by U4/U5 (recorded by the U3 spike):
//
//   client.createAgentActivity({ agentSessionId, content })
//     content is typed as JSONObject. Concrete shapes (from AgentActivityContent):
//       thought:  { type: "thought",  body: string }
//       error:    { type: "error",    body: string }
//       response: { type: "response", body: string }
//       action:   { type: "action",   action: string, parameter: string, result?: string }
//
//   client.agentSessionUpdateExternalUrl(id, { externalUrls: [{ label, url }] })
//     Note: v82 renamed the umbrella agentSessionUpdate mutation to this specific
//     variant on the SDK. externalUrls items are { label, url } (not plain strings).
//
// Webhook payload (AgentSessionEventWebhookPayload in v82 .d.ts):
//   { type: "AgentSessionEvent", action: "created" | "prompted" | …,
//     agentSession: { id, issueId, status, … },
//     agentActivity?: { content, user, createdAt, … }  // present on "prompted"
//     promptContext?: string                           // "created" only
//     previousComments?: […]                           // "created" only, if from thread
//   }
// Runtime shape is confirmed empirically by Gate A during U5.

/**
 * Verify that the webhook payload came from Linear.
 * Linear signs webhooks with HMAC-SHA256 using your webhook secret.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return expected === signature;
}

/**
 * Handle incoming Linear webhooks.
 * We only care about AgentSessionEvent with action "created" —
 * this fires when someone assigns an issue to our agent.
 */
export async function handleWebhook(c: Context) {
  const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("LINEAR_WEBHOOK_SECRET not set");
    return c.text("Server misconfigured", 500);
  }

  // Get raw body for signature verification
  const rawBody = await c.req.text();
  const signature = c.req.header("linear-signature") ?? "";

  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn("Invalid webhook signature — rejecting");
    return c.text("Invalid signature", 401);
  }

  const payload = JSON.parse(rawBody);
  console.log(`Webhook received: type=${payload.type}, action=${payload.action}`);

  // We only handle agent session events
  if (payload.type !== "AgentSessionEvent") {
    return c.text("OK", 200);
  }

  // Respond immediately (Linear requires 200 within 5 seconds)
  // Process the session asynchronously
  if (payload.action === "created") {
    processNewSession(payload).catch((err) => {
      console.error("Error processing session:", err);
    });
  }

  return c.text("OK", 200);
}

/**
 * Process a new agent session — this runs async after we've already
 * responded 200 to Linear's webhook.
 *
 * Flow:
 * 1. Extract issue context from the session
 * 2. Fire a Claude Routine with that context
 * 3. Post the session URL back to Linear as a comment
 */
async function processNewSession(payload: Record<string, unknown>) {
  const session = payload.data as Record<string, unknown>;
  const issueId = session.issueId as string | undefined;
  const promptContext = session.promptContext as string | undefined;

  if (!issueId) {
    console.error("No issueId in session payload");
    return;
  }

  console.log(`New agent session for issue ${issueId}`);
  console.log(`Context: ${promptContext?.substring(0, 200)}...`);

  // Step 1: Trigger Claude Routine
  const result = await triggerRoutine(promptContext ?? "No context provided");

  if (!result.sessionUrl) {
    console.error("Failed to trigger routine:", result.error);

    // Post failure comment
    const client = getLinearClient();
    if (client) {
      await client.createComment({
        issueId,
        body: `Failed to start Claude session: ${result.error ?? "Unknown error"}`,
      });
    }
    return;
  }

  console.log(`Claude session started: ${result.sessionUrl}`);

  // Step 2: Post session URL back to Linear as a comment
  const client = getLinearClient();
  if (client) {
    await client.createComment({
      issueId,
      body: `Claude is working on this.\n\nSession: ${result.sessionUrl}`,
    });
    console.log(`Posted session link to issue ${issueId}`);
  } else {
    console.warn("No Linear client available — could not post comment");
  }
}
