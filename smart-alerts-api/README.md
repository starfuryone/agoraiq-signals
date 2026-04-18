# agoraiq-smart-alerts

Isolated sidecar service that lets **Pro** and **Elite** AgoraIQ subscribers
define plain-English alert rules and receive real-time push notifications
when matching signals fire.

## Isolation contract

| Boundary | Enforcement |
|---|---|
| Database | Own Postgres: `agoraiq_smart_alerts`. Pool never sees any other `DATABASE_URL`. |
| Redis | Own keyspace prefix `sa:`. Own BullMQ queues `sa-dispatch`, `sa-deliver`. |
| Process | Own PM2 app `smart-alerts-api` + `smart-alerts-worker`. Port 4310. |
| Code | No `require("../../api/...")`. Enforced by `scripts/check-isolation.js`. |
| Writes | **Never** writes to `agoraiq_signals` DB or any shared table. |
| Reads | Only `GET /api/internal/user-plan/:userId` on the main app (read-only, cached). |
| Inbound | HMAC-verified webhook `POST /api/internal/signals`. |

## Endpoints

User-facing (JWT required, plan-gated to Pro/Elite):
- `POST   /api/v1/alerts`             — create alert from plain English
- `GET    /api/v1/alerts`             — list caller's alerts
- `POST   /api/v1/alerts/:id/pause`
- `POST   /api/v1/alerts/:id/resume`
- `DELETE /api/v1/alerts/:id`
- `POST   /api/v1/alerts/test`        — dry-run a rule against a sample signal

Internal (HMAC or internal-key required):
- `POST   /api/internal/signals`      — signal ingestion webhook
- `GET    /api/internal/health`

## Local development

    cp .env.example .env
    npm install
    npm run migrate
    npm start          # port 4310
    npm run worker     # BullMQ delivery worker

## Production

    /opt/agoraiq-smart-alerts
    pm2 start ecosystem.config.js
    pm2 save

Caddy:

    reverse_proxy /api/smart-alerts/* 127.0.0.1:4310
