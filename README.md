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
- интерактивная первичная настройка для локального запуска и VDS;
- диагностика Node.js, Codex, каталогов и модулей перед запуском;
- необязательные TTS/STT-модули, выключенные по умолчанию;
- просмотр лимитов и статистики использования Codex.

## Быстрый запуск

Требования:

- Node.js 22.5+;
- установленный и авторизованный Codex CLI (`codex login status`);
- проект должен быть Git-репозиторием.

Первичная настройка:

```bash
npm ci
npm run setup
npm run doctor
npm run build
npm start
```

Мастер спрашивает:

- локальный запуск или VDS;
- корневые каталоги проектов;
- каталог данных и порт;
- Tailscale или публичный HTTPS reverse proxy для VDS;
- нужен ли вход по ключу;
- путь к Codex CLI.

Результат сохраняется в `.env` с правами `0600`. Существующий ключ при
повторном запуске мастера сохраняется, пока пользователь явно не запросит новый.
Для неинтерактивной локальной конфигурации с безопасными значениями по умолчанию:

```bash
npm run setup -- --mode local --yes
```

Открыть `http://127.0.0.1:8787`. Полная инструкция для локального компьютера и
VDS находится в [docs/deployment.md](docs/deployment.md).

## Конфигурация

Ronix разрешает добавлять проекты только из каталогов, перечисленных в
`PROJECT_ROOTS`. Мастер записывает их в `.env`; переменные процесса имеют
приоритет над этим файлом. Другой конфиг можно передать через
`RONIX_CONFIG=/absolute/path/config.env`.

В локальном режиме короткое имя вроде `RONIX` считается относительно
`~/Projects`, поэтому превращается в `~/Projects/RONIX`. На VDS относительные
пути считаются от `/srv/ronix-projects`. Перед записью мастер всегда показывает
итоговые абсолютные пути; абсолютные пути и форма `~/...` принимаются напрямую.

```bash
RONIX_DEPLOYMENT_MODE=local
RONIX_ACCESS_MODE=local
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

## Голосовые модули

TTS и STT не входят в обязательный runtime Ronix и по умолчанию отключены:

```bash
TTS_ENABLED=false
TTS_PROVIDER=
TTS_ENDPOINT=
STT_ENABLED=false
STT_PROVIDER=
STT_ENDPOINT=
```

Если модуль включён, `PROVIDER` и `ENDPOINT` обязательны. Состояние конфигурации
доступно через `GET /api/modules` и `GET /api/health`. Основной интерфейс,
Codex-сессии и развёртывание не зависят от наличия голосовых моделей.
Конкретные адаптеры Silero/Piper и Whisper будут отдельными runtime-модулями.

## Ручная публикация через HTTPS

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

## Ручной запуск через systemd

Основной VDS-сценарий генерирует unit автоматически:

```bash
npm ci
npm run setup -- --mode vds
npm run build
sudo cp .ronix/ronix-agent.service /etc/systemd/system/ronix-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now ronix-agent
```

Ниже оставлен ручной unit для нестандартной раскладки каталогов.

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
Environment=RONIX_CONFIG=/opt/ronix-agent/.env
ExecStart=/usr/bin/node dist/src/server.js
Restart=always
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

Сохраните выданный мастером ключ в менеджере паролей. Не добавляйте `.env` или
сам ключ в Git.
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
GET  /api/modules
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
