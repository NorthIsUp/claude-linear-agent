/**
 * Anthropic Managed Agents Sessions API client.
 *
 * Sessions persist conversation history server-side, so a Linear `prompted`
 * follow-up can resume the same session by ID — no in-memory mapping needed.
 * The Claude session ID is round-tripped through Linear's externalUrls so the
 * bridge stays stateless across restarts.
 *
 * Docs:
 * - Sessions:    https://platform.claude.com/docs/en/managed-agents/sessions
 * - Events/send: https://platform.claude.com/docs/en/api/beta/sessions/events/send
 * - Streaming:   https://platform.claude.com/docs/en/managed-agents/events-and-streaming
 */

const API_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";

interface CreateSessionInput {
  title?: string;
  metadata?: Record<string, string>;
}

interface CreateSessionResult {
  sessionId: string | null;
  error: string | null;
}

interface RunTurnResult {
  /** Concatenated text content from all agent.message events in this turn. */
  agentText: string;
  /** Why the session went idle. "end_turn" is the normal completion. */
  stopReason: string | null;
  error: string | null;
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };
}

/**
 * Create a new session bound to the configured agent + environment.
 * Returns the session ID; the session starts in `idle` until a user.message
 * is posted via sendUserMessage().
 */
export async function createSession(
  input: CreateSessionInput
): Promise<CreateSessionResult> {
  const agentId = process.env.CLAUDE_AGENT_ID;
  const environmentId = process.env.CLAUDE_ENVIRONMENT_ID;
  if (!agentId || !environmentId) {
    return {
      sessionId: null,
      error: "CLAUDE_AGENT_ID or CLAUDE_ENVIRONMENT_ID not set",
    };
  }

  const body: Record<string, unknown> = {
    agent: agentId,
    environment_id: environmentId,
  };
  if (input.title) body.title = input.title;
  if (input.metadata) body.metadata = input.metadata;

  try {
    const response = await fetch(`${API_BASE}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const errText = await response.text();
      return {
        sessionId: null,
        error: `Sessions create returned ${response.status}: ${errText.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as { id?: string };
    if (!data.id) {
      return { sessionId: null, error: "Sessions create response missing id" };
    }
    return { sessionId: data.id, error: null };
  } catch (err) {
    return {
      sessionId: null,
      error: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Send a `user.message` event into an existing session. The session
 * transitions from idle → running and processes the message; the agent's
 * response arrives via the stream opened by streamUntilIdle.
 */
async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text }],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Sessions events.send returned ${response.status}: ${errText.slice(0, 200)}`
    );
  }
}

/**
 * Run one turn against a session: open the SSE stream, send the user message,
 * accumulate agent.message text until the session reports idle (or errors).
 *
 * Per the docs the stream MUST be opened before sending the message —
 * otherwise events emitted before subscription are missed.
 */
export async function runTurn(
  sessionId: string,
  userText: string,
  maxDurationMs = 30 * 60 * 1000
): Promise<RunTurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { agentText: "", stopReason: null, error: "ANTHROPIC_API_KEY not set" };
  }

  const controller = new AbortController();
  const overallTimeout = setTimeout(() => controller.abort(), maxDurationMs);

  let streamResponse: Response;
  try {
    streamResponse = await fetch(
      `${API_BASE}/v1/sessions/${encodeURIComponent(sessionId)}/stream`,
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": BETA_HEADER,
          accept: "text/event-stream",
        },
        signal: controller.signal,
      }
    );
  } catch (err) {
    clearTimeout(overallTimeout);
    return {
      agentText: "",
      stopReason: null,
      error: `Failed to open stream: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!streamResponse.ok || !streamResponse.body) {
    clearTimeout(overallTimeout);
    const errText = streamResponse.body ? await streamResponse.text() : "";
    return {
      agentText: "",
      stopReason: null,
      error: `Stream returned ${streamResponse.status}: ${errText.slice(0, 200)}`,
    };
  }

  // Stream is now open and buffering. Send the user message.
  try {
    await sendUserMessage(sessionId, userText);
  } catch (err) {
    clearTimeout(overallTimeout);
    controller.abort();
    return {
      agentText: "",
      stopReason: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let agentText = "";
  let stopReason: string | null = null;
  let error: string | null = null;

  try {
    for await (const event of readSSE(streamResponse.body)) {
      switch (event.type) {
        case "agent.message": {
          const content = event.content as Array<{ type: string; text?: string }> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                agentText += block.text;
              }
            }
          }
          break;
        }
        case "session.status_idle": {
          const sr = event.stop_reason as { type?: string } | undefined;
          stopReason = sr?.type ?? "idle";
          // end_turn = the agent finished cleanly. requires_action = paused
          // for tool confirmation or custom tool; we don't handle those in v1.
          if (stopReason === "end_turn" || stopReason === "requires_action") {
            controller.abort();
            return { agentText, stopReason, error: null };
          }
          break;
        }
        case "session.error": {
          const errObj = event.error as { message?: string } | undefined;
          error = errObj?.message ?? "session error";
          controller.abort();
          return { agentText, stopReason: "error", error };
        }
        case "session.status_terminated": {
          controller.abort();
          return {
            agentText,
            stopReason: "terminated",
            error: "session terminated unexpectedly",
          };
        }
      }
    }
  } catch (err) {
    // AbortError from our own controller.abort() above is expected after we
    // returned; only surface unexpected errors.
    if (!controller.signal.aborted) {
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(overallTimeout);
  }

  // Stream ended without an idle event — treat as incomplete.
  return { agentText, stopReason, error: error ?? "stream ended without session.status_idle" };
}

/**
 * Parse a Server-Sent Events body into a stream of decoded JSON event objects.
 * Each SSE block is `data: <json>\n\n`; we ignore other SSE fields (id:, event:).
 */
async function* readSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line (\n\n). Process complete
      // blocks; keep the trailing partial in the buffer.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          else if (line.startsWith("data:")) dataLines.push(line.slice(5));
        }
        if (dataLines.length === 0) continue;
        const json = dataLines.join("\n");
        try {
          yield JSON.parse(json) as Record<string, unknown>;
        } catch {
          // Malformed event — skip. The stream will keep delivering.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the stream is already locked elsewhere; ignore.
    }
  }
}

/**
 * Build the externalUrl the bridge stores on Linear's agent session so the
 * Claude session ID can be recovered from the `prompted` webhook payload
 * without any local storage. The URL points at platform.claude.com — even
 * if it 404s for end users today, the ID is parseable from the path.
 */
export function buildSessionExternalUrl(sessionId: string): string {
  return `https://platform.claude.com/sessions/${encodeURIComponent(sessionId)}`;
}

/** Inverse of buildSessionExternalUrl — returns null if the URL doesn't match. */
export function parseSessionIdFromExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.host !== "platform.claude.com") return null;
    const match = parsed.pathname.match(/^\/sessions\/([^/]+)\/?$/);
    if (!match) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
