# Развёртывание Ronix

Ronix использует один и тот же конфиг и runtime локально и на VDS:

1. `npm run setup` создаёт `.env`;
2. `npm run doctor` проверяет окружение;
3. `npm run build` собирает приложение;
4. локально запускается `npm start`, на VDS — сгенерированный systemd unit.

Docker не является основным способом установки. Ronix должен работать от того
же Linux-пользователя, у которого авторизован Codex CLI, и иметь прямой доступ к
его `~/.codex` и каталогам проектов. Контейнер в этом сценарии добавляет
монтирования и отдельное управление правами без выигрыша в изоляции.

## Локальный компьютер

```bash
git clone <repo-url> ronix-agent
cd ronix-agent
npm ci
npm run setup -- --mode local
npm run doctor
npm run build
npm start
```

По умолчанию сервер слушает только `127.0.0.1:8787`. Для такого запуска ключ
необязателен. Чтобы повторить настройку, снова выполните `npm run setup`.
Существующий ключ по умолчанию не меняется. Короткие имена каталогов проектов
считаются относительно `~/Projects`: ввод `RONIX` даёт
`~/Projects/RONIX`. Перед сохранением мастер показывает абсолютные пути.

## VDS

Рекомендуемый вариант для одного пользователя:

- отдельный непривилегированный Linux-пользователь;
- Node.js 24 LTS;
- Codex CLI авторизован от этого пользователя;
- backend слушает только `127.0.0.1`;
- доступ через Tailscale Serve;
- systemd перезапускает процесс после сбоя.

Подготовка каталогов:

```bash
sudo useradd --create-home --shell /bin/bash ronix
sudo mkdir -p /opt/ronix-agent /srv/ronix-projects /var/lib/ronix-agent
sudo chown -R ronix:ronix /opt/ronix-agent /srv/ronix-projects /var/lib/ronix-agent
```

Репозиторий, зависимости и Codex должны устанавливаться от пользователя
`ronix`. Проверьте версию Node и авторизацию до настройки сервиса:

```bash
node --version
codex --version
codex login status
```

В каталоге приложения:

```bash
npm ci
npm run setup -- --mode vds
npm run doctor
npm run build
```

Мастер по умолчанию выбирает `/srv/ronix-projects`,
`/var/lib/ronix-agent`, Tailscale и генерирует случайный 32-байтный ключ. Он
также создаёт `.ronix/ronix-agent.service` с реальными путями к приложению,
Node.js и `.env`.

Установка unit:

```bash
sudo cp .ronix/ronix-agent.service /etc/systemd/system/ronix-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now ronix-agent
sudo systemctl status ronix-agent
```

Проверка backend на самом VDS:

```bash
curl -I http://127.0.0.1:8787/login
```

### Доступ через Tailscale

После установки и подключения VDS к tailnet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Порт `8787` в firewall открывать не нужно. Tailscale завершает HTTPS и
проксирует запросы на loopback backend. Конфиг мастера включает
`TRUST_PROXY=true` и secure-cookie.

### Доступ через домен

В мастере выберите `reverse-proxy`. Для Caddy минимальный конфиг:

```caddy
ronix.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

DNS домена должен указывать на VDS, а публично открываются только 80/443.
Backend остаётся на loopback. Caddy передаёт `X-Forwarded-For` и
`X-Forwarded-Proto`, которые Ronix принимает только при `TRUST_PROXY=true`.

## Обновление

```bash
git pull --ff-only
npm ci
npm run doctor
npm run build
sudo systemctl restart ronix-agent
sudo systemctl status ronix-agent
```

Если путь к Node.js или каталогу приложения изменился, повторите
`npm run setup -- --mode vds` и заново установите сгенерированный unit.

## Резервное копирование

Минимальный backup включает:

- каталог из `DATA_DIR` с SQLite-базой;
- `.env`;
- `~/.codex`, если требуется перенос живых Codex-сессий;
- сами Git-репозитории, если их изменения ещё не отправлены в remote.

Перед консистентным копированием SQLite остановите сервис, скопируйте данные и
затем запустите его снова:

```bash
sudo systemctl stop ronix-agent
sudo tar -C /var/lib -czf ronix-agent-data.tar.gz ronix-agent
sudo systemctl start ronix-agent
```

TTS/STT не участвуют в основном backup, пока их внешние runtime-модули
отключены.
