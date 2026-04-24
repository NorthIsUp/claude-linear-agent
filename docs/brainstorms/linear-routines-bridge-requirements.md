---
date: 2026-04-24
topic: linear-routines-bridge
---

# Linear Routines Bridge — Clean Linear-Side Integration

## Problem Frame

The current `claude-linear-agent` acts like a bot, not an agent. When an issue is assigned, it posts a plain comment with a session URL via `createComment` and disappears. Linear never renders it in the agent sidebar, the 10-second session acknowledgement is missed, follow-up replies are ignored, and the project is named `claude-linear-agent` despite not using Linear's Agent API at all.

Claude Code Routines is fire-and-forget by design (no completion callback, no polling, no follow-ups into an existing session). Anthropic's Claude Managed Agents API (shipped April 2026) would close the completion loop and support follow-ups natively — migrating to it is the architecturally ideal move. This brainstorm accepts Routines' limitations in v1 and invests only in the Linear side: use the Agent Interaction API so the integration renders as a real Linear-native agent, even though the Claude side stays one-shot. Managed Agents migration is an open v1.1+ option; Linear-side work here (R1–R5) is reusable if that migration happens.

## Requirements

**Linear agent rendering**
- R1. Replace `createComment` with `createAgentActivity` for all session-bound posts. Use the structured activity types (`thought`, `action`, `error`) so posts render in the Linear agent sidebar rather than the plain comment thread.
- R2. Within 10 seconds of receiving an `AgentSessionEvent` with `action: "created"`, emit at least one activity (a `thought` such as "Preparing to fire Claude Routine with issue context") so Linear marks the agent as responsive and does not flag the session as unresponsive.
- R3. After a successful Routines `/fire`, emit an `action` activity capturing the fire result (including the Claude session URL), and call `agentSessionUpdate` to set `externalUrls` → the Claude session URL so users can jump from the Linear sidebar directly to the running session.
- R4. On Routines `/fire` failure, emit an `error` activity with a generic message ("Routine fire failed — check server logs"). Do not include the raw Routines API error body in the activity (can leak request IDs, rate-limit info, or account hints to all workspace members). Log the full error server-side.

**Follow-up handling**
- R5. Handle `AgentSessionEvent` webhooks with `action: "prompted"`. Each prompted event fires a new Claude Routine; the `text` parameter contains the original issue context plus the accumulated user replies, each reply wrapped in structural delimiters. **The delimiters are not a security boundary on their own** — a reply body can contain the literal closing tag and escape the wrapper. Either (a) HTML-entity-encode `<`, `>`, `&`, and `"` in reply text before wrapping, or (b) generate a random per-request nonce-suffixed tag (`<user_reply_abc123f>…</user_reply_abc123f>`) so counterfeit closing tags cannot match. Planning picks one. The author attributes (`author="…" at="…"`) MUST come from the trusted webhook payload fields, not from the reply text. Emit the R2–R4 activity sequence in response.

**Packaging and public release**
- R6. Rename the package from `claude-linear-agent` to `linear-routines-bridge` (in `package.json`, README, server logs, and health-check response).
- R7. Upgrade `@linear/sdk` from `^39.0.0` to `^82.0.0`. The agent interaction APIs (`createAgentActivity`, `agentSessionUpdate`) do not exist in v39.
- R8. README covers architecture, setup (Linear OAuth app + webhook + Claude Routine config), required env vars (including `BASE_URL` per R10), and deploy options (local with tunnel, Fly/Railway/Render class PaaS). **Four prominent limitation callouts are required:**
  1. **No completion signal.** After the action activity, the Linear sidebar goes silent until the user replies or reassigns. Users must click to `claude.ai/code` for live progress. Inherent to the Routines backend.
  2. **No cost or runaway protection.** Every reply fires a new Routine with accumulated context. Chatty threads grow context roughly quadratically and hit the 65k-char `text` cap around 15–25 replies, at which point older context is silently truncated without the user knowing.
  3. **Tokens lost on restart.** OAuth tokens and CSRF state live in-memory only. Every server restart (including PaaS cold starts / idle-kill) requires re-authorization. Not suitable for free-tier PaaS that sleeps idle containers without manual re-install. For local dev with tunnels: if the tunnel URL rotates, both `BASE_URL` and the Linear OAuth app's registered `redirect_uri` must be updated.
  4. **Webhook secret = Routines fire credential.** A leaked `LINEAR_WEBHOOK_SECRET` lets any party forge Linear events that pass HMAC verification and trigger Routines fires with arbitrary `text` against the deployer's Anthropic account — functionally equivalent to leaking `CLAUDE_ROUTINE_TOKEN`. Treat both secrets with the same care; rotate the webhook secret in Linear's app settings and the env var together.

**Security and hygiene**
- R9. Replace `===` comparison in `verifyWebhookSignature` with a timing-safe hex comparison: decode both computed and received signatures to `Buffer` via `Buffer.from(hex, 'hex')`, length-check on the *decoded byte length* (not the raw hex string length), then compare with `crypto.timingSafeEqual`. Return `false` without throwing when the received header contains non-hex characters or when buffer lengths differ.
- R10. Harden the OAuth flow end-to-end:
  - Add a CSRF `state` parameter to the authorize URL. Store server-side with a 10-minute TTL; verify and consume (delete-on-read) in the callback. Reject callbacks with missing, expired, or mismatched state.
  - Reject valid-state callbacks when a token is already stored (`currentToken !== null`) to prevent workspace-swap hijack via callback replay. The deployer must restart the server to re-authorize a different workspace.
  - Require a `BASE_URL` env var and derive `redirect_uri` from it. Do not construct `redirect_uri` from the `Host` or `X-Forwarded-Proto` headers. The current `getBaseUrl` behavior (`src/oauth.ts:120–123`) is an open-redirect surface if the container port is reachable outside the proxy — several supported PaaS expose this by default. `BASE_URL` must be an absolute URL; non-localhost values must use `https://`. Fail fast at server startup with a clear error if `BASE_URL` is missing, non-absolute, or HTTP outside localhost.
- R11. Do not echo raw token-exchange error bodies in HTTP responses. Log server-side; return a generic 500 message.
- R12. Remove the dead `tokens` Map from `src/oauth.ts`. Single-workspace in-memory token storage (`currentToken`) stays as documented scope.

## Success Criteria

- A user assigning an issue to the agent sees, within 10 seconds, an agent activity in the Linear session sidebar (not in the comment thread) indicating the agent is working.
- The Linear session has a clickable external link to `claude.ai/code/<session>` via `externalUrls`, not just a link buried in a comment body.
- A user replying in the Linear session thread triggers a new Claude Routine with the accumulated conversation context, and the new session URL appears as a new `action` activity in the sidebar.
- On Routines failure, the user sees a generic `error` activity inline in the Linear sidebar — not a plain comment, not silent failure, not raw upstream API error text.
- OAuth: `/oauth/callback` rejects missing/expired/mismatched state, rejects duplicate installs while a token is stored, and the `redirect_uri` cannot be manipulated via request headers. Webhook HMAC is timing-safe and hex-decode-safe.
- Linear sessions remain in `active` state after the action activity until Linear's stale-after-N timeout or user reassignment (pending Deferred question 2 — if Linear allows `prompted` on `complete`-state sessions, R3 will instead close with a `response` activity).

## Scope Boundaries

- **Not** migrating to Claude Managed Agents in v1. Completion sync, status polling, SSE, follow-ups into an existing session, and cancel stay unavailable. Revisit in v1.1+ if adoption feedback or API changes warrant it.
- **Not** emitting a heartbeat `thought` activity during the silent window after fire. Accepted for v1 in favor of minimum complexity; revisit in v1.1 based on user feedback about whether silence feels broken.
- **Not** implementing cooldown, debouncing, cost caps, or confirmation for follow-up Routine fires. Cost and silent-truncation risks are documented in R8 callouts; no code-level protection. Revisit in v1.1.
- **Not** implementing any completion callback from Claude → Linear. The "prompt the Routine to call back via MCP connector" workaround is explicitly rejected — too fragile for the value.
- **Not** persisting OAuth tokens or CSRF state. Both stay in-memory. Multi-workspace support stays out.
- **Not** handling multi-workspace collision beyond R10's reject-on-existing-token policy. Scope is single-workspace, single-deployment, single-install.
- **Not** using Linear's `elicitation` activity type. Adds friction to every interaction with no net product value for this scope.
- **Not** emitting a `response` activity to close the Linear session. Whether Linear allows `prompted` events on a `complete`-state session is unverified (see Deferred question 2); if not, keeping sessions `active` preserves follow-up capability.
- **Not** implementing session cancel / stop from Linear. Routines has no cancel endpoint.
- **Not** displaying plan items (`agentSessionUpdate.plan`). Fire-and-forget makes any multi-step plan display misleading.

## Key Decisions

- **Keep Routines as the backend in v1.** Managed Agents would close the completion loop and support follow-ups natively, but requires rebuilding the agent configuration (model, system prompt, repos, MCP connectors) that Routines provides as a reusable saved unit. V1 accepts Routines' known UX costs (silence after fire, no cost protection, quadratic context growth, silent 65k truncation) in exchange for reusing that config and shipping in days. R1–R5 are reusable under a future Managed Agents migration; the cost of choosing Routines now is mostly in user-visible UX, not throwaway code.
- **Rename to `linear-routines-bridge`.** Signals the architecture honestly: a bridge to Routines specifically, not a self-contained agent. Accepted tradeoff: a future Managed Agents migration makes the name wrong and forces a second rename. For a pre-release project with near-zero reputation capital, the current-accuracy win outweighs the future-rename cost.
- **Fire a fresh Routine on every user reply.** Routines cannot accept follow-up messages into an existing session. Accumulated-context refire is the only path that re-engages Claude.
- **No runaway protection in code.** Deployer trust plus explicit README warnings (R8 callout 2). Accepts surprise cost and silent 65k truncation as v1 failure modes. Revisit in v1.1 if real adoption signal shows this is a recurring complaint.
- **Structured `error` activity on failure, not `createComment`.** Consistency with the agent-native rendering story. Error bodies are generic to avoid leaking upstream API info visible to all workspace members.
- **Full OAuth hardening in v1, despite "minimum complexity" framing.** State TTL, reinstall rejection, and `BASE_URL`-derived `redirect_uri` all land in scope because the alternative is an exploitable public HTTP surface, and R8 explicitly tells deployers to host on PaaS (untrusted networks by default).

## Dependencies / Assumptions

- `@linear/sdk` v82.x exposes `createAgentActivity` and `agentSessionUpdate` as typed methods, and the v39 → v82 upgrade does not break the OAuth and `organization` lookups already in `src/oauth.ts`. The 18-month jump could shift ESM/CJS export shape, Node minimum, `LinearClient` constructor signature, or the `organization` accessor pattern (`src/oauth.ts:97`). **First implementation action**: spike `npm install @linear/sdk@^82 && tsc --noEmit` on a throwaway branch and resolve any breakage before committing to the rest of R1–R5.
- `AgentSessionEvent` payloads with `action: "prompted"` include the user's reply text in a field accessible server-side, per the Linear agent-interaction docs. Whether the payload also carries full thread history — or the bridge must accumulate replies in memory keyed by session ID — is not confirmed (see Resolve Before Planning).
- Claude Routines `/fire` continues to accept the existing `{text}` payload shape under the `experimental-cc-routine-2026-04-01` beta header for the foreseeable future. Any API churn is accepted as inherent risk of a beta endpoint.
- Linear's Agent Interaction API was developer preview at July 2025 launch and reached public launch in March 2026. Schema or behavior changes post-GA could break R1–R5; this risk is accepted without a code-level kill-switch plan. Pin `@linear/sdk` exactly rather than floating it.
- The deployer has already configured a Claude Routine at claude.ai/code/routines with repo and prompt-template set. This repo is the trigger, not the Routine config.

## Outstanding Questions

### Resolve Before Planning

- [Affects R5][Needs research] Does the `prompted` webhook payload contain the full session thread (all prior user replies on this session), or must the bridge accumulate replies in memory keyed by session ID? The latter introduces a new persistence surface (a `sessions` Map) that is not currently in scope anywhere in this doc and would break the "in-memory only for OAuth tokens" boundary. Verify by triggering a `prompted` event in a real Linear workspace and inspecting the payload before planning commits R5. **Fallback if payload lacks full history:** R5 is deferred to v1.1 and the bridge handles `prompted` events with an `error` activity ("follow-ups require v1.1; reassign the issue to continue"). A `sessions` Map does not enter v1 scope.

### Deferred to Planning

- [Affects R5][Technical] Accumulated-context assembly format. Default proposal: original issue body first, then replies oldest-first, each wrapped in `<user_reply author="…" at="…">…</user_reply>` delimiters for prompt-injection mitigation. If total exceeds the 65k-char `text` cap, drop oldest replies first while preserving the issue body. Planning should confirm, override, and decide whether a trim event warrants its own `thought` activity so the user knows context was dropped.
- [Affects R3, R5][Needs research] Does Linear allow `prompted` events on a session whose last activity was `response` (state = `complete`)? Test in the first 10 minutes of planning. If yes, R3 can end with a `response` activity to cleanly close each fire while preserving follow-up capability; if no, sessions stay `active` as currently scoped and R3 stops at `action`.

## Next Steps

-> `/ce:plan` for structured implementation planning
