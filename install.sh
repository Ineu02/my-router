#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  LLM Router — one-command production installer (Ubuntu/Debian)
#
#  Installs Node.js, builds the router API + web dashboard, generates
#  strong secrets, and runs everything as a persistent systemd service
#  that survives crashes and reboots.
#
#  Usage (as root, or a user with sudo):
#      curl -fsSL https://raw.githubusercontent.com/Ineu02/my-router/main/install.sh | sudo bash
#  or, from a checkout:
#      sudo ./install.sh
#
#  Tunables (export before running):
#      REPO_URL      git URL to clone           (default: this repo)
#      REPO_REF      branch/tag/commit           (default: main)
#      INSTALL_DIR   install location            (default: /opt/llm-router)
#      SERVICE_USER  system user for the service (default: llmrouter)
#      ROUTER_PORT   public API/dashboard port   (default: 20128)
#      GITHUB_TOKEN  token for a PRIVATE repo clone (optional)
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ineu02/my-router.git}"
REPO_REF="${REPO_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/llm-router}"
SERVICE_USER="${SERVICE_USER:-llmrouter}"
SERVICE_NAME="llm-router"
ROUTER_PORT="${ROUTER_PORT:-20128}"
NODE_MAJOR="${NODE_MAJOR:-20}"
WRAPPER="/usr/local/bin/llm-router"

log()  { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. must be root ───────────────────────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
  die "Run as root:  sudo ./install.sh   (or pipe the curl command through 'sudo bash')."
fi

# ── 1. detect distro ──────────────────────────────────────────────────
if [[ ! -r /etc/os-release ]]; then
  die "Cannot read /etc/os-release — this installer targets Ubuntu/Debian."
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ok "Detected ${PRETTY_NAME:-Debian/Ubuntu}." ;;
  *) die "Unsupported distro '${PRETTY_NAME:-unknown}'. This installer supports Ubuntu/Debian only." ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ── 2. base packages (git, build toolchain for native better-sqlite3) ─
log "Installing base packages…"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 openssl >/dev/null
ok "Base packages present."

# ── 3. Node.js ${NODE_MAJOR}.x + npm (+ pnpm via corepack) ────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/^v//; s/\..*//')"
  if [[ "${cur}" -ge "${NODE_MAJOR}" ]]; then need_node=0; ok "Node $(node -v) already installed."; fi
fi
if [[ "${need_node}" -eq 1 ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "Installed Node $(node -v)."
fi
# pnpm is requested but the repo ships a package-lock.json, so `npm ci` is
# the source of truth. Enable pnpm via corepack anyway for parity.
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || warn "pnpm activation skipped (npm is used for the build)."

# ── 4. service user ───────────────────────────────────────────────────
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  log "Creating system user '${SERVICE_USER}'…"
  useradd --system --create-home --home-dir "/home/${SERVICE_USER}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
ok "Service user '${SERVICE_USER}' ready."

# ── 5. clone or update the repo ───────────────────────────────────────
clone_url="${REPO_URL}"
if [[ -n "${GITHUB_TOKEN:-}" && "${REPO_URL}" == https://github.com/* ]]; then
  clone_url="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Updating existing checkout at ${INSTALL_DIR}…"
  git -C "${INSTALL_DIR}" remote set-url origin "${clone_url}"
  git -C "${INSTALL_DIR}" fetch --depth 1 origin "${REPO_REF}" >/dev/null 2>&1
  git -C "${INSTALL_DIR}" checkout -q "${REPO_REF}"
  git -C "${INSTALL_DIR}" reset --hard "origin/${REPO_REF}" >/dev/null 2>&1 || git -C "${INSTALL_DIR}" reset --hard "${REPO_REF}" >/dev/null 2>&1
elif [[ -f "${INSTALL_DIR}/package.json" ]]; then
  ok "Using existing (non-git) source at ${INSTALL_DIR}."
else
  log "Cloning ${REPO_URL} (ref ${REPO_REF}) → ${INSTALL_DIR}…"
  git clone --depth 1 --branch "${REPO_REF}" "${clone_url}" "${INSTALL_DIR}" 2>/dev/null \
    || die "Clone failed. For a PRIVATE repo, export GITHUB_TOKEN=<pat> and re-run, or clone manually into ${INSTALL_DIR}."
fi
# Scrub any token from the stored remote so it never lingers on disk.
git -C "${INSTALL_DIR}" remote set-url origin "${REPO_URL}" 2>/dev/null || true
ok "Source ready at ${INSTALL_DIR}."

# ── 6. install deps + build API and dashboard ─────────────────────────
log "Installing dependencies (npm ci)…"
cd "${INSTALL_DIR}"
if [[ -f package-lock.json ]]; then npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1; else npm install >/dev/null 2>&1; fi
ok "Dependencies installed."

log "Building router API…"
npm run build >/dev/null 2>&1 || die "API build failed. Run 'npm run build' in ${INSTALL_DIR} to see the error."
ok "API build complete (apps/api/dist)."

log "Building web dashboard…"
npm run build --workspace=@router/web >/dev/null 2>&1 || die "Dashboard build failed. Run 'npm run build --workspace=@router/web' to see the error."
[[ -f apps/web/dist/index.html ]] || die "Dashboard build produced no index.html."
ok "Dashboard build complete (apps/web/dist)."

# ── 7. production .env with generated secrets ─────────────────────────
gen() { openssl rand -hex "${1:-32}" 2>/dev/null || node -e "console.log(require('crypto').randomBytes(${1:-32}).toString('hex'))"; }
ENV_FILE="${INSTALL_DIR}/.env"
if [[ -f "${ENV_FILE}" ]]; then
  warn ".env already exists — leaving it untouched (secrets preserved)."
else
  log "Generating production .env with fresh secrets…"
  ROUTER_KEY="sk-router-$(gen 24)"
  ADMIN_TOK="$(gen 32)"
  SESSION_SEC="$(gen 32)"
  ENC_KEY="$(gen 32)"
  PUBLIC_IP="$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || echo '')"
  ORIGIN="http://${PUBLIC_IP:-<your-server-ip>}:${ROUTER_PORT}"
  cp "${INSTALL_DIR}/.env.example" "${ENV_FILE}"
  # Rewrite the values that must differ in production. sed edits are keyed
  # to the .env.example lines; each key is set exactly once.
  sed -i \
    -e "s|^NODE_ENV=.*|NODE_ENV=production|" \
    -e "s|^ROUTER_HOST=.*|ROUTER_HOST=0.0.0.0|" \
    -e "s|^ROUTER_PORT=.*|ROUTER_PORT=${ROUTER_PORT}|" \
    -e "s|^ROUTER_API_KEY=.*|ROUTER_API_KEY=${ROUTER_KEY}|" \
    -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=${ADMIN_TOK}|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SEC}|" \
    -e "s|^CREDENTIAL_ENC_KEY=.*|CREDENTIAL_ENC_KEY=${ENC_KEY}|" \
    -e "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${ORIGIN}|" \
    "${ENV_FILE}"
  # Serving flag isn't in .env.example's core block; append if absent.
  grep -q '^SERVE_WEB=' "${ENV_FILE}" || printf '\n# Serve the built dashboard from this origin (production single-port).\nSERVE_WEB=true\n' >> "${ENV_FILE}"
  ok "Wrote ${ENV_FILE} (ROUTER_API_KEY, ADMIN_TOKEN, SESSION_SECRET, CREDENTIAL_ENC_KEY generated)."
  echo "${ROUTER_KEY}" > "${INSTALL_DIR}/.router-api-key.txt"
  chmod 600 "${INSTALL_DIR}/.router-api-key.txt"
fi
chmod 600 "${ENV_FILE}"

# ── 8. data directory (SQLite lives here; migrations run on first boot) ─
mkdir -p "${INSTALL_DIR}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
ok "Data directory ready (DB migrations run automatically on first boot)."

# ── 9. systemd service ────────────────────────────────────────────────
log "Installing systemd unit /etc/systemd/system/${SERVICE_NAME}.service…"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=LLM Router (OpenAI-compatible routing gateway + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
# Config is loaded from ${INSTALL_DIR}/.env by the app (dotenv). NODE_ENV is
# also forced here so the process is production-hardened even if .env drifts.
Environment=NODE_ENV=production
ExecStart=$(command -v node) ${INSTALL_DIR}/apps/api/dist/server.js
Restart=on-failure
RestartSec=3
# Hardening. The service only needs to write its own data/ directory.
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${INSTALL_DIR}/data
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llm-router

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
ok "Service installed and enabled (starts on boot)."

# ── 10. management CLI wrapper ────────────────────────────────────────
log "Installing management command → ${WRAPPER}…"
cat > "${WRAPPER}" <<WRAP
#!/usr/bin/env bash
# llm-router — manage the LLM Router service.
set -euo pipefail
SVC="${SERVICE_NAME}"
DIR="${INSTALL_DIR}"
cmd="\${1:-help}"; shift || true
case "\${cmd}" in
  status)  systemctl status "\${SVC}" --no-pager "\$@" ;;
  logs)    journalctl -u "\${SVC}" --no-pager "\${@:--n 200}" ;;
  follow)  journalctl -u "\${SVC}" -f ;;
  start)   sudo systemctl start "\${SVC}"   && echo "started" ;;
  stop)    sudo systemctl stop "\${SVC}"    && echo "stopped" ;;
  restart) sudo systemctl restart "\${SVC}" && echo "restarted" ;;
  key)     echo "Bootstrap ROUTER_API_KEY:"; grep '^ROUTER_API_KEY=' "\${DIR}/.env" | cut -d= -f2- ;;
  config)  \${EDITOR:-nano} "\${DIR}/.env"; echo "Run 'llm-router restart' to apply." ;;
  update)
    echo "Updating from git…"
    sudo -u ${SERVICE_USER} git -C "\${DIR}" pull --ff-only
    sudo -u ${SERVICE_USER} bash -c "cd '\${DIR}' && (npm ci || npm install) && npm run build && npm run build --workspace=@router/web"
    sudo systemctl restart "\${SVC}"
    echo "Updated and restarted." ;;
  uninstall)
    echo "Stopping and removing \${SVC}…"
    sudo systemctl disable --now "\${SVC}" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/\${SVC}.service"
    sudo systemctl daemon-reload
    echo "Service removed. Files at \${DIR} were kept (delete manually with: sudo rm -rf '\${DIR}')."
    sudo rm -f "${WRAPPER}" ;;
  health)  curl -fsS "http://127.0.0.1:${ROUTER_PORT}/api/health" && echo ;;
  *) cat <<EOF
llm-router — manage the LLM Router service
  status     show service status
  logs [-n N]  show recent logs (default 200 lines)
  follow     stream logs live
  start|stop|restart   control the service
  health     hit /api/health locally
  key        print the bootstrap ROUTER_API_KEY
  config     edit .env, then restart to apply
  update     git pull + rebuild + restart
  uninstall  stop & remove the service (keeps data)
EOF
  ;;
esac
WRAP
chmod +x "${WRAPPER}"
ok "Installed 'llm-router' command."

# ── 11. firewall (best-effort) ────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${ROUTER_PORT}/tcp" >/dev/null 2>&1 || true
  ok "Opened ${ROUTER_PORT}/tcp in ufw."
fi

# ── 12. start + health check ──────────────────────────────────────────
log "Starting ${SERVICE_NAME}…"
systemctl restart "${SERVICE_NAME}"
healthy=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${ROUTER_PORT}/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [[ "${healthy}" -ne 1 ]]; then
  warn "Service did not answer /api/health yet. Check:  llm-router logs"
else
  ok "Router is up and healthy."
fi

# ── 13. summary ───────────────────────────────────────────────────────
PUB="$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || echo '<your-server-ip>')"
BAR="────────────────────────────────────────────────────────────────"
cat <<SUMMARY

${BAR}
  LLM Router installed 🎉
${BAR}
  Dashboard   http://${PUB}:${ROUTER_PORT}/
  API base    http://${PUB}:${ROUTER_PORT}/v1
  Health      http://${PUB}:${ROUTER_PORT}/api/health
  Admin token   (dashboard login)   grep ^ADMIN_TOKEN= ${INSTALL_DIR}/.env
  Client key    (Bearer sk-router-) llm-router key
${BAR}
  Manage:   llm-router status | logs | restart | update | uninstall
  Config:   llm-router config      (edits ${INSTALL_DIR}/.env, then restart)
${BAR}
  Next steps
   • Add provider keys:  llm-router config  → set OPENAI_API_KEY=… etc → restart
   • Turn OFF the mock:  set ENABLE_MOCK_PROVIDER=false → restart
   • Connect ChatGPT/Codex OAuth: set CODEX_OAUTH_ENABLED=true → restart,
     then use the dashboard's Registry → Connections tab.
   • For HTTPS, front port ${ROUTER_PORT} with a TLS reverse proxy (Caddy/nginx).
${BAR}
SUMMARY
ok "Done."




