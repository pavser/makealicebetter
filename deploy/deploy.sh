#!/usr/bin/env bash
# Выкладка на сервер: копирует исходники, собирает образ, применяет миграции.
#
#   SSH_HOST=alice.pavser.space SSH_USER=root ./deploy/deploy.sh
#
# .env на сервере не перезаписывается — секреты живут только там.
set -euo pipefail

SSH_HOST="${SSH_HOST:?укажите SSH_HOST}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/makealicebetter}"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "==> Копирую исходники в ${SSH_TARGET}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude .git \
  --exclude '.env' \
  ./ "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Собираю и запускаю стек"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml up -d --build"

echo "==> Применяю миграции"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml exec -T app npm run migration:run:built"

echo "==> Проверяю готовность"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.prod.yml exec -T app node -e \"fetch('http://127.0.0.1:3000/ready').then(r=>r.json()).then(j=>console.log(j))\""

echo "==> Готово: https://${SSH_HOST}/health"
