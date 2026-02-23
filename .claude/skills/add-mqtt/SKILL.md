---
name: add-mqtt
description: Add an embedded MQTT broker for local communication. No external services needed — any MQTT client can talk to the agent.
---

# Add MQTT Channel

This skill adds an embedded MQTT broker (Aedes) to NanoClaw. External clients (`mosquitto_pub`, MQTTX, phone apps, scripts) connect directly. No external broker needed.

**Topics:**
- `nanoclaw/in` — publish here to send a message to the agent
- `nanoclaw/out` — subscribe here to receive agent responses
- `nanoclaw/status` — retained message with agent status (online/offline)

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `mqtt` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-mqtt
```

This deterministically:
- Adds `src/channels/mqtt.ts` (MqttChannel class with embedded Aedes broker)
- Three-way merges MQTT support into `src/index.ts` (channel creation, auto-registration)
- Three-way merges MQTT config into `src/config.ts` (MQTT_PORT export)
- Installs the `aedes` npm dependency
- Updates `.env.example` with `MQTT_PORT`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

Optionally set a custom MQTT port in `.env` (default is 1883):

```bash
MQTT_PORT=1883
```

No other configuration is needed. MQTT starts automatically on every run.

## Phase 4: Verify

### Test from the terminal

```bash
# Listen for responses (in one terminal)
mosquitto_sub -h <host-ip> -t nanoclaw/out &

# Send a message
mosquitto_pub -h <host-ip> -t nanoclaw/in -m "hello"

# Check status
mosquitto_sub -h <host-ip> -t nanoclaw/status
```

Replace `<host-ip>` with `localhost` or the Pi's IP (e.g., `192.168.2.140`).

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep MQTT
```

## How It Works

- MQTT broker starts on every run (no feature flag)
- `mqtt:local` is auto-registered as main group if no main group exists (headless Pi use case)
- If a main group already exists (e.g., WhatsApp), MQTT still starts but `mqtt:local` must be registered manually via the normal group registration flow
- All existing channel routing via `findChannel()` works — MQTT's `ownsJid('mqtt:*')` handles dispatch

## Troubleshooting

### Port already in use

Another process is using port 1883. Either stop it or set a different port:

```bash
MQTT_PORT=1884
```

### Messages not arriving

1. Check nanoclaw is running: `tail -f logs/nanoclaw.log`
2. Check `mqtt:local` is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid = 'mqtt:local'"`
3. Try sending directly: `mosquitto_pub -h localhost -t nanoclaw/in -m "test"`
