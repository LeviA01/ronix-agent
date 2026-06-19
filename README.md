# Ronix Agent

Минимальная серверная прослойка над Codex для долгоживущих проектных сессий.

Сейчас реализовано:

- регистрация локальных проектов из разрешённых директорий;
- создание проектных сессий;
- сохранение `threadId` в SQLite;
- продолжение диалога через `Codex.resumeThread()`;
- поток структурированных событий через SSE;
- прерывание активного turn;
- простой адаптивный web-клиент.

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

По умолчанию можно регистрировать проекты только внутри
`/home/ronix/Projects/RONIX`. Настройки:

```bash
HOST=127.0.0.1
PORT=8787
DATA_DIR=./data
PROJECT_ROOTS=/home/ronix/Projects/RONIX,/another/allowed/root
CODEX_PATH=/usr/bin/codex
```

`AGENT_TOKEN` относится только к защите HTTP-backend при публикации в сеть,
а не к OpenAI или Codex. В интерфейсе поля для него нет; для удалённого доступа
авторизацию нужно будет вынести в отдельный login/reverse proxy.

Backend автоматически ищет `codex` в `PATH` и передаёт его SDK через
`codexPathOverride`. Это важно: bundled-бинарник SDK может быть старее
установленного CLI и не поддерживать текущую модель. `CODEX_PATH` позволяет
явно закрепить нужный бинарник.

## API

```text
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
  turns запускаются с `approvalPolicy: "never"` и `workspace-write`.
- Для approvals, fork и управления одним общим daemon следующий этап должен
  перейти на `codex app-server`.
- Backend рассчитан на одного доверенного пользователя.
