import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearClient } from "@linear/sdk";
import type { Context } from "hono";
import { triggerRoutine } from "./claude.js";
import { getLinearClient } from "./oauth.js";

// v82 @linear/sdk method shapes used by U4/U5 (recorded by the U3 spike):
//
//   client.createAgentActivity({ agentSessionId, content })
//     content is typed as JSONObject. Concrete shapes (from AgentActivityContent):
//       thought:  { type: "thought",  body: string }
//       error:    { type: "error",    body: string }
//       response: { type: "response", body: string }  ← closes the session
//       action:   { type: "action",   action: string, parameter: string, result?: string }
//
//   client.agentSessionUpdateExternalUrl(id, { externalUrls: [{ label, url }] })
//     Note: v82 renamed the umbrella agentSessionUpdate mutation to this specific
//     variant on the SDK. externalUrls items are { label, url } (not plain strings).
//
// Webhook payload shapes confirmed empirically (2026-04-24, Gate A + Gate B):
//
//   created:
//     { type: "AgentSessionEvent", action: "created",
//       agentSession: { id, issueId, issue: { title, description, identifier, team }, … },
//       promptContext: "<issue ...><other-thread ...>…</>",   ← rich XML, primary source
//       previousComments: null | […]                            ← sometimes populated
//     }
//
//   prompted:
//     { type: "AgentSessionEvent", action: "prompted",
//       agentSession: { id, issueId, issue: { title, description, identifier, team }, … },
//       agentActivity: {
//         content: { type: "prompt", body: "<user's reply text>" },
//         user:    { name, email, … },                            ← trusted author info
//         sourceCommentId: string,
//         createdAt: ISO8601,
//       },
//       // NOTE: prompted payloads do NOT include promptContext, previousComments,
//       // or prior activities. Prior thread state must be fetched by Claude via
//       // the Linear MCP connector if needed. See processPromptedSession.
//     }
//
// Gate B finding: Linear delivers `prompted` events even on sessions previously
// closed with a `response` activity. `response` closes the sidebar session
// cleanly without blocking follow-ups.

/**
 * Verify that the webhook payload came from Linear.
 * Linear signs webhooks with HMAC-SHA256 using your webhook secret.
 *
 * Compares in constant time via crypto.timingSafeEqual. Rejects malformed
 * header input (empty, non-hex, wrong length) without throwing.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  // Validate shape before decoding: timingSafeEqual throws on length mismatch,
  // and Buffer.from(hex, 'hex') silently truncates on non-hex chars.
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;

  return timingSafeEqual(expected, received);
}

/**
 * Handle incoming Linear webhooks.
 * We handle AgentSessionEvent with action "created" (new assignment) here.
 * The "prompted" branch (user reply) lands in U5.
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

  // Diagnostic: full payload dump for every AgentSessionEvent. Gated by env
  // flag so production logs stay clean. Resolves Gate A + shows prompted shape.
  if (
    process.env.DEBUG_PAYLOAD === "1" &&
    payload.type === "AgentSessionEvent"
  ) {
    console.log(
      `[debug] Full webhook payload (${payload.action}):\n` +
        JSON.stringify(payload, null, 2).substring(0, 6000)
    );
  }

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
  } else if (payload.action === "prompted") {
    processPromptedSession(payload).catch((err) => {
      console.error("Error processing prompted event:", err);
    });
  }

  return c.text("OK", 200);
}

/**
 * Shared thought → fire → action/externalUrl/response (or error) sequence,
 * used by both `created` and `prompted` handlers. Emits the thought before
 * firing the Routine so Linear's 10s acknowledgement window is met even
 * when /fire is slow. Raw Routines errors stay server-side; the user-facing
 * error body is generic (R4).
 */
async function fireAndRespond(
  client: LinearClient,
  sessionId: string,
  params: {
    thoughtBody: string;
    actionLabel: string;
    responseBody: string;
    routineText: string;
  }
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "thought", body: params.thoughtBody },
  });

  const result = await triggerRoutine(params.routineText);

  if (!result.sessionUrl) {
    console.error("Routine fire failed:", result.error);
    await client.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: "error",
        body: "Routine fire failed — check server logs.",
      },
    });
    return;
  }

  console.log(`Claude session started: ${result.sessionUrl}`);

  // action shape (per U3 spike) uses `action` + `parameter`, not `body`.
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: {
      type: "action",
      action: params.actionLabel,
      parameter: result.sessionUrl,
    },
  });

  await client.agentSessionUpdateExternalUrl(sessionId, {
    externalUrls: [{ label: "Claude Code", url: result.sessionUrl }],
  });

  // `response` closes the session in Linear's UI. Gate B confirmed Linear
  // still delivers `prompted` events on response-closed sessions, so
  // closing here doesn't break follow-ups.
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "response", body: params.responseBody },
  });
}

/**
 * Handle a new agent session (issue assigned to the agent).
 * Linear's `created` payload includes a rich `promptContext` XML blob
 * with issue metadata and prior thread comments — pass it straight through.
 */
async function processNewSession(payload: Record<string, unknown>) {
  const agentSession =
    (payload.agentSession as Record<string, unknown> | undefined) ??
    (payload.data as Record<string, unknown> | undefined);
  const sessionId = agentSession?.id as string | undefined;
  const issueId = agentSession?.issueId as string | undefined;
  const promptContext =
    (payload.promptContext as string | undefined) ??
    (agentSession?.promptContext as string | undefined);

  if (!sessionId) {
    console.error("No agentSession.id in webhook payload");
    return;
  }

  const client = getLinearClient();
  if (!client) {
    console.warn(
      `No Linear client available — skipping session ${sessionId} (agent not installed)`
    );
    return;
  }

  console.log(`New agent session ${sessionId} for issue ${issueId ?? "(unknown)"}`);

  await fireAndRespond(client, sessionId, {
    thoughtBody: "Preparing to fire Claude Routine with issue context…",
    actionLabel: "Started Claude Code session",
    responseBody:
      "Claude Code has taken over this issue. Watch the linked session for live progress, " +
      "or reply here to send a follow-up.",
    routineText: promptContext ?? "No context provided",
  });
}

/**
 * Handle a user reply in the agent session thread.
 * Linear's `prompted` payload carries ONLY the new reply + issue metadata —
 * no prior thread history (Gate A finding, 2026-04-24). Routines itself is
 * fire-and-forget and cannot continue an existing Claude session, so each
 * reply spawns a fresh Routine. We tell Claude to read the prior thread via
 * the Linear MCP connector for context.
 */
async function processPromptedSession(payload: Record<string, unknown>) {
  const agentSession = payload.agentSession as Record<string, unknown> | undefined;
  const agentActivity = payload.agentActivity as Record<string, unknown> | undefined;
  const sessionId = agentSession?.id as string | undefined;
  const issue = agentSession?.issue as Record<string, unknown> | undefined;
  const content = agentActivity?.content as Record<string, unknown> | undefined;
  const user = agentActivity?.user as Record<string, unknown> | undefined;

  const replyBody = content?.body as string | undefined;
  const replyAuthor = (user?.name as string | undefined) ?? "Unknown user";
  const replyAt = (agentActivity?.createdAt as string | undefined) ?? "";
  const issueIdentifier = (issue?.identifier as string | undefined) ?? "(unknown)";
  const issueTitle = (issue?.title as string | undefined) ?? "";
  const issueDescription = (issue?.description as string | undefined) ?? "";

  if (!sessionId) {
    console.error("No agentSession.id in prompted payload");
    return;
  }
  if (!replyBody) {
    console.error("No agentActivity.content.body in prompted payload — nothing to forward");
    return;
  }

  const client = getLinearClient();
  if (!client) {
    console.warn(
      `No Linear client available — skipping prompted session ${sessionId} (agent not installed)`
    );
    return;
  }

  console.log(
    `Prompted on session ${sessionId} (issue ${issueIdentifier}) by ${replyAuthor}`
  );

  // Routines is fire-and-forget, so every follow-up starts a fresh Claude
  // session. The reply body is the only user-controlled field — we wrap it
  // in XML-style tags matching Linear's own `promptContext` conventions so
  // Claude sees consistent structure across created/prompted invocations.
  const routineText =
    `<issue identifier="${issueIdentifier}">\n` +
    `<title>${issueTitle}</title>\n` +
    `<description>${issueDescription}</description>\n` +
    `</issue>\n\n` +
    `<user_reply author="${replyAuthor}" at="${replyAt}">\n` +
    `${replyBody}\n` +
    `</user_reply>\n\n` +
    `This is a follow-up on the Linear issue above. Use the Linear MCP ` +
    `to fetch prior comments and agent session activities on issue ` +
    `${issueIdentifier} for full conversation context before responding.`;

  await fireAndRespond(client, sessionId, {
    thoughtBody: "Preparing follow-up Claude session with the new reply…",
    actionLabel: "Started follow-up Claude Code session",
    responseBody:
      "Claude Code is handling your follow-up in a new session. Watch the linked session for progress, " +
      "or reply here to send another follow-up.",
    routineText,
  });
}
