# Ronix Agent

Серверная прослойка над Codex app-server для долгоживущих проектных сессий.

Сейчас реализовано:

- регистрация локальных проектов из разрешённых директорий;
- создание проектных сессий;
- сохранение `threadId` в SQLite;
- один долгоживущий процесс `codex app-server`;
- продолжение диалога через `thread/resume`;
- поток структурированных событий через SSE;
- прерывание активного turn;
- безопасный `workspace-write` по умолчанию и переключение режима доступа;
- подтверждение команд и изменений файлов в web-интерфейсе;
- восстановление сессий после перезапуска процесса;
- пагинация истории и ограничение размера журнала событий;
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
TRUST_PROXY=false
EVENT_HISTORY_LIMIT=200
EVENT_RETENTION=5000
SHUTDOWN_TIMEOUT_MS=10000
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

При работе через Caddy или Nginx установите `TRUST_PROXY=true`. Тогда Ronix
использует переданные прокси `X-Forwarded-For` и `X-Forwarded-Proto`. Без этой
настройки эти заголовки игнорируются, чтобы клиент не мог подменить IP для обхода
ограничения попыток входа.

Изменяющие cookie-auth запросы проверяют `Origin`. Ronix также отправляет CSP,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` и запрет
встраивания во frame.

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
Environment=TRUST_PROXY=true
ExecStart=/usr/bin/node dist/src/server.js
Restart=always
RestartSec=3
TimeoutStopSec=15
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

Backend автоматически ищет `codex` в `PATH` и запускает
`codex app-server`. `CODEX_PATH` позволяет явно закрепить нужный бинарник.
Ronix держит один app-server-процесс вместо запуска отдельного процесса для
каждого turn или запроса лимитов.

## Режимы доступа

Каждая сессия хранит собственный режим:

- `read-only` — чтение проекта без записи;
- `workspace-write` — режим по умолчанию, запись только в проект и разрешённые
  Codex writable roots;
- `danger-full-access` — полный доступ пользователя, запустившего Ronix.

В `read-only` и `workspace-write` используется `approvalPolicy: on-request`.
Запросы на выполнение команды или изменение файлов показываются в web-клиенте.
Полный доступ выбирается явно и работает без дополнительных approvals.

## API

```text
GET  /api/auth/status
POST /api/auth/login
POST /api/auth/logout
GET  /api/codex/usage
GET  /api/codex/models
GET  /api/health
GET  /api/projects
POST /api/projects
GET  /api/sessions?projectId=...
POST /api/sessions
GET  /api/sessions/:id
DELETE /api/sessions/:id
GET  /api/sessions/:id/events
GET  /api/sessions/:id/events/history
POST /api/sessions/:id/turns
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/stop
POST /api/sessions/:id/resume
POST /api/sessions/:id/settings
POST /api/sessions/:id/approvals/:approvalId
```

## Состояние и восстановление

- Сессия хранит выбранные модель, reasoning effort и режим доступа и работает
  прямо в директории проекта; отдельные Git worktree ещё не создаются.
- Последние открытые проект и сессия, а также настройки для новых сессий
  сохраняются локально в браузере.
- При штатном завершении Ronix прерывает активные turns перед остановкой
  app-server. Если процесс был убит аварийно, оставшиеся `running`-сессии при
  следующем запуске переводятся в `error`; сохранённый `threadId` остаётся и
  следующий turn продолжает тот же Codex thread.
- `EVENT_HISTORY_LIMIT` задаёт размер начальной страницы истории.
  `EVENT_RETENTION` ограничивает количество сохранённых UI-событий на сессию.
- Ожидающие approval-запросы относятся к живому app-server-соединению и после
  аварийного рестарта отменяются.
- Backend рассчитан на одного доверенного пользователя.
- Публикуйте интерфейс только через HTTPS и обязательно включайте `AGENT_KEY`.
