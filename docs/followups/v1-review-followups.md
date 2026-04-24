---
title: "v1 code-review follow-ups"
source: ce:review pass — run 20260424-104308-ae45a39b
date: 2026-04-24
status: open
---

# v1 code-review follow-ups

This document tracks all 39 findings from the v1 ce:review pass against `brainstorm/v1-requirements`. Findings applied in the same commit cycle are marked **[Fixed]**; everything else is **[Deferred]** for a follow-up pass (v1.1 or before a public push).

Per-reviewer artifacts with full detail (evidence, why_it_matters, suggested_fix) are at `.context/compound-engineering/ce-review/20260424-104308-ae45a39b/` (gitignored by convention).

## Discarded false positive

- **README Limitation 2 omits 65k silent truncation** (project-standards) — the plan's original framing of "quadratic context growth hits the 65k text cap around 15-25 replies" no longer applies because Gate A resolved that `prompted` payloads carry no thread history. Each fire carries constant-size context. Commit `6465fee` explains the rewording. **Not a finding.**

---

## P1 — High

### [Fixed] #1 — XML injection via missing nonce + unescaped fields in `processPromptedSession`

- File: `src/webhook.ts` (processPromptedSession, routineText assembly)
- Flagged by: correctness (0.97), security (0.95), adversarial (0.95), project-standards (0.92), testing (0.80), kieran-typescript
- Fix applied: generate per-fire nonce `randomBytes(4).toString("hex")`, use `<user_reply_<nonce>>` wrapper, HTML-entity-escape all user-controlled fields (issueIdentifier, issueTitle, issueDescription, replyAuthor, replyAt, replyBody) before interpolation.
- Rationale: matches plan R5 specification. Defence in depth: nonce prevents literal-tag injection; escape prevents attribute-level tampering.

### [Fixed] #2 — OAuth token-exchange fetch has no timeout

- File: `src/oauth.ts` (handleCallback, line ~180)
- Flagged by: reliability (0.95)
- Fix applied: `signal: AbortSignal.timeout(10_000)` on the fetch to `https://api.linear.app/oauth/token`.

### [Fixed] #3 — Routines `/fire` fetch has no timeout

- File: `src/claude.ts` (triggerRoutine, line ~33)
- Flagged by: reliability (0.92)
- Fix applied: `signal: AbortSignal.timeout(60_000)` on the fetch. A stalled Anthropic endpoint would otherwise leave the Linear session showing only a thought, indefinitely.

### [Fixed] #4 — `JSON.parse(rawBody)` unwrapped after HMAC verify

- File: `src/webhook.ts:handleWebhook` (line ~91)
- Flagged by: reliability (0.90)
- Fix applied: wrap in try/catch; return 400 on parse failure (not 200 — 200 falsely confirms delivery to Linear).

### [Fixed] #5 — `package.json` missing `"license": "MIT"` field

- File: `package.json`
- Flagged by: project-standards (0.95)
- Fix applied: add `"license": "MIT"`. The LICENSE file exists; the field is required for `npm publish` and for consumers that read metadata.

### [Deferred] #6 — `verifyWebhookSignature` has no unit tests

- File: `src/webhook.ts`
- Flagged by: testing (0.92)
- Route: manual (v1.1). Plan explicitly defers test framework to v1.1. Node 20's built-in `node:test` runner can host a ~30-line harness covering the six scenarios the plan enumerated. **Target: v1.1.**

### [Deferred] #7 — `assertValidBaseUrl` has no unit tests

- File: `src/oauth.ts`
- Flagged by: testing (0.85)
- Route: manual (v1.1). Pure function with eight plan-enumerated scenarios; bundle with #6 into a single test file. **Target: v1.1.**

### [Deferred] #8 — OAuth installation is browser-gated; no programmatic / static-token path

- File: `src/oauth.ts:113-134`, `README.md`
- Flagged by: agent-native (0.85)
- Route: manual (design decision). Every cold-start without `DEV_PERSIST_TOKEN` requires a human. Options: document the limitation explicitly; add a `LINEAR_STATIC_TOKEN` env-var bypass for IaC operators. **Target: v1.1 or explicit README callout.**

### [Deferred] #9 — Claude Routine assembly is browser-UI-only (no Anthropic API for Routine provisioning)

- File: `README.md` (Step 2)
- Flagged by: agent-native (0.85)
- Route: manual. README presents Routine setup as a mechanical step; it isn't. Add as a 5th limitation callout. **Target: v1.1 documentation pass.**

---

## P2 — Moderate

### [Deferred] #10 — `fireAndRespond` post-thought SDK calls have no try/catch

- File: `src/webhook.ts:fireAndRespond`
- Flagged by: correctness (0.90), reliability (0.88), adversarial (0.88)
- Route: gated_auto. A transient Linear API failure after the thought activity leaves the session visually abandoned. Fix: wrap `action` / `agentSessionUpdateExternalUrl` / `response` in try/catch; on failure, attempt a generic error activity (itself try-wrapped).

### [Deferred] #11 — No webhook idempotency / delivery-ID dedup

- File: `src/webhook.ts:handleWebhook`
- Flagged by: reliability (0.82), adversarial (0.90)
- Route: manual (v1.1). Linear retries on network hiccup → double fire, double Anthropic charge, duplicate Linear activities. `webhookId` is in the payload, unused. Needs a bounded LRU cache keyed on webhookId. **Target: v1.1.**

### [Deferred] #12 — State store unbounded (DoS surface)

- File: `src/oauth.ts:handleAuthorize`
- Flagged by: adversarial (0.92)
- Route: safe_auto. `sweepExpiredState` is only invoked inside `handleCallback`. Attacker hitting `/oauth/authorize` in a loop grows the Map without bound. Fix: call `sweepExpiredState(now)` at top of `handleAuthorize`; enforce a hard size cap (e.g., 1024 entries).

### [Deferred] #13 — Anthropic error bodies (potentially account/quota info) logged verbatim

- File: `src/claude.ts:47-52`
- Flagged by: security (0.90)
- Route: safe_auto. Log only status code + first 200 chars of body. Keeps UI-facing R4 protection but also prevents server logs from carrying account-bearing content into log aggregators.

### [Deferred] #14 — `DEV_PERSIST_TOKEN=1` has no runtime guard against production use

- File: `src/oauth.ts:15-43`
- Flagged by: security (0.82)
- Route: gated_auto. Startup hard-fail when `DEV_PERSIST_TOKEN=1` AND BASE_URL is non-local (not localhost/127.0.0.1/::1). Converts the README warning into an enforced runtime guard.

### [Deferred] #15 — Hex regex accepts odd-length strings

- File: `src/webhook.ts:61-65`
- Flagged by: security (0.80)
- Route: safe_auto. Change `/^[0-9a-f]+$/i` to `/^[0-9a-f]{64}$/i` so the regex enforces the SHA-256 length invariant independently of the post-decode byte-length check.

### [Deferred] #16 — Boundary `as Record<string, unknown>` casts are assertions, not narrowings

- File: `src/webhook.ts:processNewSession`, `processPromptedSession`; `src/oauth.ts:handleCallback` (token response)
- Flagged by: kieran-typescript (0.88)
- Route: gated_auto / manual. Add `AgentSessionPayload` / `LinearTokenResponse` types + runtime guards at boundaries. Replace the empirical comment block at top of `webhook.ts` with types the compiler enforces. **Candidate for v1.1 refactor.**

### [Deferred] #17 — No `process.on('unhandledRejection')` handler

- File: `src/index.ts`
- Flagged by: reliability (0.85)
- Route: safe_auto. Sync throws before first await in processor functions crash Node 15+. Add a top-level handler that logs + keeps the server alive (`process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err))`).

### [Deferred] #18 — `prompted` continuity silently depends on Linear MCP connector

- File: `README.md`, `src/webhook.ts` (processPromptedSession comment)
- Flagged by: agent-native (0.80)
- Route: safe_auto (README note). If the Routine lacks the Linear MCP connector, follow-ups are context-starved silently. Add to README setup and to an inline comment in processPromptedSession.

### [Deferred] #19 — CSRF state TTL expiry + delete-on-read replay-prevention untested

- File: `src/oauth.ts:stateStore`
- Flagged by: testing (0.82)
- Route: manual. Pair with #6/#7 — export `sweepExpiredState` or populate stateStore directly. **Target: v1.1.**

### [Deferred] #20 — Agent-to-agent entry path undocumented

- File: `README.md`
- Flagged by: agent-native (0.80)
- Route: safe_auto (README). Add a subsection documenting that an external system triggers this bridge only by assigning a Linear issue to the agent (via Linear's `issueUpdate` GraphQL). HMAC gate means POST /webhook is reserved for Linear.

---

## P3 — Low

### [Deferred] #21 — `handleCallback` 409 path doesn't consume CSRF state

- File: `src/oauth.ts:handleCallback` (~line 145)
- Flagged by: correctness (0.85)
- Route: safe_auto. Diverges from the documented delete-on-read invariant. Fix: read and delete state before returning 409.

### [Deferred] #22 — Thought SDK failure silently misses R2 10s ack

- File: `src/webhook.ts:fireAndRespond`
- Route: merged into #10 — same try/catch wrapping covers this.

### [Deferred] #23 — `payload.data` fallback is a dead branch

- File: `src/webhook.ts:processNewSession`
- Flagged by: maintainability (0.82)
- Route: safe_auto. Confirmed-shape header comment makes the fallback cruft. Remove it.

### [Deferred] #24 — `issueId` in `processNewSession` is vestigial

- File: `src/webhook.ts:processNewSession`
- Flagged by: maintainability (0.88)
- Route: safe_auto. Extracted, used only in one log string. Delete or keep as inline log read.

### [Deferred] #25 — `RoutineResult.sessionId` is unused

- File: `src/claude.ts`
- Flagged by: maintainability (0.90)
- Route: safe_auto. Remove from return type.

### [Deferred] #26 — `DEBUG_PAYLOAD=1` has no runtime guard against production use

- File: `src/webhook.ts:96-104`
- Flagged by: security (0.85)
- Route: gated_auto. Symmetric to #14 — startup warn (or exit) when `DEBUG_PAYLOAD=1` AND BASE_URL is non-local.

### [Deferred] #27 — OAuth callback race on `currentToken !== null` check

- File: `src/oauth.ts:handleCallback`
- Flagged by: security (0.72)
- Route: gated_auto. Use a sentinel value ('pending') to make the null-check atomic across concurrent callbacks. Narrow timing window, benign in normal flow.

### [Deferred] #28 — No SIGTERM handler (graceful shutdown)

- File: `src/index.ts`
- Flagged by: reliability (0.80)
- Route: gated_auto. PaaS rolling deploys kill mid-`fireAndRespond`. Counter + drain-wait pattern bounds exposure.

### [Deferred] #29 — `assertValidBaseUrl` returns raw input, not `parsed.href`

- File: `src/oauth.ts:assertValidBaseUrl`
- Flagged by: adversarial (0.85)
- Route: safe_auto. `BASE_URL=https://host#debug` passes validation but produces malformed redirect URI. Return `parsed.href.replace(/\/+$/, '')` to normalize.

### [Deferred] #30 — Health check doesn't expose token-installed state

- File: `src/index.ts:29-35`
- Flagged by: agent-native (0.75)
- Route: safe_auto. Add `tokenInstalled: boolean` (not the token value) to health response so deployment monitors can distinguish installed from not.

### [Deferred] #31 — Limitation 1 in README framed only for human users

- File: `README.md`
- Flagged by: agent-native (0.70)
- Route: safe_auto. Extend to cover programmatic callers who have no reliable completion signal either.

### [Deferred] #32 — `package.json` has no `repository` field

- File: `package.json`
- Flagged by: project-standards (0.80)
- Route: safe_auto. Add `"repository": { "type": "git", "url": "<github-url>" }`.

### [Deferred] #33 — `promptContext` secondary fallback is undocumented + silent

- File: `src/webhook.ts:processNewSession`
- Flagged by: maintainability (0.75)
- Route: safe_auto. Add a `console.warn` when falling back to `agentSession.promptContext` so unexpected shapes don't produce silent "No context provided" fires.

### [Advisory] #34 — `tsconfig.json` lacks `noUncheckedIndexedAccess`

- Flagged by: kieran-typescript (0.70)
- Route: advisory. Low current impact (codebase uses `Map.get`). Consider enabling for public release.

### [Advisory] #35 — Handler return types are implicit

- Flagged by: kieran-typescript (0.68)
- Route: advisory. Not a current bug. Explicit return types would catch future-forgotten-return regressions.

### [Advisory] #36 — `createAgentActivity` content shapes untyped (SDK JSONObject)

- Flagged by: kieran-typescript (0.72)
- Route: advisory. Local discriminated union at the boundary ~10 lines.

### [Advisory] #37 — `webhook.ts` header comment block mixes stable reference with dated investigation notes

- Flagged by: maintainability (0.68)
- Route: advisory. Will read ambiguously in 6 months.

### [Advisory] #38 — `assertValidBaseUrl` / `setBaseUrl` / `requireBaseUrl` / `baseUrl` four-step pattern

- Flagged by: maintainability (0.70)
- Route: advisory. Could collapse to a single `initBaseUrl()` at the cost of losing the "mandatory sequencing" signal.

### [Advisory] #39 — `fireAndRespond` extraction value debatable

- Flagged by: maintainability (0.65)
- Route: advisory. 2 callers; judgment call between extract vs inline.

---

## Suggested fix order (for v1.1 or pre-push polish)

1. **Ship blockers:** #1–#5 (already applied, this commit cycle).
2. **Pre-push hardening batch** (low risk, behavior-positive): #10, #12, #13, #15, #17, #23, #24, #25, #29 — can all land in a single follow-up commit.
3. **Production guardrails:** #14, #26 (env-flag prod detection), #28 (SIGTERM).
4. **Observability + docs:** #18, #20, #30, #31, #32, #33.
5. **v1.1 test framework:** #6, #7, #19 bundled.
6. **v1.1 design questions:** #8, #9, #11, #16 — each needs a decision before implementation.
7. **Advisory (pick at leisure):** #34–#39.
