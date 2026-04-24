/**
 * Claude Routines API client.
 *
 * Fires a pre-configured Routine on Anthropic's cloud.
 * The Routine must be set up at claude.ai/code/routines with:
 * - Your target GitHub repo connected
 * - A prompt template for handling Linear issues
 *
 * API docs: https://platform.claude.com/docs/en/api/claude-code/routines-fire
 */

interface RoutineResult {
  sessionUrl: string | null;
  sessionId: string | null;
  error: string | null;
}

export async function triggerRoutine(issueContext: string): Promise<RoutineResult> {
  const routineId = process.env.CLAUDE_ROUTINE_ID;
  const routineToken = process.env.CLAUDE_ROUTINE_TOKEN;

  if (!routineId || !routineToken) {
    return {
      sessionUrl: null,
      sessionId: null,
      error: "CLAUDE_ROUTINE_ID or CLAUDE_ROUTINE_TOKEN not set",
    };
  }

  const url = `https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`;

  try {
    // 60s timeout. Routines /fire returns quickly once the session is
    // queued — a stall past a minute indicates the upstream is wedged.
    // Without this, fireAndRespond would await forever after the thought
    // activity, leaving the Linear sidebar permanently unresolved.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${routineToken}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: issueContext,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        sessionUrl: null,
        sessionId: null,
        error: `Routines API returned ${response.status}: ${errorText}`,
      };
    }

    const data = (await response.json()) as {
      claude_code_session_id?: string;
      claude_code_session_url?: string;
    };

    return {
      sessionUrl: data.claude_code_session_url ?? null,
      sessionId: data.claude_code_session_id ?? null,
      error: null,
    };
  } catch (err) {
    return {
      sessionUrl: null,
      sessionId: null,
      error: `Failed to call Routines API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
