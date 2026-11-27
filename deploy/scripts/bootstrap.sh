#!/bin/sh
# New VPS in one command (Debian or Ubuntu, amd64). Run as root; safe to run again, each step skips what is done:
#   curl -fsSL https://raw.githubusercontent.com/partho5/postiz-clone-public/main/deploy/scripts/bootstrap.sh -o bootstrap.sh
#   sudo sh bootstrap.sh --domain app.example.com [--email ops@example.com] [--user smm] [--dir /var/www/smm]
#        [--tier 2gb|4gb|8gb] [--repo <git url>]
# Steps: packages and Docker, swap, the deploy user, a git checkout of deploy/ (the layout remote-deploy.sh keeps up to
# date), deploy/.env with every secret this server can make itself (database passwords, JWT_SECRET,
# APP_CREDENTIALS_SECRET, the paid-features signing key), the edge (the host's nginx when one is running, else Caddy),
# the CI deploy key with its forced command, and the first deploy. Values only the owner has (Mailgun, PayPal, R2) stay
# marked <-- FILL in deploy/.env: the script lists them and stops before deploying; fill them and run it again.
# It never touches an existing database volume, an existing deploy/.env value that is filled, or other nginx sites.
set -eu

DOMAIN=""
EMAIL=""
DEPLOY_USER="${SUDO_USER:-smm}"
DIR=/var/www/smm
TIER=""
REPO=https://github.com/partho5/postiz-clone-public.git

# Prints a message to stderr and stops with a failure.
fail() {
  echo "bootstrap: $*" >&2
  exit 1
}

say() {
  echo "bootstrap: $*"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --user) DEPLOY_USER="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --tier) TIER="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    *) fail "unknown option $1 (see the header of this script)" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run as root: sudo sh bootstrap.sh --domain <name>"
case "$DOMAIN" in
  '' | *[!a-z0-9.-]* | .* | *.) fail "--domain <public name> is required, e.g. --domain app.example.com" ;;
esac
case "$DEPLOY_USER" in
  '' | root | *[!a-z0-9_-]*) fail "--user must name a non-root user (letters, digits, - and _)" ;;
esac

# --- 1. Preflight ---------------------------------------------------------------------------------------------------
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in
  *debian* | *ubuntu*) ;;
  *) fail "Debian or Ubuntu expected, found ${PRETTY_NAME:-unknown}" ;;
esac
[ "$(uname -m)" = x86_64 ] || fail "amd64 expected (the image is built for linux/amd64), found $(uname -m)"
MEM_MB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)
if [ -z "$TIER" ]; then
  if [ "$MEM_MB" -lt 3000 ]; then TIER=2gb; elif [ "$MEM_MB" -lt 6000 ]; then TIER=4gb; else TIER=8gb; fi
fi
FREE_GB=$(df -P / | awk 'NR == 2 {print int($4 / 1048576)}')
[ "$FREE_GB" -ge 20 ] || fail "at least 20 GB free on / needed (each app image is about 7 GB), found ${FREE_GB} GB"
say "$PRETTY_NAME, ${MEM_MB} MB RAM, ${FREE_GB} GB free; tier $TIER"

# --- 2. Packages and Docker ---------------------------------------------------------------------------------------
if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v openssl >/dev/null ||
  ! command -v flock >/dev/null || ! command -v ssh-keygen >/dev/null; then
  say "installing git, curl, openssl, ssh-keygen"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl openssl ca-certificates util-linux openssh-client \
    >/dev/null
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
# --- 3. Deploy user, checkout, swap -------------------------------------------------------------------------------------
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  say "creating user $DEPLOY_USER"
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
getent group docker >/dev/null || groupadd docker
usermod -aG docker "$DEPLOY_USER"
as_user() {
  runuser -u "$DEPLOY_USER" -- "$@"
}
mkdir -p "$DIR"
chown "$DEPLOY_USER": "$DIR"
if [ ! -d "$DIR/.git" ]; then
  say "checking out deploy/ into $DIR"
  as_user git -C "$DIR" init -q
  as_user git -C "$DIR" remote add origin "$REPO"
  as_user git -C "$DIR" config core.sparseCheckout true
  as_user sh -c "printf '/deploy/\n/dynamicconfig/\n/.gitignore\n' > '$DIR/.git/info/sparse-checkout'"
  as_user git -C "$DIR" fetch -q --filter=blob:none origin main
  as_user git -C "$DIR" checkout -q -f --detach origin/main
fi
if [ -z "$(swapon --show --noheadings)" ]; then
  say "adding 2 GB of swap"
  sh "$DIR/deploy/scripts/setup-swap.sh" 2G >/dev/null
fi

# --- 4. deploy/.env --------------------------------------------------------------------------------------------------
ENV="$DIR/deploy/.env"
if [ ! -f "$ENV" ]; then
  say "writing $ENV from env.example"
  (umask 077 && cp "$DIR/deploy/env.example" "$ENV")
  chown "$DEPLOY_USER": "$ENV"
fi
chmod 600 "$ENV"

# Prints the value of KEY in deploy/.env (empty when unset).
env_value() {
  sed -n "s/^$1=//p" "$ENV" | tail -n 1 | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'
}

# Sets KEY=VALUE in deploy/.env (the line and its comment are replaced), only while KEY is unset or a placeholder.
fill() {
  CURRENT=$(env_value "$1")
  case "$CURRENT" in
    '' | change-me | *example.com*) ;;
    *) return 0 ;;
  esac
  TMP=$(mktemp)
  # Through the environment, not awk -v, which would turn the \n in the signing key into line breaks.
  FILL_KEY="$1" FILL_LINE="$1=$2" awk 'BEGIN { k = ENVIRON["FILL_KEY"]; line = ENVIRON["FILL_LINE"] }
    index($0, k "=") == 1 { if (!done) print line; done = 1; next } { print }
    END { if (!done) print line }' "$ENV" >"$TMP"
  cat "$TMP" >"$ENV"
  rm -f "$TMP"
}

fill DOMAIN "$DOMAIN"
fill FRONTEND_URL "https://$DOMAIN"
fill NEXT_PUBLIC_BACKEND_URL "https://$DOMAIN/api"
fill MAIN_URL "https://$DOMAIN"
fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill APP_DB_PASSWORD "$(openssl rand -hex 24)"
fill TEMPORAL_DB_PASSWORD "$(openssl rand -hex 24)"
fill JWT_SECRET "$(openssl rand -hex 48)"
fill APP_CREDENTIALS_SECRET "$(openssl rand -hex 32)"
if [ "$(env_value ENTITLEMENT_KEY_ID)" = change-me ] || [ -z "$(env_value ENTITLEMENT_KEY_ID)" ]; then
  say "making the paid-features signing key (k1)"
  KEY=$(mktemp)
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY" 2>/dev/null
  fill ENTITLEMENT_SIGNING_KEY "'$(awk 'NF {printf "%s\\n", $0}' "$KEY")'"
  fill ENTITLEMENT_KEY_ID k1
  say "its public key, for the phone app's ENTITLEMENT_PUBLIC_KEYS: k1=$(openssl pkey -in "$KEY" -pubout -outform DER | openssl base64 -A)"
  rm -f "$KEY"
fi

# --- 5. Edge: the host's nginx when it runs, else Caddy --------------------------------------------------------------
if systemctl is-active --quiet nginx 2>/dev/null; then
  fill HOST_NGINX 1
  PORT=$(env_value APP_HOST_PORT)
  SITE="/etc/nginx/sites-available/$DOMAIN"
  if [ ! -f "$SITE" ]; then
    say "adding the nginx site $SITE (proxy to 127.0.0.1:${PORT:-3000})"
    sed "s/__DOMAIN__/$DOMAIN/g; s/__APP_HOST_PORT__/${PORT:-3000}/g" "$DIR/deploy/nginx/site.conf" >"$SITE"
    ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
    nginx -t >/dev/null 2>&1 || { rm -f "/etc/nginx/sites-enabled/$DOMAIN" "$SITE"; fail "nginx -t refused the new site; removed it"; }
    systemctl reload nginx
  fi
  if ! grep -q 'ssl_certificate' "$SITE"; then
    if command -v certbot >/dev/null && [ -n "$EMAIL" ]; then
      say "getting a certificate for $DOMAIN"
      certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos -m "$EMAIL" >/dev/null ||
        say "certbot failed (DNS not pointing here yet?); run again later: certbot --nginx -d $DOMAIN --redirect"
    else
      say "no certificate yet: apt-get install certbot python3-certbot-nginx, then certbot --nginx -d $DOMAIN --redirect"
    fi
  fi
else
  say "edge: Caddy (ports 80 and 443 must be free and open; it gets the certificate itself)"
fi

# --- 6. CI deploy key ------------------------------------------------------------------------------------------------
HOME_DIR=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
KEYS="$HOME_DIR/.ssh/authorized_keys"
as_user mkdir -p -m 700 "$HOME_DIR/.ssh"
as_user touch "$KEYS"
chmod 600 "$KEYS"
if ! grep -q 'github-actions-deploy$' "$KEYS"; then
  KEYDIR=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N '' -C github-actions-deploy -f "$KEYDIR/key"
  printf 'command="sh %s/deploy/scripts/remote-deploy.sh %s",restrict %s\n' "$DIR" "$TIER" "$(cat "$KEYDIR/key.pub")" >>"$KEYS"
  echo
  echo "=== GitHub: Settings > Secrets and variables > Actions, of the repository that builds the image ==="
  echo "Secret DEPLOY_SSH_KEY  = the private key below (all lines)"
  echo "Secret DEPLOY_HOST     = $(curl -fsS --max-time 10 https://api.ipify.org || echo "<this server's public IP>") (the IP, not a domain behind a proxy)"
  echo "Variable DEPLOY_USER   = $DEPLOY_USER"
  echo "Variable DEPLOY_URL    = https://$DOMAIN"
  echo "It is shown only now and not kept on this server."
  cat "$KEYDIR/key"
  echo "==="
  echo
  rm -rf "$KEYDIR"
fi

# --- 7. First deploy, once every owner value is filled ---------------------------------------------------------------
MISSING=$(grep -E '^[A-Z_]+=.*(change-me|example\.com)' "$ENV" | cut -d= -f1 | tr '\n' ' ')
if [ -n "$MISSING" ]; then
  say "fill these in $ENV, then run this script again: $MISSING"
  exit 0
fi
say "first deploy (tier $TIER)"
as_user env SSH_ORIGINAL_COMMAND=deploy sh "$DIR/deploy/scripts/remote-deploy.sh" "$TIER"
say "done: https://$DOMAIN; from now on every push to main deploys here"
