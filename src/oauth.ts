import { LinearClient } from "@linear/sdk";
import type { Context } from "hono";

/**
 * In-memory token storage. Maps workspace ID → access token.
 * Good enough for local dev. Replace with a database for production.
 */
const tokens = new Map<string, string>();

// We also keep a "current" token for the simplest case (single workspace)
let currentToken: string | null = null;

/**
 * GET /oauth/authorize
 *
 * Redirects the user to Linear's OAuth page. After they approve,
 * Linear redirects back to /oauth/callback with an auth code.
 *
 * Key scopes:
 * - read: read issues, comments, etc.
 * - write: create comments, update issues
 * - app:assignable: allow the agent to be assigned issues
 *
 * actor=app: creates a dedicated agent user (not tied to your personal account)
 */
export function handleAuthorize(c: Context) {
  const clientId = process.env.LINEAR_CLIENT_ID;
  if (!clientId) {
    return c.text("LINEAR_CLIENT_ID not set", 500);
  }

  const redirectUri = `${getBaseUrl(c)}/oauth/callback`;
  const scopes = "read,write,app:assignable";

  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("actor", "app");

  return c.redirect(url.toString());
}

/**
 * GET /oauth/callback
 *
 * Linear redirects here after the user approves. We exchange
 * the auth code for an access token and store it.
 */
export async function handleCallback(c: Context) {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code parameter", 400);
  }

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.text("OAuth credentials not configured", 500);
  }

  const redirectUri = `${getBaseUrl(c)}/oauth/callback`;

  // Exchange code for access token
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("OAuth token exchange failed:", err);
    return c.text(`Token exchange failed: ${err}`, 500);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
  };

  // Store the token
  currentToken = data.access_token;

  // Try to get workspace info so we can key the token properly
  try {
    const client = new LinearClient({ accessToken: data.access_token });
    // v82 note (U3 spike): `client.organization` is still a getter returning
    // LinearFetch<Organization> — `await client.organization` yields { id, name, … }.
    const org = await client.organization;
    tokens.set(org.id, data.access_token);
    console.log(`Stored token for workspace: ${org.name} (${org.id})`);
  } catch {
    console.log("Stored token (could not fetch workspace info)");
  }

  return c.text("Agent installed successfully! You can close this tab.");
}

/**
 * Get a Linear client using the stored token.
 * Returns null if no token is available.
 */
export function getLinearClient(): LinearClient | null {
  if (!currentToken) return null;
  return new LinearClient({ accessToken: currentToken });
}

/**
 * Figure out the base URL for OAuth redirects.
 * Uses the request's host header so it works with localtunnel.
 */
function getBaseUrl(c: Context): string {
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? `localhost:${process.env.PORT ?? 3000}`;
  return `${proto}://${host}`;
}
