## Overview

qa-pi bridges Model Context Protocol (MCP) servers into pi as native tools. The bridge extension reads `~/.qapi/agent/qa-mcp.json` at session start, spawns each enabled server over stdio, performs the MCP `initialize` handshake, and registers each server tool as `mcp_<server>_<tool>` in pi's tool registry. Subagents access only the MCP tools listed in their frontmatter.

This document covers the default config, per-MCP setup, env handling, custom additions, and troubleshooting.

## Default config

`~/.qapi/agent/qa-mcp.json`:

```json
{
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "passEnv": [],
      "lazy": false,
      "enabled": true
    },
    "chrome_devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "passEnv": [],
      "lazy": true,
      "enabled": true
    },
    "axe": {
      "command": "npx",
      "args": ["-y", "@qa-pi/axe-mcp@latest"],
      "passEnv": [],
      "lazy": true,
      "enabled": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${CWD}", "${HOME}/Documents"],
      "passEnv": [],
      "enabled": true
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "${CWD}"],
      "passEnv": [],
      "enabled": true
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "passEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      "enabled": true
    },
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time", "--local-timezone=UTC"],
      "passEnv": [],
      "enabled": true
    },
    "nuclei": {
      "command": "npx",
      "args": ["-y", "@qa-pi/nuclei-mcp@latest"],
      "passEnv": [],
      "enabled": true
    }
  },
  "envAllowlist": ["PATH", "HOME", "LANG", "TMPDIR"]
}
```

`${CWD}` and `${HOME}` are expanded by the bridge before spawn. Anything not listed in `envAllowlist` or per-server `passEnv` is stripped from the child env.

## Per-MCP Setup

### Playwright (`@playwright/mcp`)

- **Package**: `@playwright/mcp`
- **Command**: `npx -y @playwright/mcp@latest`
- **Env**: none required. Optional `PLAYWRIGHT_BROWSERS_PATH` if you want a shared browser cache.
- **Verify**:
  ```bash
  npx -y @playwright/mcp@latest --help
  npx playwright install chromium
  ```
- **Used by**: `qa-web`, `qa-visual`, `qa-perf`, `qa-redteam`.

### Chrome DevTools (`chrome-devtools-mcp`)

- **Package**: `chrome-devtools-mcp`
- **Command**: `npx -y chrome-devtools-mcp@latest`
- **Env**: optional `CHROME_PATH` to pin a specific Chrome binary.
- **Verify**:
  ```bash
  google-chrome --version || chromium --version
  npx -y chrome-devtools-mcp@latest --help
  ```
- **Used by**: `qa-perf`.

### axe (wrapper)

- **Package**: `@qa-pi/axe-mcp` (thin wrapper around `axe-core` + `@axe-core/playwright`).
- **Command**: `npx -y @qa-pi/axe-mcp@latest`
- **Env**: none.
- **Verify**:
  ```bash
  npx -y @qa-pi/axe-mcp@latest --self-test
  ```
- **Used by**: `qa-visual`.

### Filesystem (`@modelcontextprotocol/server-filesystem`)

- **Package**: `@modelcontextprotocol/server-filesystem`
- **Command**: `npx -y @modelcontextprotocol/server-filesystem <allowed-dir> [<allowed-dir>...]`
- **Env**: none.
- **Verify**:
  ```bash
  npx -y @modelcontextprotocol/server-filesystem "$PWD" --help
  ```
- **Used by**: `qa-planner` (reading specs outside cwd).

### Git (`@modelcontextprotocol/server-git`)

- **Package**: `@modelcontextprotocol/server-git`
- **Command**: `npx -y @modelcontextprotocol/server-git --repository <path>`
- **Env**: none.
- **Verify**:
  ```bash
  npx -y @modelcontextprotocol/server-git --repository "$PWD" --help
  ```
- **Used by**: `qa-planner`.

### GitHub (`@modelcontextprotocol/server-github`)

- **Package**: `@modelcontextprotocol/server-github`
- **Command**: `npx -y @modelcontextprotocol/server-github`
- **Env**: requires `GITHUB_PERSONAL_ACCESS_TOKEN` with `repo` + `read:org` scopes.
- **Verify**:
  ```bash
  export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
  npx -y @modelcontextprotocol/server-github --self-test
  ```
- **Used by**: optional, any subagent that opens issues/PRs (typically driven by post-run hooks rather than direct subagent calls in the default config — add to a subagent's `tools:` line if you want it).

### Time (`mcp-server-time`)

- **Package**: `mcp-server-time` (Python, install via `uv` / `uvx`).
- **Command**: `uvx mcp-server-time --local-timezone=UTC`
- **Env**: none.
- **Verify**:
  ```bash
  uvx mcp-server-time --help
  ```
  Install `uv` first: `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- **Used by**: any subagent for stable timestamps in artifact filenames.

### nuclei (wrapper)

- **Package**: `@qa-pi/nuclei-mcp` (wraps the `nuclei` binary).
- **Command**: `npx -y @qa-pi/nuclei-mcp@latest`
- **Prereq**: `nuclei` binary on `$PATH`:
  ```bash
  go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
  nuclei -update-templates
  ```
- **Verify**:
  ```bash
  nuclei -version
  npx -y @qa-pi/nuclei-mcp@latest --self-test
  ```
- **Used by**: `qa-security`, `qa-redteam`.

## Custom MCP additions

Append to `servers` in `qa-mcp.json`:

```json
"my_tool": {
  "command": "node",
  "args": ["/abs/path/to/my-mcp-server.js"],
  "passEnv": ["MY_API_KEY"],
  "tools": ["search", "fetch"],
  "enabled": true
}
```

- `tools` is an optional allowlist filter — only listed tools from that server become pi tools.
- After registration, the tool is callable as `mcp_my_tool_search`. Add it to a subagent's frontmatter `tools:` line to grant access.

## Security-filtered env passing

Bridge constructs the child env as:

```
child_env = pick(parent_env, envAllowlist) ∪ pick(parent_env, server.passEnv)
```

Defaults: `PATH`, `HOME`, `LANG`, `TMPDIR`. Anything else (including `ANTHROPIC_API_KEY`, `AWS_*`, your shell aliases) is stripped unless explicitly opted in. This prevents an MCP server from exfiltrating credentials it has no business seeing.

## Troubleshooting

### `npx: command not found` inside spawned MCP

The bridge inherits `PATH` from your shell. If your Node is managed by `nvm`/`asdf`/`volta`, ensure your launching shell has it active. Alternatively pin an absolute path:

```json
"command": "/home/me/.nvm/versions/node/v20.11.0/bin/npx"
```

### GitHub MCP auth failures (`401`)

Check token scopes and that `passEnv` includes `GITHUB_PERSONAL_ACCESS_TOKEN`:

```bash
curl -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" https://api.github.com/user
```

### Port conflicts (Playwright / Chrome DevTools)

Both spawn local browsers. If a previous session leaked a Chrome on a debug port:

```bash
pgrep -af "chrome.*--remote-debugging-port"
pkill -f "chrome.*--remote-debugging-port"
```

The bridge is supposed to clean up via process-group SIGTERM; check `~/.qapi/logs/bridge.log` if leaks recur.

### MCP server hangs or stops responding

The bridge healthchecks every 30s and auto-restarts. To force a reset:

```bash
qa-pi -p "/qa-mcp restart <server>"
```

Or kill the whole tree manually:

```bash
pkill -g $(pgrep -f "qa-pi")
```

(Process-group kill — relies on the orchestrator setting its own pgid at startup.)

### `uvx: command not found`

Install uv (Astral): `curl -LsSf https://astral.sh/uv/install.sh | sh`. Re-source your shell rc.

### nuclei templates out of date

```bash
nuclei -update-templates
```

The wrapper will warn at startup if templates are >30 days old.

### Verbose bridge logs

```bash
QAPI_LOG=debug qa-pi
tail -f ~/.qapi/logs/bridge.log
```
