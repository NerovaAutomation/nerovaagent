# Nerova Agent Installer

The `nerovaagent` CLI is available as a self-contained installer so any machine
can run the agent without additional setup.

## How it works

1. **GitHub Actions builds the installers** (`.github/workflows/build-agent-installers.yml`).
   When you push a tag like `agent-v0.2.0` (or trigger the workflow manually),
   the action builds the agent bundle for:
   - Linux: `amd64` and `arm64`
   - macOS: `arm64`

   Each build produces `nerova-agent-<tag>-<platform>-<arch>.sh` and uploads it
   to the corresponding GitHub release.

2. **The public bootstrap script** (`install-site/agent`) detects the caller's
   OS/arch, fetches the matching asset from the latest (or requested) release,
   downloads it, and runs the installer. The standard entry point is:

   ```bash
   curl -fsSL https://install.nerova.run/agent | bash
   ```

3. **Install location overrides** – The installer defaults to `/opt/nerova`
   with symlinks in `/usr/local/bin`. To install without `sudo`, set the env vars
   before running the curl command:

   ```bash
   NEROVA_HOME="$HOME/.nerova" \
   NEROVA_BIN="$HOME/.local/bin" \
   curl -fsSL https://install.nerova.run/agent | bash
   ```

## After installation

```bash
nerovaagent playwright-launch     # warm the Playwright browser
nerovaagent start "order coffee on doordash"  # run a prompt against the agent
```

The CLI bundles Node, Playwright Chromium, and the agent runtime, so no other
setup is required. Once the streamer is packaged the same curl-based workflow
will be extended to cover `nerovastream` as well.
