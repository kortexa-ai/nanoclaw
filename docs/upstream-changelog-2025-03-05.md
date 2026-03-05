# Upstream Changelog (synced 2025-03-05)

Synced from `qwibitai/nanoclaw` main into `kortexa-ai/nanoclaw` main.
96 upstream commits merged. `kortexa/ssh-agents` rebased on top (41 commits, 5 version-bump duplicates dropped).

## Highlights

### New Skills
- **`/add-ollama`** — Local model inference via Ollama as an MCP tool (#712)
- **`/use-local-whisper`** — Local Whisper transcription instead of OpenAI API (#702)
- **`/add-slack`** — Slack channel integration (#366)
- **`/add-gmail`** — Gmail as a channel or agent tool (refactored for new skill architecture)
- **`/update-nanoclaw`** — Dedicated skill for syncing customized forks with upstream (#217)
- **Qodo integration** — `/qodo-pr-resolver` and `/get-qodo-rules` for AI code review (#428)

### Architecture Changes
- **Multi-channel architecture** (#500) — Channels (WhatsApp, Telegram, Discord, Slack, Gmail) are now pluggable via a registry (`src/channels/index.ts`, `src/channels/registry.ts`). WhatsApp moved to a skill (`add-whatsapp`).
- **Setup rewrite** (#382) — Bash setup scripts replaced with cross-platform Node.js modules in `setup/`.
- **Sender allowlist** (#705) — Per-chat access control via `src/sender-allowlist.ts`.
- **Apple Container support** — Alternative to Docker on macOS via `convert-to-apple-container` skill.
- **Group folder isolation** — New `src/group-folder.ts` with path escape blocking.
- **Skills engine cleanup** — Removed deterministic caching (`resolution-cache.ts`), old `/update` skill, CI matrix generation. Added skill drift detection and validation workflows.

### Security Fixes
- Block symlink escapes in skills file ops
- Block group folder path escapes
- Mount project root read-only to prevent container escape (#392)
- Prevent command injection in setup verify PID check
- Fix critical skills path-remap root escape including symlink traversal (#367)

### Notable Bug Fixes
- Atomic claim prevents scheduled tasks from executing twice (#657)
- Normalize wrapped WhatsApp messages before reading content (#628)
- Fix fetchLatestWaWebVersion to prevent 405 connection failures (#443)
- Pass host timezone to container; reject UTC-suffixed timestamps (#371)
- Shadow env fix in container (#646)
- Add CJK font support for Chromium screenshots
- Add `.catch()` handlers to fire-and-forget async calls (#355)

### CI/CD
- Renamed `test.yml` to `ci.yml`, added `skill-drift.yml`, `skill-pr.yml`, `bump-version.yml`
- Husky pre-commit hook added
- `.nvmrc` added (Node 22)

### Dependencies
- claude-agent-sdk updated to 0.2.68
