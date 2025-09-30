# webagent-signaler

A lightweight signaling + TURN broker for the WebAgent stack. It issues
short-lived JWT session tokens, generates coturn credentials, and forwards
WebRTC signaling requests to the correct worker machine.

## Environment variables

Required:

- `SIGNAL_JWT_SECRET` – HMAC secret for viewer session tokens.
- `TURN_SHARED_SECRET` – shared secret for coturn REST authentication.
- `SIGNAL_PUBLIC_HOST` – public hostname clients use (e.g. `signal.example.com`).
- `WORKER_HTTP_BASE` – public base URL for worker machines (default
  `https://webagent-worker.fly.dev`).

Optional:

- `TURN_PORT` (default `3478`)
- `TURN_TLS_PORT` (default `5349` – disable TLS by omitting cert/key)
- `TURN_REALM` (default `signal.fly`)
- `TURN_MIN_PORT` / `TURN_MAX_PORT`
- `TURN_TTL_SECONDS` (default `600`)
- `SIGNAL_SESSION_TTL_SECONDS` (default `300`)
- `SIGNAL_ALLOWED_PATHS` (comma separated list of worker endpoints)
- `TURN_CERT_FILE` / `TURN_KEY_FILE` (for TLS – mount via secrets/volumes)

## API

### `POST /sessions`

Request body:

```json
{
  "machineId": "<fly machine id>",
  "ttlSeconds": 300
}
```

Response:

```json
{
  "ok": true,
  "machineId": "<id>",
  "signaling": {
    "url": "wss://signal.example.com/signal",
    "token": "<jwt>",
    "expiresIn": 300
  },
  "ice": {
    "iceServers": [ ... ],
    "ttl": 600
  }
}
```

Clients connect to the `signaling.url` via WebSocket, passing the `token`
in the query string (`wss://.../signal?token=...`).

### WebSocket `/signal`

Messages are JSON objects.

Request:

```json
{
  "id": "unique-request-id",
  "type": "request",
  "method": "POST",
  "path": "/webrtc/offer",
  "body": {}
}
```

Response:

```json
{
  "id": "unique-request-id",
  "type": "response",
  "ok": true,
  "status": 200,
  "body": { ... }
}
```

Only paths listed in `SIGNAL_ALLOWED_PATHS` are proxied. Requests are
forwarded to the worker with the proper `Fly-Machine` header and
`fly_machine` query parameter.

## Deploying

1. Set required secrets:
   ```bash
   fly secrets set \
     SIGNAL_JWT_SECRET=... \
     TURN_SHARED_SECRET=... \
     SIGNAL_PUBLIC_HOST=signal.example.com \
     WORKER_HTTP_BASE=https://webagent-worker.fly.dev \
     --app webagent-signaler
   ```

2. Deploy:
   ```bash
   fly deploy --app webagent-signaler --remote-only
   ```

3. Allocate TLS certificates / DNS for `SIGNAL_PUBLIC_HOST` and ensure
   ports 3478/5349 are permitted through your firewall.

## TURN TLS

If you want `turns:` support, mount a certificate/key pair inside the
container and set `TURN_CERT_FILE`/`TURN_KEY_FILE` to their paths. Without
TLS the server still provides UDP/TCP TURN on port 3478 and STUN.

## Logs

- Signaling logs are printed via `pino` on stdout.
- coturn logs are written to `/var/log/turnserver.log` inside the
  container (visible through `fly logs`).
