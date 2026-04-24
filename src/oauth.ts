import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { LinearClient } from "@linear/sdk";
import type { Context } from "hono";

// Single-workspace, single-deployment, single-install scope. See README
// "Tokens lost on restart" callout: a crash/restart requires reinstalling.
let currentToken: string | null = null;

// Dev-only token persistence. Opt-in via DEV_PERSIST_TOKEN=1 in the env.
// Writes the access token to DEV_TOKEN_FILE so `tsx watch` reloads and
// manual restarts don't force a full OAuth re-install each time. NEVER
// use in production: the file is plaintext and bypasses the "ephemeral
// token" scope boundary that keeps the production footprint minimal.
const DEV_TOKEN_FILE = ".token-dev.json";
function devPersistenceEnabled(): boolean {
  return process.env.DEV_PERSIST_TOKEN === "1";
}
export function restorePersistedTokenIfAny(): void {
  if (!devPersistenceEnabled()) return;
  try {
    if (!existsSync(DEV_TOKEN_FILE)) return;
    const raw = readFileSync(DEV_TOKEN_FILE, "utf8");
    const { access_token } = JSON.parse(raw) as { access_token?: string };
    if (typeof access_token === "string" && access_token.length > 0) {
      currentToken = access_token;
      console.log("[dev] Restored OAuth token from .token-dev.json");
    }
  } catch (err) {
    console.warn("[dev] Could not restore token cache:", err);
  }
}
function persistTokenIfDev(token: string): void {
  if (!devPersistenceEnabled()) return;
  try {
    writeFileSync(DEV_TOKEN_FILE, JSON.stringify({ access_token: token }), {
      mode: 0o600,
    });
    console.log("[dev] Cached OAuth token to .token-dev.json");
  } catch (err) {
    console.warn("[dev] Could not write token cache:", err);
  }
}

// CSRF state store for /oauth/authorize → /oauth/callback round-trip.
// Entries expire after STATE_TTL_MS and are deleted on read.
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const stateStore = new Map<string, { createdAt: number }>();

/**
 * Validate BASE_URL and return it without a trailing slash.
 * Must be an absolute URL. Non-localhost hosts must use https://.
 * Throws on violation so startup can fail fast.
 */
export function assertValidBaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error("BASE_URL is required (absolute URL, https for non-localhost)");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`BASE_URL is not a valid absolute URL: ${url}`);
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const isLocal = localHosts.has(parsed.hostname);
  if (parsed.protocol === "http:" && !isLocal) {
    throw new Error(
      `BASE_URL must use https:// for non-localhost hosts (got: ${url})`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `BASE_URL must use http:// or https:// (got: ${parsed.protocol})`
    );
  }
  return url.replace(/\/+$/, "");
}

// Resolved once at startup by src/index.ts calling assertValidBaseUrl.
// We avoid reading process.env.BASE_URL per-request so header-based
// redirect manipulation is impossible.
let baseUrl: string | null = null;
export function setBaseUrl(validated: string): void {
  baseUrl = validated;
}
function requireBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("BASE_URL not initialized — call setBaseUrl() at startup");
  }
  return baseUrl;
}

function sweepExpiredState(now: number): void {
  for (const [key, entry] of stateStore) {
    if (now - entry.createdAt > STATE_TTL_MS) stateStore.delete(key);
  }
}

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

  const state = randomBytes(32).toString("hex");
  stateStore.set(state, { createdAt: Date.now() });

  const redirectUri = `${requireBaseUrl()}/oauth/callback`;
  const scopes = "read,write,app:assignable";

  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", state);

  return c.redirect(url.toString());
}

/**
 * GET /oauth/callback
 *
 * Linear redirects here after the user approves. We exchange
 * the auth code for an access token and store it.
 */
export async function handleCallback(c: Context) {
  // Reject-on-existing-token: once installed, a second OAuth round-trip
  // cannot silently overwrite the workspace. Restart to re-authorize.
  if (currentToken !== null) {
    return c.text(
      "Agent is already installed. Restart the server to re-authorize.",
      409
    );
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code parameter", 400);
  }

  const state = c.req.query("state");
  if (!state) {
    return c.text("Missing state parameter", 400);
  }

  const now = Date.now();
  sweepExpiredState(now);
  const entry = stateStore.get(state);
  // Delete on read — even if the token exchange fails, state cannot be reused.
  stateStore.delete(state);
  if (!entry || now - entry.createdAt > STATE_TTL_MS) {
    return c.text("Invalid or expired state parameter", 400);
  }

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.text("OAuth credentials not configured", 500);
  }

  const redirectUri = `${requireBaseUrl()}/oauth/callback`;

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
    return c.text("Token exchange failed — check server logs", 500);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
  };

  currentToken = data.access_token;
  persistTokenIfDev(data.access_token);

  // Log workspace info for operator visibility. Failure is non-fatal —
  // the token is already valid for API use.
  try {
    const client = new LinearClient({ accessToken: data.access_token });
    // v82 note (U3 spike): `client.organization` is still a getter returning
    // LinearFetch<Organization> — `await client.organization` yields { id, name, … }.
    const org = await client.organization;
    console.log(`Installed for workspace: ${org.name} (${org.id})`);
  } catch {
    console.log("Token stored (could not fetch workspace info)");
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
