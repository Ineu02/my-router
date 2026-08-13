# LLM Router

Self-hosted, OpenAI-compatible LLM routing gateway with health-aware failover,
multi-account rotation, a live dashboard, and optional ChatGPT/Codex OAuth.

One endpoint (`/v1/chat/completions`) fans out across many providers and
accounts, tracks per-credential health, and fails over automatically. A web
dashboard shows topology, health, and logs, and lets you connect accounts.

- **API**: OpenAI-compatible `/v1` (drop-in `base_url`).
- **Providers**: OpenAI, Anthropic, Gemini, xAI, OpenRouter, Qwen, GLM, custom
  OpenAI-compatible endpoints, plus a built-in **mock upstream** for free E2E
  testing.
- **Dashboard**: health topology, request logs, admin controls, Connections.
- **Storage**: SQLite (native `better-sqlite3`); migrations run on first boot.

---

## VPS One-Command Installation

Fresh **Ubuntu/Debian** server. Installs Node.js, builds the API + dashboard,
generates strong secrets, and runs everything as a persistent `systemd` service
that restarts on failure and on reboot.

```bash
curl -fsSL https://raw.githubusercontent.com/Ineu02/my-router/main/install.sh | sudo bash
```

Private repo? Provide a token (never stored on disk after cloning):

```bash
curl -fsSL https://raw.githubusercontent.com/Ineu02/my-router/main/install.sh | sudo GITHUB_TOKEN=ghp_xxx bash
```

From an existing checkout:

```bash
sudo ./install.sh
```

Tunables (export before running): `REPO_URL`, `REPO_REF`, `INSTALL_DIR`
(default `/opt/llm-router`), `SERVICE_USER` (default `llmrouter`),
`ROUTER_PORT` (default `20128`), `GITHUB_TOKEN`.

<!-- APPEND_README -->
### What the installer does

1. Detects Ubuntu/Debian; installs `git`, `build-essential`, `python3`,
   `openssl`, and **Node.js 20.x** (NodeSource) if missing (enables `pnpm` via
   corepack for parity; the build itself uses `npm ci`).
2. Creates a locked-down system user (`llmrouter`, no login shell).
3. Clones/updates the repo into `/opt/llm-router`.
4. `npm ci` → builds the **API** (`npm run build`) and the **dashboard**
   (`npm run build --workspace=@router/web`).
5. Writes a production `.env` from `.env.example` and **auto-generates**
   `ROUTER_API_KEY`, `ADMIN_TOKEN`, `SESSION_SECRET`, `CREDENTIAL_ENC_KEY`
   (`chmod 600`; never committed — `.env` is git-ignored).
6. Sets `NODE_ENV=production`, `ROUTER_HOST=0.0.0.0`, `SERVE_WEB=true`, and a
   production `CORS_ORIGINS` (your server IP + port).
7. Creates `data/` for SQLite (migrations run automatically on first boot).
8. Installs + enables a `systemd` service (`Restart=on-failure`,
   `WantedBy=multi-user.target` → starts on reboot) and health-checks it.
9. Installs the `llm-router` management command.

### Ports

| Port | Purpose | Exposure |
|------|---------|----------|
| **20128** (`ROUTER_PORT`) | API **and** dashboard (single origin) | public — open in your firewall/security group |
| 20129 | mock upstream | localhost-only (testing; off in production) |
| 1455 | Codex OAuth loopback callback | localhost-only (see OAuth note) |

Only **20128** needs to be reachable from the internet. The installer opens it
in `ufw` automatically when `ufw` is active.

### Accessing the dashboard

Open `http://<your-server-ip>:20128/` and log in with the **admin token**:

```bash
grep ^ADMIN_TOKEN= /opt/llm-router/.env
```

The API base URL for your clients is `http://<your-server-ip>:20128/v1`, using
the generated client key as `Authorization: Bearer sk-router-…`:

```bash
llm-router key      # prints the bootstrap ROUTER_API_KEY
```

> **HTTPS:** the admin login is a cookie session. On a public server, front port
> 20128 with a TLS reverse proxy (Caddy or nginx) and use `https://` so the
> cookie is never sent in the clear. The router logs a warning when it detects a
> public bind without TLS.

### Adding provider API keys

Providers are enabled by presence of their key. Edit `.env` and restart:

```bash
llm-router config      # opens /opt/llm-router/.env in $EDITOR
# set e.g.  OPENAI_API_KEY=sk-...   ANTHROPIC_API_KEY=sk-ant-...
# add more accounts with _2 / _3 suffixes:  OPENAI_API_KEY_2=...
llm-router restart
```

Keys are read **server-side only** — they are never returned by any API
response or shown in the dashboard. **Disable the mock** for production by
setting `ENABLE_MOCK_PROVIDER=false` and restarting.

### Connecting ChatGPT / Codex (OAuth)

The router can connect a ChatGPT account via the sanctioned OpenAI
Authorization-Code + PKCE flow instead of an API key; tokens are stored
**encrypted at rest** and refreshed automatically.

```bash
llm-router config      # set CODEX_OAUTH_ENABLED=true
llm-router restart
```

Then open the dashboard → **Registry → Connections → Connect ChatGPT**.

> **VPS caveat:** the OAuth callback is a **loopback** URL
> (`http://localhost:1455/auth/callback`), designed for the browser and router
> to be on the same machine. On a headless VPS, complete the login from your
> laptop with an SSH tunnel so the callback reaches the server:
> `ssh -L 1455:localhost:1455 user@server`, then run the Connect flow in your
> local browser. Full remote/headless OAuth is a documented follow-up.

### Management commands

```bash
llm-router status      # systemd status
llm-router logs        # recent logs (add -n N)
llm-router follow      # stream logs live
llm-router restart     # restart the service
llm-router start|stop  # control the service
llm-router health      # hit /api/health locally
llm-router key         # print the bootstrap ROUTER_API_KEY
llm-router config      # edit .env, then restart to apply
llm-router update      # git pull + rebuild + restart
llm-router uninstall   # stop & remove the service (keeps data/ and .env)
```

<!-- APPEND_README_2 -->
---

## Local development

```bash
npm install
cp .env.example .env          # ENABLE_MOCK_PROVIDER=true by default (free E2E)
npm run dev                   # API on http://127.0.0.1:20128
npm run dev:web               # dashboard (Vite) on http://localhost:3000
```

Everything works with **no real provider keys** thanks to the mock upstream.

### Verify

```bash
npm run typecheck                         # tsc -b across workspaces
npm run lint                              # eslint, zero warnings
npm test                                  # vitest suite
npm run build                             # build API
npm run build --workspace=@router/web     # build dashboard
```

### Single-origin serving (what production uses)

Set `SERVE_WEB=true` and build the dashboard; the API then serves the compiled
UI from its own origin, so one port exposes both `/v1` + `/api` and the SPA at
`/`. Client-side routes fall back to `index.html`; API namespaces always return
JSON. This is off by default in dev (Vite serves the UI) and in tests.

---

## Security notes

- `.env`, `*.db`, and `data/` are git-ignored — secrets and the database
  (which now holds **encrypted** OAuth tokens) never enter version control.
- Client keys (`sk-router-…`) and the admin token are **separate**: a leaked
  client key cannot reach provider credentials or the admin API.
- Keep `REQUIRE_API_KEY=true` on any non-localhost bind. The router refuses to
  treat a public bind as safe when auth is disabled.
- No real provider credentials ship in this repository.


