# Intent: src/config.ts modifications

## What changed
Added MQTT broker port configuration.

## Key sections
- **readEnvFile call**: Added `MQTT_PORT` to the keys array so it can be read from `.env`
- **MQTT_PORT**: Integer port, read from `process.env` first, then `envConfig` fallback, defaults to `1883` (standard MQTT port)

## Invariants
- All existing config exports remain unchanged
- New MQTT key is added to the `readEnvFile` call alongside existing keys
- New export is appended at the end of the file
- No existing behavior is modified — MQTT config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as other config values)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, `SSH_FLEET_CONFIG_PATH`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- SSH fleet config exports
