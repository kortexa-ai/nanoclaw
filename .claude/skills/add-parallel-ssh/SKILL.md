# Add Parallel AI Integration (SSH Fleet)

Adds Parallel AI MCP integration to NanoClaw's SSH fleet agents for advanced web research capabilities.

## What This Adds

- **Quick Search** - Fast web lookups using Parallel Search API (free to use)
- **Deep Research** - Comprehensive analysis using Parallel Task API (asks permission)
- **Non-blocking Design** - Uses NanoClaw scheduler for result polling (no agent blocking)

## Prerequisites

User must have:
1. Parallel AI API key from https://platform.parallel.ai
2. NanoClaw already set up with SSH fleet (`data/ssh-fleet.json` exists)
3. Pi nodes reachable via SSH

## Implementation Steps

Run all steps automatically. Only pause for user input when explicitly needed.

### 1. Get Parallel AI API Key

Use `AskUserQuestion: Do you have a Parallel AI API key, or should I help you get one?`

**If they have one:**
Collect it now.

**If they need one:**
Tell them:
> 1. Go to https://platform.parallel.ai
> 2. Sign up or log in
> 3. Navigate to API Keys section
> 4. Create a new API key
> 5. Copy the key and paste it here

Wait for the API key.

### 2. Add API Key to Environment

Add `PARALLEL_API_KEY` to `.env` on the orchestrator:

```bash
# Check if .env exists, create if not
if [ ! -f .env ]; then
    touch .env
fi

# Add PARALLEL_API_KEY if not already present
if ! grep -q "PARALLEL_API_KEY=" .env; then
    echo "PARALLEL_API_KEY=${API_KEY_FROM_USER}" >> .env
    echo "Added PARALLEL_API_KEY to .env"
else
    # Update existing key
    sed -i.bak "s/^PARALLEL_API_KEY=.*/PARALLEL_API_KEY=${API_KEY_FROM_USER}/" .env
    echo "Updated PARALLEL_API_KEY in .env"
fi
```

### 3. Update Secret Passthrough

The orchestrator reads secrets from `.env` and passes them to SSH agents via stdin.
Add `PARALLEL_API_KEY` to the allowed secrets list.

In `src/container-runner.ts`, find `readSecrets()`:
```typescript
export function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}
```

Add `PARALLEL_API_KEY` to the array:
```typescript
export function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'PARALLEL_API_KEY']);
}
```

This ensures the key flows: `.env` → orchestrator → stdin JSON → SSH agent runner.

### 4. Configure MCP Servers in SSH Agent Runner

Update `ssh/agent-runner/src/index.ts`.

Find the MCP config section (around line 383-399) where `mcpConfig` is built:
```typescript
const mcpConfig = JSON.stringify({
  mcpServers: {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        NANOCLAW_IPC_DIR: IPC_DIR,
      },
    },
  },
});
```

Replace with:
```typescript
const mcpServers: Record<string, unknown> = {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      NANOCLAW_IPC_DIR: IPC_DIR,
    },
  },
};

// Add Parallel AI MCP servers if API key was passed via secrets
const parallelApiKey = containerInput.secrets?.PARALLEL_API_KEY;
if (parallelApiKey) {
  mcpServers['parallel-search'] = {
    type: 'http',
    url: 'https://search-mcp.parallel.ai/mcp',
    headers: {
      'Authorization': `Bearer ${parallelApiKey}`,
    },
  };
  mcpServers['parallel-task'] = {
    type: 'http',
    url: 'https://task-mcp.parallel.ai/mcp',
    headers: {
      'Authorization': `Bearer ${parallelApiKey}`,
    },
  };
  log('Parallel AI MCP servers configured');
} else {
  log('No PARALLEL_API_KEY in secrets, skipping Parallel AI');
}

const mcpConfig = JSON.stringify({ mcpServers });
```

**IMPORTANT:** The API key comes from `containerInput.secrets` (passed via stdin from the orchestrator), NOT from `process.env`. This follows the existing security model where secrets stay off disk and out of environment variables.

### 5. Update Allowed Tools in SSH Agent Runner

In `ssh/agent-runner/src/index.ts`, find the `allowedTools` array (around line 287):
```typescript
const allowedTools = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];
```

Add the Parallel MCP tool wildcards:
```typescript
const allowedTools = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__parallel-search__*',
  'mcp__parallel-task__*',
];
```

### 6. Add Usage Instructions to CLAUDE.md

Add Parallel AI usage instructions to `groups/main/CLAUDE.md`.

Find the "## What You Can Do" section and add after the existing bullet points:
```markdown
- Use Parallel AI for web research and deep learning tasks
```

Then add a new section after "## What You Can Do":
```markdown
## Web Research Tools

You have access to two Parallel AI research tools:

### Quick Web Search (`mcp__parallel-search__search`)
**When to use:** Freely use for factual lookups, current events, definitions, recent information, or verifying facts.

**Examples:**
- "Who invented the transistor?"
- "What's the latest news about quantum computing?"
- "What are the top programming languages in 2026?"

**Speed:** Fast (2-5 seconds)
**Cost:** Low
**Permission:** Not needed - use whenever it helps answer the question

### Deep Research (`mcp__parallel-task__create_task_run`)
**When to use:** Comprehensive analysis, learning about complex topics, comparing concepts, historical overviews, or structured research.

**Examples:**
- "Explain the development of quantum mechanics from 1900-1930"
- "Compare the literary styles of Hemingway and Faulkner"
- "Research the evolution of jazz from bebop to fusion"

**Speed:** Slower (1-20 minutes depending on depth)
**Cost:** Higher (varies by processor tier)
**Permission:** ALWAYS use `AskUserQuestion` before using this tool

**How to ask permission:**
```
AskUserQuestion: I can do deep research on [topic] using Parallel's Task API. This will take 2-5 minutes and provide comprehensive analysis with citations. Should I proceed?
```

**After permission - DO NOT BLOCK! Use scheduler instead:**

1. Create the task using `mcp__parallel-task__create_task_run`
2. Get the `run_id` from the response
3. Create a polling scheduled task using `mcp__nanoclaw__schedule_task`:
   ```
   Prompt: "Check Parallel AI task run [run_id] and send results when ready.

   1. Use the Parallel Task MCP to check the task status
   2. If status is 'completed', extract the results
   3. Send results to user with mcp__nanoclaw__send_message
   4. Use mcp__nanoclaw__complete_scheduled_task to mark this task as done

   If status is still 'running' or 'pending', do nothing (task will run again in 30s).
   If status is 'failed', send error message and complete the task."

   Schedule: interval every 30 seconds
   Context mode: isolated
   ```
4. Send acknowledgment with tracking link
5. Exit immediately - scheduler handles the rest

### Choosing Between Them

**Use Search when:**
- Question needs a quick fact or recent information
- Simple definition or clarification
- Current events or news

**Use Deep Research (with permission) when:**
- User wants to learn about a complex topic
- Question requires analysis or comparison
- User explicitly asks to "research" or "explain in depth"

**Default behavior:** Prefer search for most questions. Only suggest deep research when the topic genuinely requires comprehensive analysis.
```

### 7. Build and Deploy to Fleet

Build the orchestrator:
```bash
npm run build
```

Build agent-runner locally (for syntax check):
```bash
cd ssh/agent-runner && npm run build && cd ../..
```

Deploy agent-runner to each fleet node. For each node in `data/ssh-fleet.json`:
```bash
# Sync the updated agent-runner to the node
rsync -az ssh/agent-runner/ ${NODE_HOST}:~/nanoclaw/ssh/agent-runner/

# Rebuild on the node
ssh ${NODE_HOST} "cd ~/nanoclaw/ssh/agent-runner && PATH=\$HOME/.nvm/versions/node/v25.0.0/bin:\$PATH npm run build"
```

Then restart the orchestrator:
```bash
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 8. Test Integration

Tell the user to test:
> Send a message to your assistant: `@[YourAssistantName] what's the latest news about AI?`
>
> The assistant should use Parallel Search API to find current information.
>
> Then try: `@[YourAssistantName] can you research the history of artificial intelligence?`
>
> The assistant should ask for permission before using the Task API.

Check logs to verify MCP servers loaded:
```bash
# On the node that ran the agent, check agent-runner logs
tail -20 groups/main/logs/container-*.log
```

Look for: `Parallel AI MCP servers configured`

## Troubleshooting

**Agent doesn't see Parallel tools:**
- Check that `PARALLEL_API_KEY` is in `.env` on the orchestrator
- Verify `readSecrets()` in `container-runner.ts` includes `PARALLEL_API_KEY`
- The key is passed via `containerInput.secrets`, not via environment — check the SSH agent runner's MCP config logic

**HTTP MCP server fails to connect:**
- Ensure Pi nodes have internet access
- Verify the API key is valid: `curl -H "Authorization: Bearer $KEY" https://search-mcp.parallel.ai/mcp`
- Check that `type: 'http'` is specified in MCP server config

**Task polling not working:**
- Verify scheduled task was created: `sqlite3 store/messages.db "SELECT * FROM scheduled_tasks"`
- Check task runs: `tail -f logs/nanoclaw.log | grep "scheduled task"`
- Ensure task prompt includes proper Parallel MCP tool names

## Uninstalling

To remove Parallel AI integration:

1. Remove from `.env`: `sed -i.bak '/PARALLEL_API_KEY/d' .env`
2. Revert `readSecrets()` in `src/container-runner.ts`
3. Revert MCP config and allowedTools in `ssh/agent-runner/src/index.ts`
4. Remove Web Research Tools section from `groups/main/CLAUDE.md`
5. Rebuild and deploy: `npm run build && cd ssh/agent-runner && npm run build`
6. Sync updated agent-runner to fleet nodes
7. Restart: `systemctl --user restart nanoclaw`
