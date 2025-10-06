# Nerova Agent Runtime

This repository packages the Nerova agent CLI into a self-contained installer.

## Building installers via GitHub Actions

- Workflow: `.github/workflows/build-agent-installers.yml`
- Trigger: push a tag like `agent-v0.1.0` or run manually in Actions UI
- Outputs: `nerova-agent-<tag>-<platform>-<arch>.sh` attached to the release

## Public installer command

```bash
curl -fsSL https://install.nerova.run/agent | bash
```

By default installs into `/opt/nerova` and symlinks `nerovaagent` into
`/usr/local/bin`. The CLI now targets the hosted runtime at
`http://ec2-3-92-220-237.compute-1.amazonaws.com:3333`. To point it elsewhere,
set `NEROVA_AGENT_HTTP` before running commands.

To install without sudo:

```bash
NEROVA_HOME="$HOME/.nerova" \
NEROVA_BIN="$HOME/.local/bin" \
curl -fsSL https://install.nerova.run/agent | bash
```

## Using the CLI

```bash
nerovaagent playwright-launch
nerovaagent start "order coffee on doordash"
nerovaagent status
```

The CLI spins up a minimal Express server that exposes `/runtime/playwright/launch`,
`/run/start`, and `/healthz` so the agent workflow can operate.
