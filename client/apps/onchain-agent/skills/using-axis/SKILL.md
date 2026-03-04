---
name: using-axis
description:
  Use when authenticating, running, or managing Eternum game agents via the axis CLI, especially on headless servers or
  VPS.
---

# Using Axis

CLI for autonomous Eternum game agents. Discovers worlds, authenticates via Cartridge Controller, runs an LLM-driven
tick loop.

## Quick Start (from scratch)

### 1. Build the binary

From the eternum repo root:

```bash
pnpm install
pnpm --dir packages/types build
pnpm --dir packages/torii build
pnpm --dir packages/provider build
pnpm --dir packages/client build
pnpm --dir packages/game-agent build
cd client/apps/onchain-agent
pnpm build:standalone
```

This produces the `./axis` binary in `client/apps/onchain-agent/`.

### 2. Initialize

```bash
./axis init
```

Creates:
- `~/.eternum-agent/data/` — runtime data
- `~/.eternum-agent/.cartridge/` — session storage
- `~/.eternum-agent/.env` — config file

### 3. Set your API key

Edit `~/.eternum-agent/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Discover worlds

```bash
./axis worlds
```

Lists active worlds across slot, sepolia, and mainnet with status (upcoming/ongoing).

### 5. Authenticate

Password auth (headless, with paymaster):

```bash
./axis auth <world> --method=password --username=<user> --password=<pass>
```

For mainnet worlds, set `CHAIN=mainnet`:

```bash
CHAIN=mainnet ./axis auth <world> --method=password --username=<user> --password=<pass>
```

**Note:** The Cartridge account must be deployed on the target chain. If you get "Contract not found," the account hasn't interacted with that chain yet. Mainnet accounts are deployed by default; slot accounts may need a first interaction via the game frontend.

Other auth methods:

| Method       | Command                   | Notes                   |
| ------------ | ------------------------- | ----------------------- |
| QR code      | `axis auth <world>`       | Generates QR + auth URL |
| Redirect URL | `--redirect-url="..."`    | Complete browser auth   |
| Session data | `--session-data="<b64>"`  | Import raw session      |
| Private key  | `--auth=privatekey` + env | No paymaster            |

Check status: `./axis auth <world> --status`

Sessions last 7 days. Re-run to refresh.

### 6. Run the agent

```bash
./axis run --headless --world=<name> --api-port=3000
```

Or interactive TUI:

```bash
./axis
```

## Fleet

```bash
./axis auth --all --method=password --username=me --password=secret --json > /tmp/auth.json
for world in $(jq -r '.[].world' /tmp/auth.json); do
  ./axis run --headless --world="$world" --api-port=$((3000+RANDOM%1000)) &
done
```

## HTTP API

Enable with `--api-port`:

| Method | Path        | Purpose                            |
| ------ | ----------- | ---------------------------------- |
| `POST` | `/prompt`   | Send prompt (`{"content": "..."}`) |
| `GET`  | `/status`   | Agent status                       |
| `GET`  | `/state`    | World state snapshot               |
| `GET`  | `/events`   | SSE stream                         |
| `POST` | `/config`   | Update runtime config              |
| `POST` | `/shutdown` | Graceful shutdown                  |

## Environment Variables

| Variable            | Default      | Purpose                                       |
| ------------------- | ------------ | --------------------------------------------- |
| `ANTHROPIC_API_KEY` | _(required)_ | LLM API key                                   |
| `MODEL_PROVIDER`    | `anthropic`  | `anthropic`, `openai`, `openrouter`, `google` |
| `CHAIN`             | `slot`       | `slot`, `sepolia`, `mainnet`                  |
| `SLOT_NAME`         | _(none)_     | Auto-select world                             |
| `TICK_INTERVAL_MS`  | `60000`      | Tick interval (ms)                            |

Skip discovery: set `RPC_URL`, `TORII_URL`, `WORLD_ADDRESS`.

## Troubleshooting

| Problem               | Fix                                                             |
| --------------------- | --------------------------------------------------------------- |
| Session expired        | Re-run `axis auth <world> --method=password ...`               |
| No worlds found        | Check `CHAIN` and network connectivity                         |
| Password auth fails    | Verify account has password credential on Cartridge            |
| Contract not found     | Account not deployed on target chain — use mainnet or register via frontend first |
| WASM/binary crash      | Rebuild with `pnpm build:standalone`                           |
| No API key             | Set `ANTHROPIC_API_KEY` in `~/.eternum-agent/.env`             |
