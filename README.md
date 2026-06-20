# Ronix Agent

Минимальная серверная прослойка над Codex для долгоживущих проектных сессий.

Сейчас реализовано:

- регистрация локальных проектов из разрешённых директорий;
- создание проектных сессий;
- сохранение `threadId` в SQLite;
- продолжение диалога через `Codex.resumeThread()`;
- поток структурированных событий через SSE;
- прерывание активного turn;
- адаптивный web-клиент с мобильным меню;
- вход по 32-байтному ключу через защищённую cookie;
- просмотр лимитов и статистики использования Codex.

## Запуск

Требования:

- Node.js 22.5+;
- установленный и авторизованный Codex CLI (`codex login status`);
- проект должен быть Git-репозиторием.

```bash
npm install
npm run dev
```

Открыть `http://127.0.0.1:8787`.

Ronix разрешает добавлять проекты только из каталогов, перечисленных в
`PROJECT_ROOTS`. Для локального запуска значение по умолчанию —
`/home/ronix/Projects/RONIX`:

```bash
HOST=127.0.0.1
PORT=8787
DATA_DIR=./data
PROJECT_ROOTS=/home/ronix/Projects/RONIX,/another/allowed/root
CODEX_PATH=/usr/bin/codex
```

В production-примере ниже используется отдельный каталог
`/srv/ronix-projects`. Это не дополнительная встроенная папка, а значение
`PROJECT_ROOTS` из systemd-сервиса. Создаваемый или добавляемый проект должен
находиться внутри одного из указанных корневых каталогов.

В web-интерфейсе достаточно указать имя папки, например `veyra`. Ronix ищет её
по очереди во всех каталогах из `PROJECT_ROOTS`. Если папка не найдена,
интерфейс показывает полный предполагаемый путь и предлагает создать новый
проект. После подтверждения Ronix создаёт каталог в первом `PROJECT_ROOTS` и
выполняет в нём `git init`. Имена с `/`, `\` или `..` не принимаются.

## Доступ по ключу

Для удалённого доступа сгенерируйте 32-байтный ключ:

```bash
openssl rand -hex 32
```

Передайте результат через `AGENT_KEY`. После входа браузер получает случайную
`HttpOnly`-cookie на 30 дней; сам ключ не сохраняется в браузере. Пять неверных
попыток с одного адреса блокируют новые попытки на 15 минут.

```bash
AGENT_KEY=<64-символьный-hex-ключ>
AUTH_SESSION_DAYS=30
AUTH_COOKIE_SECURE=true
```

`AUTH_COOKIE_SECURE=true` рассчитан на публикацию через HTTPS-прокси (Caddy или
Nginx). Сам backend безопаснее оставить на `127.0.0.1:8787`. Для локального HTTP
без ключа авторизация отключена. Если ключ нужен при локальном HTTP-тестировании,
задайте `AUTH_COOKIE_SECURE=false`.

Для API-скриптов ключ также можно передавать как `Authorization: Bearer <ключ>`.
Старое имя переменной `AGENT_TOKEN` пока поддерживается как совместимый alias.

## Публикация через HTTPS

Не открывайте порт `8787` напрямую в интернет. Оставьте Ronix на loopback-адресе
и поставьте перед ним reverse proxy с HTTPS.

1. Создайте DNS-запись `A` для домена, направленную на IPv4 сервера.
2. Установите Caddy и откройте порты 80/443:

```bash
sudo apt install -y caddy
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

3. Настройте `/etc/caddy/Caddyfile`, заменив домен на свой:

```caddy
ronix.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

4. Примените конфигурацию:

```bash
sudo systemctl reload caddy
```

Caddy автоматически получает и обновляет TLS-сертификат. После этого интерфейс
доступен по `https://ronix.example.com`.

## Запуск через systemd

Сначала соберите проект:

```bash
npm ci
npm run build
```

Пример `/etc/systemd/system/ronix-agent.service`:

```ini
[Unit]
Description=Ronix Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ronix
Group=ronix
WorkingDirectory=/opt/ronix-agent
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=DATA_DIR=/var/lib/ronix-agent
Environment=PROJECT_ROOTS=/srv/ronix-projects
Environment=CODEX_PATH=/usr/bin/codex
ExecStart=/usr/bin/node dist/src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

Ключ лучше хранить отдельно от unit-файла:

```bash
KEY=$(openssl rand -hex 32)
sudo mkdir -p /etc/systemd/system/ronix-agent.service.d
printf '[Service]\nEnvironment=AGENT_KEY=%s\nEnvironment=AUTH_COOKIE_SECURE=true\nEnvironment=AUTH_SESSION_DAYS=30\n' "$KEY" |
  sudo tee /etc/systemd/system/ronix-agent.service.d/auth.conf >/dev/null
sudo chmod 600 /etc/systemd/system/ronix-agent.service.d/auth.conf
sudo systemctl daemon-reload
sudo systemctl enable --now ronix-agent
printf 'Ключ доступа: %s\n' "$KEY"
```

Сохраните ключ в менеджере паролей. Не добавляйте `auth.conf` или сам ключ в Git.
При перезапуске процесса активные cookie-сессии сбрасываются, после чего ключ
нужно ввести повторно.

Для обновления установленной версии:

```bash
git pull
npm ci
npm run build
sudo systemctl restart ronix-agent
```

## Локальный запуск и Termux

При запуске без `AGENT_KEY` на `127.0.0.1` форма входа отключена. Поэтому на
том же устройстве достаточно открыть `http://127.0.0.1:8787`. В Termux сервер
можно запускать обычными командами `npm run build && npm start`; чтобы Android
не останавливал процесс в фоне, может потребоваться `termux-wake-lock` и
отключение оптимизации батареи для Termux.

Backend автоматически ищет `codex` в `PATH` и передаёт его SDK через
`codexPathOverride`. Это важно: bundled-бинарник SDK может быть старее
установленного CLI и не поддерживать текущую модель. `CODEX_PATH` позволяет
явно закрепить нужный бинарник.

## API

```text
GET  /api/auth/status
POST /api/auth/login
POST /api/auth/logout
GET  /api/codex/usage
GET  /api/health
GET  /api/projects
POST /api/projects
GET  /api/sessions?projectId=...
POST /api/sessions
GET  /api/sessions/:id
DELETE /api/sessions/:id
GET  /api/sessions/:id/events
POST /api/sessions/:id/turns
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/stop
POST /api/sessions/:id/resume
```

## Ограничения MVP

- Сессия работает прямо в директории проекта; отдельные Git worktree ещё не создаются.
- TypeScript SDK не предоставляет интерактивный approval-протокол, поэтому
  turns запускаются с `approvalPolicy: "never"` и `danger-full-access`. Codex имеет
  запись в `.git`, сетевой доступ и права пользователя, запустившего Ronix.
  Публикуйте интерфейс только через HTTPS и обязательно включайте `AGENT_KEY`.
- Для approvals, fork и управления одним общим daemon следующий этап должен
  перейти на `codex app-server`.
- Backend рассчитан на одного доверенного пользователя.
