# Nerova Agent Backend

This package hosts the universal Nerova Agent runtime server. It exposes the same `/ui` and `/noplanner` interfaces used by the desktop bundle, making it straightforward to deploy the agent once and reuse it from the CLI or browser UI.

## Getting Started

```bash
npm install
npm run start
```

Configuration is handled via environment variables (for example `NEROVA_AGENT_PORT`, `FLY_MACHINE_TOKEN`, `PLAYWRIGHT_BOOT_URL`). See `server.js` for the full list. Static assets live under `public/` and `data/` mirrors the recipe storage used by the local runtime.

## Deployment Notes

- The service requires system packages for Playwright browsers and FFmpeg when the WebRTC relay is enabled.
- The `user-data/` directory is created at runtime to persist the Playwright context; it is ignored by git by default.
- When running behind Fly.io, set `FLY_MACHINE_TOKEN`, `WORKER_IMAGE`, `WORKER_REGION`, and `WORKER_APP_HOST` so `/machines/start` can provision workers on demand.
