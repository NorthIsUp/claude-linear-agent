import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearClient } from "@linear/sdk";
import type { Context } from "hono";
import { getLinearClient } from "./oauth.js";
import {
  buildSessionExternalUrl,
  createSession,
  parseSessionIdFromExternalUrl,
  runTurn,
} from "./sessions.js";

// v82 @linear/sdk method shapes used by created/prompted handlers:
//
//   client.createAgentActivity({ agentSessionId, content })
//     content variants:
//       thought:  { type: "thought",  body: string }
//       error:    { type: "error",    body: string }
//       response: { type: "response", body: string }  ← closes the session
//       action:   { type: "action",   action: string, parameter: string }
//
//   client.agentSessionUpdateExternalUrl(id, { externalUrls: [{ label, url }] })
//
//   client.agentSession(id) → AgentSession  (fetched on prompted to recover
//     the Claude session_id we previously stored as an externalUrl)
//
// Statelessness: the Claude session_id is round-tripped through Linear's
// externalUrls. On `prompted`, we read it back from the agent session — the
// bridge holds zero per-session state across restarts.

const MAX_RESPONSE_BODY = 32_000;

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
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;

  return timingSafeEqual(expected, received);
}

/**
 * Handle incoming Linear webhooks.
 * AgentSessionEvent.created → start a new Managed Agents session.
 * AgentSessionEvent.prompted → resume the same session with a follow-up.
 */
export async function handleWebhook(c: Context) {
  const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("LINEAR_WEBHOOK_SECRET not set");
    return c.text("Server misconfigured", 500);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("linear-signature") ?? "";

  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn("Invalid webhook signature — rejecting");
    return c.text("Invalid signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.warn("Webhook body is not valid JSON — rejecting:", err);
    return c.text("Invalid JSON body", 400);
  }
  console.log(`Webhook received: type=${payload.type}, action=${payload.action}`);

  if (
    process.env.DEBUG_PAYLOAD === "1" &&
    payload.type === "AgentSessionEvent"
  ) {
    console.log(
      `[debug] Full webhook payload (${payload.action}):\n` +
        JSON.stringify(payload, null, 2).substring(0, 6000)
    );
  }

  if (payload.type !== "AgentSessionEvent") {
    return c.text("OK", 200);
  }

  // Respond immediately (Linear requires 200 within 5 seconds). The session
  // turn — which can take minutes — runs detached in the background.
  if (payload.action === "created") {
    processNewSession(payload).catch((err) => {
      console.error("Error processing created session:", err);
    });
  } else if (payload.action === "prompted") {
    processPromptedSession(payload).catch((err) => {
      console.error("Error processing prompted session:", err);
    });
  }

  return c.text("OK", 200);
}

/**
 * Truncate the agent's response body to a length Linear will accept and
 * append a marker if anything was dropped.
 */
function truncateForLinear(body: string): string {
  if (body.length <= MAX_RESPONSE_BODY) return body;
  return body.slice(0, MAX_RESPONSE_BODY) + "\n\n…(truncated)";
}

/**
 * Drive one turn end-to-end: emit a thought (R2 ack), run the turn against
 * the Claude session (streaming until idle), then emit a response or error
 * activity in Linear.
 */
async function runTurnAndPostResult(
  client: LinearClient,
  linearSessionId: string,
  claudeSessionId: string,
  thoughtBody: string,
  userText: string
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: linearSessionId,
    content: { type: "thought", body: thoughtBody },
  });

  const result = await runTurn(claudeSessionId, userText);

  if (result.error) {
    console.error(
      `Claude session ${claudeSessionId} turn failed:`,
      result.error
    );
    await client.createAgentActivity({
      agentSessionId: linearSessionId,
      content: {
        type: "error",
        body: "Claude session turn failed — check server logs.",
      },
    });
    return;
  }

  const agentText = result.agentText.trim();
  const responseBody = agentText.length > 0
    ? truncateForLinear(agentText)
    : "(Claude finished without producing a text response.)";

  await client.createAgentActivity({
    agentSessionId: linearSessionId,
    content: { type: "response", body: responseBody },
  });
}

/**
 * Recover the Claude session_id from the Linear agent session's externalUrls.
 * Tries the inline payload first (when present) then falls back to a fetch.
 * Returns null if no claude.com URL is attached — the caller should treat
 * that as "no prior session, start a fresh one."
 */
async function recoverClaudeSessionId(
  client: LinearClient,
  linearSessionId: string,
  agentSession: Record<string, unknown> | undefined
): Promise<string | null> {
  type ExternalUrlEntry = { url?: string };
  const inline = agentSession?.externalUrls as ExternalUrlEntry[] | undefined;
  if (Array.isArray(inline)) {
    for (const entry of inline) {
      const id = entry?.url ? parseSessionIdFromExternalUrl(entry.url) : null;
      if (id) return id;
    }
  }

  // Fallback: fetch the agent session directly. v82 exposes this as a getter
  // pattern: `await client.agentSession(id)` resolves to the model.
  try {
    const session = await client.agentSession(linearSessionId);
    const externalUrls = (session as unknown as { externalUrls?: ExternalUrlEntry[] })
      .externalUrls;
    if (Array.isArray(externalUrls)) {
      for (const entry of externalUrls) {
        const id = entry?.url ? parseSessionIdFromExternalUrl(entry.url) : null;
        if (id) return id;
      }
    }
  } catch (err) {
    console.warn(
      `Could not fetch agent session ${linearSessionId} for externalUrls:`,
      err
    );
  }
  return null;
}

/**
 * Handle a new agent session (issue assigned to the agent).
 */
async function processNewSession(payload: Record<string, unknown>) {
  const agentSession = payload.agentSession as Record<string, unknown> | undefined;
  const sessionId = agentSession?.id as string | undefined;
  const issue = agentSession?.issue as Record<string, unknown> | undefined;
  const issueIdentifier = (issue?.identifier as string | undefined) ?? "";
  const issueTitle = (issue?.title as string | undefined) ?? "";
  const promptContext =
    (payload.promptContext as string | undefined) ??
    (agentSession?.promptContext as string | undefined) ??
    "No issue context provided.";

  if (!sessionId) {
    console.error("No agentSession.id in created payload");
    return;
  }

  const client = getLinearClient();
  if (!client) {
    console.warn(
      `No Linear client available — skipping created session ${sessionId} (agent not installed)`
    );
    return;
  }

  console.log(`New agent session ${sessionId} for issue ${issueIdentifier || "?"}`);

  // R2 ack: emit a thought before the slow create-session call.
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "thought", body: "Creating Claude session for this issue…" },
  });

  const sessionTitle = issueIdentifier
    ? `${issueIdentifier}: ${issueTitle}`.slice(0, 200)
    : issueTitle.slice(0, 200) || "Linear issue";

  const created = await createSession({
    title: sessionTitle,
    metadata: { linear_session_id: sessionId },
  });

  if (!created.sessionId) {
    console.error("Sessions create failed:", created.error);
    await client.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: "error",
        body: "Could not create Claude session — check server logs.",
      },
    });
    return;
  }

  const claudeSessionId = created.sessionId;
  const claudeSessionUrl = buildSessionExternalUrl(claudeSessionId);
  console.log(`Claude session created: ${claudeSessionId}`);

  // Record the Claude session ID on the Linear agent session. This is the
  // ONLY place we persist it — `prompted` events read it back from here.
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: {
      type: "action",
      action: "Started Claude session",
      parameter: claudeSessionUrl,
    },
  });

  await client.agentSessionUpdateExternalUrl(sessionId, {
    externalUrls: [{ label: "Claude session", url: claudeSessionUrl }],
  });

  await runTurnAndPostResult(
    client,
    sessionId,
    claudeSessionId,
    "Sending issue context to Claude…",
    promptContext
  );
}

/**
 * Handle a follow-up reply on an existing agent session.
 *
 * Stateless flow: the Claude session_id was stored in the Linear agent
 * session's externalUrls during the `created` handler. We recover it,
 * post the new user reply into the same Claude session (preserving the
 * full conversation history), and stream the response back.
 *
 * If the Claude session ID can't be recovered (e.g. the agent session was
 * created before this version of the bridge), we fall back to creating a
 * fresh Claude session — matching the legacy fire-and-forget behavior.
 */
async function processPromptedSession(payload: Record<string, unknown>) {
  const agentSession = payload.agentSession as Record<string, unknown> | undefined;
  const agentActivity = payload.agentActivity as Record<string, unknown> | undefined;
  const sessionId = agentSession?.id as string | undefined;
  const content = agentActivity?.content as Record<string, unknown> | undefined;
  const replyBody = content?.body as string | undefined;

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
      `No Linear client available — skipping prompted session ${sessionId}`
    );
    return;
  }

  console.log(`Prompted on agent session ${sessionId}`);

  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "thought", body: "Forwarding your reply to the Claude session…" },
  });

  const claudeSessionId = await recoverClaudeSessionId(client, sessionId, agentSession);

  if (claudeSessionId) {
    await runTurnAndPostResult(
      client,
      sessionId,
      claudeSessionId,
      `Resuming Claude session ${claudeSessionId}…`,
      replyBody
    );
    return;
  }

  // No prior Claude session linked — start a new one with just the reply
  // as context. The user is told via the action activity that this is a
  // fresh session, so they aren't surprised by missing prior history.
  console.warn(
    `No prior Claude session found on Linear session ${sessionId}; starting fresh`
  );

  const created = await createSession({
    title: `Linear session ${sessionId}`.slice(0, 200),
    metadata: { linear_session_id: sessionId },
  });
  if (!created.sessionId) {
    console.error("Sessions create failed:", created.error);
    await client.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: "error",
        body: "Could not create Claude session — check server logs.",
      },
    });
    return;
  }
  const newClaudeSessionId = created.sessionId;
  const newClaudeSessionUrl = buildSessionExternalUrl(newClaudeSessionId);

  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: {
      type: "action",
      action: "Started Claude session (fresh — prior session not recoverable)",
      parameter: newClaudeSessionUrl,
    },
  });
  await client.agentSessionUpdateExternalUrl(sessionId, {
    externalUrls: [{ label: "Claude session", url: newClaudeSessionUrl }],
  });

  await runTurnAndPostResult(
    client,
    sessionId,
    newClaudeSessionId,
    "Sending your reply to Claude…",
    replyBody
  );
}
