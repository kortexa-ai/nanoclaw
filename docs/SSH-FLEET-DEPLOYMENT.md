# SSH Fleet Deployment Guide

Learnings from first deployment on a 3-node Raspberry Pi fleet (Feb 2026).

## Fleet Topology

| Node | Hostname | IP | SSH Alias |
|------|----------|----|-----------|
| moodymoose | 192.168.2.140 | `140` | Orchestrator + agent node |
| happyhippo | 192.168.2.144 | `144` | Agent node |
| sneakysnake | 192.168.2.145 | `145` | Agent node |

All nodes: Raspberry Pi, aarch64, Debian, user `pi`, Node.js v25.x, Claude Code installed.

## SSH Key Setup

**Host → Pi:** Uses `~/.ssh/id_rsa_personal` (configured in host `~/.ssh/config`).

**Pi → Pi (inter-node):** Uses `~/.ssh/id_pi_cluster` — a separate key that only works between fleet nodes. Cannot SSH back to the host machine. Configured in each Pi's `~/.ssh/config`:

```
Host 140 141 142 143 144 145 146 147 148 149
  User                            pi
  Hostname                        192.168.2.%h
  IdentityFile                    ~/.ssh/id_pi_cluster

Host *
  StrictHostKeyChecking           no
  AddKeysToAgent                  yes
```

### Critical: Use Short Hostnames in Fleet Config

The fleet config (`data/ssh-fleet.json`) must use the **short hostname aliases** (e.g. `"host": "144"`) NOT raw IPs (e.g. `"host": "192.168.2.144"`).

Why: The orchestrator's `ssh-fleet.ts` constructs SSH commands as `ssh pi@<host>`. If `<host>` is a raw IP, it won't match the Pi's `~/.ssh/config` Host entries, so `IdentityFile` won't be applied, and SSH fails with `Permission denied (publickey)`.

```jsonc
// CORRECT — matches SSH config, picks up id_pi_cluster
{ "host": "144", "user": "pi", "port": 22 }

// WRONG — bypasses SSH config, auth fails
{ "host": "192.168.2.144", "user": "pi", "port": 22 }
```

## Claude Authentication

**No API key needed.** The agent-runner uses the Claude Agent SDK's `query()` function. It passes `{ ...process.env }` as `sdkEnv`. The SDK automatically reads OAuth credentials from `~/.claude/.credentials.json` (created when you run `claude` and log in interactively).

All Pis are logged in with Claude Max subscription. The credentials file looks like:
```json
{"claudeAiOauth":{"accessToken":"sk-ant-oat01-...","refreshToken":"sk-ant-ort01-...","expiresAt":...,"subscriptionType":"max"}}
```

The `readSecrets()` function in the orchestrator reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from the orchestrator's `.env` file and passes them to the agent via stdin. If neither is set, the SDK falls back to the local credentials file. This means:
- **For Pi fleet deployment:** No `.env` needed on the orchestrator. Each Pi uses its own OAuth login.
- **For Docker deployment:** The orchestrator needs credentials in `.env` since containers don't have Claude logged in.

## Deployment Steps

### 1. Clone and build on all nodes

```bash
# From each Pi (or via SSH from host):
ssh <node> 'mkdir -p ~/src && cd ~/src && git clone https://github.com/kortexa-ai/nanoclaw.git && cd nanoclaw && git checkout <branch>'

# Build orchestrator (only needed on orchestrator node):
ssh <orchestrator> 'cd ~/src/nanoclaw && npm install && npm run build'

# Build agent-runner (needed on ALL nodes):
ssh <node> 'cd ~/src/nanoclaw/ssh/agent-runner && npm install && npm run build'
```

### 2. Create workspace directories on all nodes

```bash
ssh <node> 'mkdir -p ~/nanoclaw-workspace'
```

The orchestrator also needs the groups directory:
```bash
ssh <orchestrator> 'mkdir -p ~/src/nanoclaw/groups'
```

### 3. Create fleet config on orchestrator

Write `data/ssh-fleet.json` on the orchestrator node. Key fields:

```json
{
  "nodes": [
    {
      "id": "moodymoose",
      "host": "140",
      "user": "pi",
      "port": 22,
      "agentRunnerPath": "/home/pi/src/nanoclaw/ssh/agent-runner/dist/index.js",
      "workspacePath": "/home/pi/nanoclaw-workspace",
      "maxConcurrentAgents": 2,
      "status": "online"
    }
  ],
  "meshSshKeyDistributed": true,
  "defaultScheduling": "least-loaded"
}
```

- `agentRunnerPath`: Absolute path to the compiled agent-runner entry point on the node.
- `workspacePath`: Where group directories are synced to/from on each node. Created by step 2.
- `maxConcurrentAgents`: Per-node concurrency limit. 2 is reasonable for Raspberry Pi.

### 4. Verify

```bash
# Health checks (from orchestrator):
ssh <orchestrator> 'cd ~/src/nanoclaw && node -e "
  import { loadFleetConfig, healthCheck } from \"./dist/ssh-fleet.js\";
  const c = loadFleetConfig();
  for (const n of c.nodes) { const ok = await healthCheck(n); console.log(n.id, ok ? \"OK\" : \"FAIL\"); }
"'

# Direct agent test (from any node):
echo '{"prompt":"Say hi","groupFolder":"test","chatJid":"t@t","isMain":false,"ipcMode":"stdio","groupWorkDir":"/tmp/test","ipcDir":"/tmp/test/ipc"}' | timeout 60 node ~/src/nanoclaw/ssh/agent-runner/dist/index.js
```

## How the SSH Flow Works

1. **Orchestrator** (`ssh-runner.ts`) calls `syncGroupToNode()` — rsyncs the group directory to the node's `workspacePath/<groupFolder>/`.
2. **Orchestrator** calls `spawnSshAgent()` — SSHes to the node and runs `node <agentRunnerPath>` with stdin/stdout piped.
3. **Orchestrator** writes the `ContainerInput` JSON + secrets as the first stdin line.
4. **Agent-runner** on the node reads stdin, runs `query()` from the Claude Agent SDK.
5. **Agent output** streams back as stdout markers (`OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`).
6. **IPC** (messages, tasks) relayed as stdout markers (`IPC_START_MARKER` / `IPC_END_MARKER`).
7. **Follow-up messages** sent as JSON lines on stdin (`{"type":"message","text":"..."}`).
8. **Close signal** sent as `{"type":"close"}` on stdin, agent winds down.
9. **Orchestrator** calls `syncGroupFromNode()` — rsyncs the group directory back.

## Known Issues / Gotchas

### Agent hangs in idle-wait after responding
The agent-runner enters an idle-wait loop after each query result, waiting for follow-up messages on stdin. In normal operation, the orchestrator's GroupQueue sends a close signal after the idle timeout. In tests, you must either send `{"type":"close"}` on stdin or use `timeout`.

### rsync requires workspace parent directory to exist
`syncGroupToNode()` uses `rsync --delete` which fails if the parent `workspacePath` doesn't exist on the target node. Create it before first use.

### Group directory must exist on orchestrator
`syncGroupToNode()` rsyncs from `groups/<folder>/` on the orchestrator. If the group folder doesn't exist locally, the rsync source path doesn't exist and the sync fails. The orchestrator creates it in `runSshAgent()` but only the base dir — `logs/` subdir may need manual creation for first run.

### Node.js version mismatch across fleet
140 has v25.0.0, 144/145 have v25.4.0. Not a problem currently but worth keeping in sync.

### esbuild/tsx doesn't work well on Pi for ad-hoc scripts
The `tsx` runtime and esbuild have issues with TypeScript non-null assertions (`!`) on the Pi. Use compiled `.js` from `dist/` or plain `.mjs` for test scripts.
