# Running the Axis Agent

## Prerequisites

- Auth completed for the target world (session files exist in `~/.eternum-agent/.cartridge/<world>/`)
- `~/.eternum-agent/.env` configured with API key and `CARTRIDGE_PASSWORD`

## One-time setup (new machine or new world)

```bash
cd client/apps/onchain-agent

# 1. Create data dirs and .env
./axis init

# 2. Edit ~/.eternum-agent/.env — set ANTHROPIC_API_KEY and CARTRIDGE_PASSWORD

# 3. Authenticate with a world (generates auth URL for the Cartridge controller)
CHAIN=mainnet ./axis auth --world=<world-name>
# → sends auth.json file to frontboat; he approves it in the browser
```

## Build

```bash
cd client/apps/onchain-agent

# Builds packages/types + packages/provider + packages/client, then compiles binary
pnpm build:standalone
```

## Start the agent

```bash
cd client/apps/onchain-agent

# Run in background, log to /tmp/axis-fruity.log
nohup bash -c 'CHAIN=mainnet CARTRIDGE_PASSWORD="<your-password>" ./axis run --headless --world=fruity-fruity-sandbox --api-port=3001' > /tmp/axis-fruity.log 2>&1 &

# Check it's running
pgrep -af "axis run"

# Watch the log
tail -f /tmp/axis-fruity.log

# Watch actions only
tail -f ~/.eternum-agent/data/fruity-fruity-sandbox/debug/actions.log
```

## Stop the agent

```bash
kill $(pgrep -f "axis run")
```

## Restart after code changes

```bash
cd client/apps/onchain-agent
kill $(pgrep -f "axis run")
pnpm build:standalone
nohup bash -c 'CHAIN=mainnet CARTRIDGE_PASSWORD="<your-password>" ./axis run --headless --world=fruity-fruity-sandbox --api-port=3001' > /tmp/axis-fruity.log 2>&1 &
```

## Active worlds

| World | Chain | API port | Log |
|-------|-------|----------|-----|
| fruity-fruity-sandbox | mainnet | 3001 | /tmp/axis-fruity.log |

## Key paths

- Binary: `client/apps/onchain-agent/axis`
- Session files: `~/.eternum-agent/.cartridge/<world>/`
- Data/logs: `~/.eternum-agent/data/<world>/debug/`
- Global config: `~/.eternum-agent/.env`
