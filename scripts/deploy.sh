#!/usr/bin/env bash
# triage360 后端部署（#39）。在服务器上以 root 执行；每步先看现状再动手，
# 重复执行即把线上刷成 origin/main 的最新构建。
set -euo pipefail

REPO=${REPO:-https://github.com/jing-gou/triage360}
BRANCH=${BRANCH:-main}
APP_DIR=${APP_DIR:-/srv/triage360}
APP_USER=${APP_USER:-triage360}
SERVICE=${SERVICE:-triage360}
UNIT=/etc/systemd/system/${SERVICE}.service
NGINX_SITE=/etc/nginx/sites-available/${SERVICE}.conf
NGINX_LINK=/etc/nginx/sites-enabled/${SERVICE}.conf
DEPLOY_ENV=${DEPLOY_ENV:-/etc/triage360/deploy.env}

log() { printf '==> %s\n' "$*"; }
die() { printf '!!  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 执行"
[ -f "$DEPLOY_ENV" ] || die "缺少 $DEPLOY_ENV（root 600，键见 README）"

# deploy.env 只喂给本脚本与 systemd，任何分支都不回显其中的值。
set -a
# shellcheck source=/dev/null
. "$DEPLOY_ENV"
set +a
: "${APP_BASE_URL:?deploy.env 缺 APP_BASE_URL}" \
  "${FRONTEND_URL:?deploy.env 缺 FRONTEND_URL}" \
  "${GITHUB_CLIENT_ID:?deploy.env 缺 GITHUB_CLIENT_ID}" \
  "${GITHUB_CLIENT_SECRET:?deploy.env 缺 GITHUB_CLIENT_SECRET}"
HOST=${HOST:-127.0.0.1}
PORT=${PORT:-8787}
# 加密存储与密钥的落点（#13）：密钥文件 store.key 与数据同目录，都只有服务账号能读。
DATA_DIR=${DATA_DIR:-/var/lib/triage360}
DOMAIN=${DOMAIN:-${APP_BASE_URL#*://}}
DOMAIN=${DOMAIN%%/*}

NODE_BIN=$(command -v node) || die "没有 node（要 ≥22.12）"
NPM_BIN=$(command -v npm) || die "没有 npm"
RUN_PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
NPM_CACHE=/tmp/triage360-npm-cache
command -v nginx >/dev/null || die "没有 nginx"
command -v certbot >/dev/null || die "没有 certbot"

# 1. 账号与目录
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "创建系统用户 $APP_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"
# 数据目录不跟着代码走：重新克隆/重置检出不该碰凭据，备份也只备份这一处。
mkdir -p "$DATA_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# 2. 代码：这一份检出归部署所有，有本地改动就停下等人看过。
# git 的 safe.directory 只认 system/global 配置（命令行 -c 被刻意忽略），
# 所以 git 一律以 triage360 身份跑，root 只负责装包与写 systemd / nginx。
run_as_app() { runuser -u "$APP_USER" -- env HOME="$APP_DIR" PATH="$RUN_PATH" "$@"; }
# 旧版脚本把 npm 缓存落在检出里；它不是代码，清掉才能判「干净」。
rm -rf "$APP_DIR/.npm"
if [ -d "$APP_DIR/.git" ]; then
  status=$(run_as_app git -C "$APP_DIR" status --porcelain) || die "读不出 $APP_DIR 的 git 状态"
  [ -z "$status" ] || die "$APP_DIR 有未提交改动，先人工确认"
  log "更新代码到 origin/$BRANCH"
  run_as_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  run_as_app git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  log "克隆 $REPO"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 3. 构建：devDependencies 参与编译，最终只有 dist-server/index.js 上线。
log "npm ci + build:server"
run_as_app "$NPM_BIN" --prefix "$APP_DIR" --cache "$NPM_CACHE" ci
run_as_app "$NPM_BIN" --prefix "$APP_DIR" --cache "$NPM_CACHE" run build:server

# 4. 运行环境：七键、root 600；配了 DEEPSEEK_API_KEY 就多一行（#8）。内容没变就不碰文件。
ENV_FILE=$APP_DIR/.env
tmp_env=$(mktemp)
trap 'rm -f "$tmp_env"' EXIT
umask 077
{
  printf 'APP_BASE_URL=%s\n' "$APP_BASE_URL"
  printf 'FRONTEND_URL=%s\n' "$FRONTEND_URL"
  printf 'HOST=%s\n' "$HOST"
  printf 'PORT=%s\n' "$PORT"
  printf 'DATA_DIR=%s\n' "$DATA_DIR"
  printf 'GITHUB_CLIENT_ID=%s\n' "$GITHUB_CLIENT_ID"
  printf 'GITHUB_CLIENT_SECRET=%s\n' "$GITHUB_CLIENT_SECRET"
  if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"
  fi
} > "$tmp_env"
if cmp -s "$tmp_env" "$ENV_FILE"; then
  log ".env 未变"
else
  log "写 $ENV_FILE"
  install -m 600 -o root -g root "$tmp_env" "$ENV_FILE"
fi

# 5. systemd：常驻 + 开机自启
tmp_unit=$(mktemp)
cat > "$tmp_unit" <<EOF
[Unit]
Description=triage360 backend (OAuth callback + items API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist-server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
if cmp -s "$tmp_unit" "$UNIT"; then
  log "unit 未变"
else
  log "写 $UNIT"
  install -m 644 "$tmp_unit" "$UNIT"
fi
rm -f "$tmp_unit"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

# 6. 反代：vhost 只在首次生成（443 那段由 certbot 维护，重跑不覆盖）
if [ ! -f "$NGINX_SITE" ]; then
  log "写 $NGINX_SITE"
  cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"
fi
nginx -t
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring --redirect
systemctl reload nginx

# 7. 断言：只有反代在公网面，后端只在回环口；健康检查能过才算部署成功
ss -ltn | grep -q "127.0.0.1:$PORT" || die "后端没有监听 127.0.0.1:$PORT"
if ss -ltn | awk '{print $4}' | grep -qE "(^0\.0\.0\.0:$PORT$|^\[::\]:$PORT$|\*:$PORT$)"; then
  die "后端还开着公网口 $PORT"
fi

code=000
for _ in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/health" || true)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || die "https://$DOMAIN/health 返回 $code；看 journalctl -u $SERVICE -n 50"
log "部署完成：https://$DOMAIN/health = 200，回调地址 https://$DOMAIN/cb/github"
