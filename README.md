# Nerova Agent

This repository hosts the split Nerova agent artifacts:

- `frontend/` – the local Playwright runner (CLI). Packages a `nerovaagent` command
  that spins up a browser, captures screenshots + hittables, calls the brain API,
  and executes the returned actions on the desktop.
- `backend/` – the universal “brain” service. Accepts prompts, screenshots, and
  element metadata and returns critic/assistant decisions without driving a
  browser directly.

## Backend (Brain)

```bash
cd backend
npm install
npm start        # listens on localhost:4000 by default
```

Endpoints:

- `POST /v1/brain/critic` – body `{ mode, prompt, screenshot, currentUrl, contextNotes, completeHistory, criticKey }`
  returns `{ decision, critic, completeHistory }`.
- `POST /v1/brain/assistant` – body `{ mode, prompt, target, elements, screenshot, assistantKey, assistantId }`
  returns `{ assistant }` with Step‑4 fallback output.

Additional modes (desktop, extensions, etc.) can reuse the same API surface.

## Frontend (CLI runner)

```bash
cd frontend
npm install
npx playwright install chromium
npx nerovaagent start "order coffee on doordash"
```

Environment / flags:

- `NEROVA_BRAIN_URL` or `--brain-url` to point at the backend.
- `--prompt-file`, `--context`, `--assistant-key`, `--assistant-id`, etc.

The CLI performs STEP3 (radius + exact match) locally; when no candidate is
found it calls `/v1/brain/assistant` so the brain can run the Step‑4 resolution.

## Packaging

- Ship `frontend/` as the downloadable artifact (`curl … | bash` installer).
- Deploy `backend/` to the server (or container) that hosts your decision-making
  service.

With this split, multiple frontends (browser extension, desktop automation,
etc.) can share the same brain service by supplying inputs in the defined
format and executing the actions they receive back.
