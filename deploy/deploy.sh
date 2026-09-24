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
# SSH_KEY нужен, когда ключ лежит не под стандартным именем.
SSH_CMD="ssh${SSH_KEY:+ -i ${SSH_KEY}}"

ssh() { command ssh ${SSH_KEY:+-i "${SSH_KEY}"} "$@"; }

echo "==> Копирую исходники в ${SSH_TARGET}:${REMOTE_DIR}"
rsync -az --delete -e "${SSH_CMD}" \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude .git \
  --exclude '.env' \
  ./ "${SSH_TARGET}:${REMOTE_DIR}/"

# --project-directory обязателен: иначе каталогом проекта станет deploy/ и
# compose не найдёт .env, который лежит в корне.
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --project-directory ."

echo "==> Собираю и запускаю стек"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && ${COMPOSE} up -d --build"

echo "==> Применяю миграции"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && ${COMPOSE} exec -T app npm run migration:run:built"

echo "==> Проверяю готовность"
# Контейнер только что пересоздан: приложению нужно несколько секунд на
# подключение к Postgres и Redis, поэтому проверяем с повторами.
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && ${COMPOSE} exec -T app node -e \"
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch('http://127.0.0.1:3000/ready');
      const body = await response.json();
      if (body.status === 'ok') { console.log(body); process.exit(0); }
      console.log('ещё не готово:', body);
    } catch { /* приложение пока не слушает порт */ }
    await wait(1500);
  }
  console.error('приложение не поднялось за 30 секунд');
  process.exit(1);
})();
\""

echo "==> Готово: https://${SSH_HOST}/health"
