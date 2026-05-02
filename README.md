# linear-claude-bridge

## What it does

Bridges [Linear](https://linear.app) and [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/quickstart) Sessions.

Assign a Linear issue to Claude, and this bridge spins up a managed agent session with the issue context. The session persists across replies — when you reply in the Linear thread, the bridge feeds your message back into the **same** Claude session, with full conversation history. When the session goes idle, Claude's final response is posted as a `response` activity in the Linear agent sidebar.

I built this because I wanted to hand off Linear tickets to Claude without leaving Linear or copy-pasting context.

## How a hand-off looks

1. You assign a Linear issue to the agent user.
2. The bridge creates a Managed Agents session bound to your pre-configured agent + environment.
3. The bridge sends the issue context (title, description, prior thread) to Claude as the first user message.
4. Claude works inside its managed cloud container. The bridge consumes the session's event stream but does **not** relay intermediate agent messages to Linear — the sidebar stays quiet during the turn.
5. When the session goes idle (`stop_reason: end_turn`), the bridge posts Claude's full final response as one `response` activity in the Linear sidebar.
6. If you reply in the Linear agent thread, the bridge **resumes the same Claude session** with your reply — Claude already has the full prior history.

## Why Sessions API instead of Routines

Earlier versions of this bridge fired pre-configured [Claude Code Routines](https://claude.ai/code/routines) for each interaction. Routines is fire-and-forget: every Linear reply spawned a fresh Claude session that had to re-read prior context, and there was no way to know when Claude was finished.

Switching to the Managed Agents [Sessions API](https://platform.claude.com/docs/en/managed-agents/sessions) fixes both:

- Sessions persist by ID. Replies feed into the same conversation. No re-reading prior context.
- `session.status_idle` is a real completion signal. The bridge posts Claude's final answer back to Linear when the turn ends.
- The bridge holds **zero per-session state**. The Claude session ID is stored on the Linear agent session itself (in `externalUrls`) and read back on follow-ups, so the bridge survives restarts mid-conversation.

## Setup

Five steps: register a Linear OAuth app, get an Anthropic API key, create the agent and environment via the Anthropic API, then fill in `.env` and run.

### 1. Create a Linear OAuth app

Go to [linear.app/settings/api/applications](https://linear.app/settings/api/applications) → **Create new**.

- **Actor:** `App user` (this creates a dedicated agent user — don't pick "User")
- **Scopes:** `read`, `write`, `app:assignable`
- **Redirect URI:** `<BASE_URL>/oauth/callback`
- **Webhook URL:** `<BASE_URL>/webhook`
- **Webhook events:** check `Agent session events`

Copy the `Client ID`, `Client secret`, and `Webhook signing secret`.

### 2. Get an Anthropic API key

Create one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). The key needs Managed Agents access (the `managed-agents-2026-04-01` beta).

### 3. Create the agent and environment

Run these one-shot curls (substitute `$ANTHROPIC_API_KEY`):

```sh
# Agent — defines model, system prompt, tools, MCP servers
curl -X POST https://api.anthropic.com/v1/agents \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "name": "linear-bridge",
    "model": "claude-opus-4-7",
    "system": "You were invoked from a Linear issue. Keep your own session output focused on the work; the user is reading your final response in the Linear agent sidebar.",
    "tools": [{"type": "agent_toolset_20260401"}]
  }'

# Environment — defines the cloud container Claude runs inside
curl -X POST https://api.anthropic.com/v1/environments \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "name": "linear-bridge",
    "config": { "type": "cloud", "networking": {"type": "unrestricted"} }
  }'
```

Copy the returned `id` from each — they look like `agent_…` and `env_…`.

If you want Claude to operate on a GitHub repo, attach an MCP server (e.g. the GitHub MCP) at the agent level when you create it, or update the agent later to add it. See the [agent setup docs](https://platform.claude.com/docs/en/managed-agents/agent-setup).

### 4. Configure `.env`

```sh
cp .env.example .env
```

Fill in:

| Variable | What it is |
|----------|------------|
| `LINEAR_CLIENT_ID` | From your Linear OAuth app |
| `LINEAR_CLIENT_SECRET` | From your Linear OAuth app |
| `LINEAR_WEBHOOK_SECRET` | The webhook signing secret from Linear |
| `ANTHROPIC_API_KEY` | Anthropic API key with Managed Agents access |
| `CLAUDE_AGENT_ID` | The `agent_…` ID from step 3 |
| `CLAUDE_ENVIRONMENT_ID` | The `env_…` ID from step 3 |
| `BASE_URL` | Public HTTPS URL where this bridge is reachable |

### 5. Run it

```sh
npm install
npm run dev
```

Then visit `<BASE_URL>/oauth/authorize` once and approve the app. You should see `Installed for workspace: <name>` in the server logs.

### 6. Try it

Assign any issue to the agent user in Linear. Within a few seconds you should see a thought activity appear in the Linear issue's agent sidebar, then a response activity once Claude finishes.

## Running it on a public URL

Linear needs to reach the bridge over HTTPS. Pick one:

**Local + cloudflared** (easiest for testing, no signup):

```sh
brew install cloudflared
cloudflared tunnel --url http://localhost:3001
```

Use the printed `https://...trycloudflare.com` URL as `BASE_URL`.

**Local + ngrok** (also fine):

```sh
brew install ngrok
ngrok config add-authtoken <your-token>
ngrok http 3001
```

**A hosting platform** (Fly, Railway, Render, etc.): set the env vars as secrets, and use the platform's HTTPS URL as `BASE_URL`. There's no database or queue — just the one Node process.

**Kubernetes via Helm** (`charts/linear-claude-bridge/`):

CI publishes a multi-arch image to `ghcr.io/northisup/linear-claude-bridge` on every push to `main` (tags: `latest`, `sha-<short>`, and the SemVer pieces on `v*` tags). Pull it directly, or build your own from the `Dockerfile`.

```sh
# Optional: build and push your own image instead of using the published one.
# docker build -t ghcr.io/<you>/linear-claude-bridge:0.2.0 .
# docker push ghcr.io/<you>/linear-claude-bridge:0.2.0

# Install. Either set secrets inline or point at an externally-managed Secret.
helm install linear-bridge charts/linear-claude-bridge \
  --set image.repository=ghcr.io/northisup/linear-claude-bridge \
  --set image.tag=latest \
  --set baseUrl=https://bridge.example.com \
  --set claude.agentId=agent_… \
  --set claude.environmentId=env_… \
  --set secrets.linearClientId=<…> \
  --set secrets.linearClientSecret=<…> \
  --set secrets.linearWebhookSecret=<…> \
  --set secrets.anthropicApiKey=<…> \
  --set ingress.enabled=true \
  --set ingress.host=bridge.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=bridge-tls
```

For production, pin to a `sha-<short>` tag instead of `latest` so rollbacks and rolling updates are deterministic.

The chart pins to `replicas: 1` with a `Recreate` strategy — the bridge holds the Linear OAuth token in process memory and cannot be scaled horizontally. Per-Linear-session state is stored on Linear (in agent session `externalUrls`), so the bridge survives restarts mid-conversation, but the OAuth install must be re-done after every pod replacement (visit `<baseUrl>/oauth/authorize` again). See `charts/linear-claude-bridge/values.yaml` for the full set of knobs (resources, probes, security context, existingSecret, etc.).

> Heads up: free-tier tunnel URLs change when you restart them. If the URL changes, update both `BASE_URL` in `.env` **and** the Redirect URI + Webhook URL in your Linear app settings.

## Gotchas (worth knowing before you use it heavily)

**1. No live progress visibility.**
The Sessions API doesn't return a browser-facing session URL today, so there's no link to click and watch Claude work in real time. The bridge also doesn't relay intermediate `agent.message` events to Linear in v1 — the sidebar shows a `thought` when the turn starts, then stays quiet until Claude is done, then posts a single `response` activity with the final answer. The synthetic `https://platform.claude.com/sessions/<id>` URL stored on the Linear session is for ID round-tripping only; it may not render a viewer.

**2. Long-running turns hold an SSE stream open.**
The bridge keeps the session's stream open until `session.status_idle`. There's a 30-minute hard timeout per turn. A flood of concurrent issues could pile up open streams in the single Node process — this bridge is sized for one human user, not a team-wide deployment.

**3. Restarts wipe the OAuth token.**
The Linear access token lives in memory. If the server restarts, you have to visit `/oauth/authorize` again. Per-session state is **not** affected: Claude session IDs are stored on Linear, not in the bridge. For local dev, set `DEV_PERSIST_TOKEN=1` to cache the token in a gitignored file.

**4. Protect the webhook secret.**
Anyone with `LINEAR_WEBHOOK_SECRET` can fake Linear events and burn your Anthropic credits. Treat it like the Anthropic API key.

**5. Tool confirmation isn't supported.**
If your agent uses tools with `permission_policy: always_ask`, the session will hang at `session.status_idle` with `stop_reason: requires_action` and the bridge won't auto-confirm. Configure your agent with `always_allow` for v1 use.

## Contributing

Upfront: I'm an amateur developer. This project works for me but it's very likely to have bugs, rough edges, and things a more experienced engineer would do differently. If you spot something broken or see a better way to do it, please open an issue or PR — I'd genuinely welcome the feedback.

### Dev setup

```sh
git clone <this-repo>
cd claude-linear-agent
npm install
cp .env.example .env
# fill in the seven values from the Setup section above
npm run dev
```

`npm run dev` uses `tsx watch` so it reloads on file changes. In another terminal, start a tunnel so Linear can reach your local server:

```sh
cloudflared tunnel --url http://localhost:3001
```

Paste the `https://...trycloudflare.com` URL into `BASE_URL` in `.env`, and into the Redirect URI and Webhook URL fields in your Linear app settings. Then visit `<BASE_URL>/oauth/authorize` once to install.

From there, assigning a Linear issue to the agent user should trigger the whole flow end-to-end.

### Useful dev env vars

- `DEV_PERSIST_TOKEN=1` — caches the OAuth token to `.token-dev.json` so `tsx watch` reloads don't wipe it. Local only.
- `DEBUG_PAYLOAD=1` — logs the first 6 KB of each Linear webhook payload. Handy for figuring out what Linear is actually sending.

### Releases

Releases are version-driven. To cut one:

1. Bump `version` in `package.json` **and** `appVersion` in `charts/linear-claude-bridge/Chart.yaml` to the same value (e.g. both to `0.3.0`). The chart's image-tag default is `appVersion`, so they have to stay in lockstep — `release.yml` will refuse to tag if they don't match.
2. Commit and push to `main`.
3. `release.yml` fires on the `package.json` change, type-checks the build, then creates an annotated `v<version>` tag and a GitHub Release with auto-generated notes.
4. The tag push triggers `docker.yml`'s SemVer rule, which publishes `ghcr.io/northisup/linear-claude-bridge:<version>` and `:<major>.<minor>` alongside the existing `latest` and `sha-<short>` tags.

If a release fails halfway (e.g. the build verification step), nothing is tagged — fix the issue, push another commit (or re-run with `workflow_dispatch`), and it picks up where it left off.

## License

MIT. See [LICENSE](LICENSE).
