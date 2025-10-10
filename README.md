# Nerova Agent – split brain/runtime

The project is now organised so the decision-making “brain” runs independently
from the Playwright-based executor. Two folders live under `apps/`:

- `nerovaagent/backend` – Express service that takes a prompt, screenshot and hittables
  and responds with the next action. It never drives the browser directly.
- `nerovaagent/frontend` – Node CLI that launches a local Playwright session, captures
  screenshots/candidates, calls the brain API, and applies the returned action.

## Getting started

Open two terminals:

1. Start the brain service (defaults to `http://127.0.0.1:4000`):

   ```bash
  npm install --prefix nerovaagent/backend
  npm start --prefix nerovaagent/backend
   ```

   The brain exposes simple JSON endpoints:

   - `POST /v1/brain/critic` — `{ mode, prompt, screenshot, currentUrl, contextNotes, completeHistory, criticKey }`
     returns `{ decision, critic, completeHistory }`.
   - `POST /v1/brain/assistant` — `{ mode, prompt, target, elements, screenshot, assistantKey, assistantId }`
     returns `{ assistant }` containing Step‑4 fallback output.

   Additional modes (e.g. `desktop`) can be layered on via the same interface.

2. Run the CLI executor against the brain:

   ```bash
  npm install --prefix nerovaagent/frontend
  npx --prefix nerovaagent/frontend nerovaagent start "order coffee on doordash"
   ```

   Use `NEROVA_BRAIN_URL` or `--brain-url` to point at a remote brain instance.

## CLI options

```
nerovaagent start "<prompt>"
  --prompt-file <path>     read the prompt from a file
  --context <text>         optional context notes sent with each step
  --context-file <path>    load context notes from a file
  --brain-url <url>        override brain endpoint (default http://127.0.0.1:4000)
  --critic-key <key>       critic OpenAI key override
  --assistant-key <key>    assistant OpenAI key override
  --assistant-id <id>      assistant id override
  --boot-url <url>         navigate before starting the loop
  --max-steps <n>          iteration cap (default 10)
```

The CLI keeps Playwright local, so the same runtime can be reused inside other
projects by swapping in a different frontend executor while pointing at the
shared brain service. The local executor performs STEP3 (radius/ exact-match)
selection, and when no hit is found it calls `/v1/brain/assistant` so the brain
can run the Step‑4 resolver; the CLI then applies the returned action to the
browser.
