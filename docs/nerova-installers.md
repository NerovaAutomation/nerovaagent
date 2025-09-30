# Nerova Agent/Streamer Installers

This repo now ships two standalone CLI packages to make it easier to pre-bake Fly
Machines (or any Linux host) with the runtime components that were previously
only available via `node server.js`.

## Packages

| Package | CLI | Purpose |
| ------- | --- | ------- |
| `@nerova/streamer` | `nerovastream` | Bootstraps the browser runtime, verifies health, and exposes helper commands used by the `/ui` embed. |
| `@nerova/agent` | `nerovaagent` | Triggers the no-planner agent loop against the local runtime for a given prompt. |

Both packages are wired into the root `package.json` via `file:` dependencies and
are available after `npm install`. They live under `packages/nerovastreamer` and
`packages/nerovaagent` respectively.

## Build once, install anywhere

1. **Build the bundle** on a machine that has network access and the system
   packages your runtime needs (Xvfb, ffmpeg, xpra, etc.). Run:

   ```bash
   # Agent-only bundle
   NEROVA_FLAVOR=agent bash scripts/build-nerova-release.sh

   # Streamer-only bundle
   NEROVA_FLAVOR=streamer bash scripts/build-nerova-release.sh
   ```

   This stages the repo under `dist/stage-<platform>-<arch>/`, runs
   `npm install --omit=dev` and `npx playwright install chromium`, then emits:

   - `dist/nerova-agent-<rev>-<platform>-<arch>.tar.gz`
   - `dist/nerova-agent-<rev>-<platform>-<arch>.sh`
   - `dist/nerova-streamer-<rev>-<platform>-<arch>.tar.gz`
   - `dist/nerova-streamer-<rev>-<platform>-<arch>.sh`

   Upload one or both artifacts to static hosting (S3, GitHub Releases, Fly
   asset volume, etc.). No application server is required—the files are static.

2. **Host a thin bootstrap script** (see `installers/nerovaagent.sh`). End-users
   can then run:

   ```bash
   curl -fsSL https://install.nerova.run/agent | bash
   ```

   The bootstrap downloads the self-extracting bundle and installs it into
   `/opt/nerova`, wiring `nerovaagent` and `nerovastream` into `/usr/local/bin`.

## Installer scripts

Two helper scripts wrap the packaging step so we can curl|bash a single command
when provisioning a new machine:

- `scripts/install-nerovastream.sh` / `scripts/install-nerovaagent.sh` – legacy
  scripts that copied the repo and ran `npm install` on the target. These
  remain for debugging but you should prefer the prebuilt bundle workflow above.
- `installers/nerovaagent.sh` – thin wrapper suitable for `curl | bash`. It
  expects `NEROVA_RELEASE_URL` to point at the hosted self-extracting bundle and
  defaults to a placeholder CDN URL.

Example usage (run from the repo root during image build):

```bash
bash scripts/install-nerovastream.sh /opt/nerova/streamer
```

After installation you can interact with the runtime:

```bash
nerovaagent playwright-launch     # warm the local runtime
nerovaagent start "order coffee on doordash"
nerovastream start                # optional viewer stream
```

### Hosting installers

The scripts are written so they can be hosted and invoked via a one-liner. For
example, once `scripts/install-nerovastream.sh` is published somewhere public,
users can run:

```bash
curl -fsSL https://nerova.run/install/nerovastream | bash
```

The script expects outbound network access for `npm install`. If that is not
available (e.g., inside a locked-down Fly build), pre-bake dependencies into the
image or run the script in an environment with cached npm artifacts.

## Runtime endpoints for CLIs

`server.js` now exposes:

- `GET /healthz` – returns uptime, machine metadata, and Playwright availability.
- `POST /runtime/playwright/launch` – calls the same `ensureBrowser()` helper the
  UI uses so we can warm the browser before handing control to the agent.

These endpoints are what the CLIs hit under the hood.

## Docker integration

The Dockerfile copies `packages/` before `npm install` to ensure local `file:`
links resolve correctly. No other changes are required.
