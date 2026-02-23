# Intent: src/index.ts modifications

## What changed
Added embedded MQTT broker as an always-on local communication channel with auto-registration of `mqtt:local` as main group.

## Key sections

### Imports (top of file)
- Added: `MqttChannel` from `./channels/mqtt.js`
- Added: `MQTT_PORT` from `./config.js`

### In main(), after WhatsApp channel creation
- Added: `MqttChannel` creation, push to `channels[]`, and `connect()`
- Added: Auto-registration block — if no registered group has `folder === MAIN_GROUP_FOLDER`, registers `mqtt:local` as the main group with `requiresTrigger: false`
- MQTT starts unconditionally (no feature flag) — it's a local-only broker with no external dependencies

### Auto-registration logic
- Checks `Object.values(registeredGroups).some(g => g.folder === MAIN_GROUP_FOLDER)`
- Only registers if no main group exists (doesn't override existing WhatsApp/Telegram main)
- Uses `registerGroup()` which creates the group folder and persists to DB

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- SSH fleet and Docker runtime checks are unchanged
- WhatsApp channel creation is unchanged
- All existing channel routing via `findChannel()` works — MQTT's `ownsJid('mqtt:*')` handles routing

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- SSH fleet auto-discovery and health check logic
- IPC deps construction and all subsystem startup
