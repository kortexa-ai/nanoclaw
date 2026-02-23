---
name: setup-pi-fleet
description: Set up a Raspberry Pi fleet for running agents via SSH instead of Docker containers. Use when user wants to add Pis as agent execution nodes, configure SSH connectivity, or manage their Pi fleet.
---

# Pi Fleet Setup

Configure Raspberry Pis as agent execution nodes. The orchestrator SSHs to Pis to spawn agents instead of using Docker containers.

**Architecture:**
```
Orchestrator (this machine)
  ├── SSH → Pi-1 (agent processes)
  ├── SSH → Pi-2 (agent processes)
  └── SSH → Pi-3 (agent processes)
```

- Orchestrator → Pi: passwordless SSH (one-way)
- Pi ↔ Pi: passwordless SSH (mesh, for agent teams)
- Pi → Orchestrator: no SSH access

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Collect Pi Information

Ask the user for their Pi details:
- Hostname or IP address
- SSH user (default: `pi`)
- SSH port (default: `22`)
- A friendly ID name (e.g., `pi-1`, `pi-kitchen`)

Allow adding multiple Pis. Use `AskUserQuestion` with options like "Add another Pi" / "Done adding Pis".

## 2. Test SSH Connectivity

For each Pi, test SSH connectivity:

```bash
ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p PORT USER@HOST 'echo ok'
```

If any Pi fails:
- Report which Pis are unreachable
- Suggest: "Make sure passwordless SSH is set up: `ssh-copy-id USER@HOST`"
- Ask if user wants to retry or skip unreachable Pis

## 3. Bootstrap Each Pi

For each reachable Pi, run these steps automatically:

### a. Check/Install Node.js
```bash
ssh USER@HOST 'node --version || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs)'
```

### b. Clone/Update NanoClaw
```bash
ssh USER@HOST 'test -d ~/src/nanoclaw && (cd ~/src/nanoclaw && git pull) || git clone REPO_URL ~/src/nanoclaw'
```
Get the repo URL from this machine: `git -C /Users/francip/src/nanoclaw remote get-url origin`

### c. Install Claude CLI
```bash
ssh USER@HOST 'which claude || npm i -g @anthropic-ai/claude-code'
```

### d. Build Agent Runner
```bash
ssh USER@HOST 'cd ~/src/nanoclaw/ssh/agent-runner && npm install && npm run build'
```

### e. Create Workspace
```bash
ssh USER@HOST 'mkdir -p ~/workspace'
```

Report progress for each step. If any step fails, log the error and ask if the user wants to retry or skip that Pi.

## 4. Set Up Mesh SSH Keys (Pi ↔ Pi)

For agent teams to work, Pis need to SSH to each other:

### a. Generate keys on each Pi (if not present)
```bash
ssh USER@HOST 'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""'
```

### b. Collect public keys
```bash
ssh USER@HOST 'cat ~/.ssh/id_ed25519.pub'
```

### c. Distribute to all other Pis
For each Pi, add all other Pis' public keys to `~/.ssh/authorized_keys`:
```bash
ssh USER@HOST 'echo "PUBLIC_KEY" >> ~/.ssh/authorized_keys && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys'
```

**Important:** Do NOT add the orchestrator's key to Pis from the Pi side. The one-way SSH is already set up (orchestrator → Pi only).

## 5. Verify

Run a test agent on each Pi to confirm stdio IPC works:

```bash
echo '{"prompt":"Say hello","groupFolder":"test","chatJid":"test","isMain":false,"ipcMode":"stdio"}' | ssh USER@HOST 'node ~/src/nanoclaw/ssh/agent-runner/dist/index.js'
```

Check that:
- The process starts without errors
- Output markers appear in stdout
- The process exits cleanly (it will error without API keys, that's OK — we just need to verify the runner starts)

## 6. Save Configuration

Write the fleet config to `data/ssh-fleet.json`:

```json
{
  "nodes": [
    {
      "id": "pi-1",
      "host": "192.168.1.101",
      "user": "pi",
      "port": 22,
      "agentRunnerPath": "~/src/nanoclaw/ssh/agent-runner/dist/index.js",
      "workspacePath": "~/workspace",
      "maxConcurrentAgents": 2,
      "status": "online"
    }
  ],
  "meshSshKeyDistributed": true,
  "defaultScheduling": "least-loaded"
}
```

Use `fs.writeFileSync` via Bash to write the file. The `maxConcurrentAgents` default is 2 per Pi — ask the user if they want to change this.

## 7. Confirm

Tell the user:
- How many Pis were configured
- That agents will now run on Pis instead of Docker
- They should restart NanoClaw for changes to take effect: `npm run dev` or reload the launchd service
- To add more Pis later, run this skill again
