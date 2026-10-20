# Reverie

> Your sleep as a deployment window.

Reverie connects to your sleep tracker and blocks production deploys while you're in deep sleep or REM. When you wake up, queued deploys resume automatically.

**"Deployment rejected: engineer is in REM."**

## How It Works

1. Reverie polls your sleep tracker for your current sleep state
2. A GitHub Action gate checks your state before each deploy
3. If you're in deep/REM sleep, the deploy is blocked and queued
4. When you wake, queued deploys are re-triggered automatically

## Quick Start

### 1. Deploy the Reverie service

```bash
# Set required environment variables
export OURA_TOKEN="your-oura-api-token"
export GITHUB_TOKEN="your-github-app-token"
export REVERIE_ENGINEER="vlad"
export REVERIE_API_TOKEN="$(openssl rand -hex 32)" # shared secret for /gate/check
export PORT=8000               # optional, defaults to 8000
export REVERIE_DB="reverie.db" # optional, defaults to reverie.db
export REVERIE_CONFIG=".reverie.yml" # optional, defaults to ./.reverie.yml

npm install
npm start
```

### 2. Configure the gate with `.reverie.yml`

The service reads `.reverie.yml` from its working directory (override the path with `REVERIE_CONFIG`). If the file is absent, the defaults below apply; an invalid file stops the service from starting.

```yaml
sleep_tracker: oura
engineer: vlad
gate:
  block_on: [deep, rem]
  allow_on: [awake, light]
  fallback: block
  timeout_minutes: 480
```

### 3. Add the gate to your deploy workflow

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      override_by:
        description: "Engineer overriding the sleep gate"
        required: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 26 # the action runs TypeScript directly on Node 26+

      - name: Check sleep gate
        uses: reverie/gate@v1
        with:
          reverie_url: ${{ secrets.REVERIE_URL }}
          reverie_token: ${{ secrets.REVERIE_API_TOKEN }}
          engineer: vlad
          override_by: ${{ github.event.inputs.override_by }}

      - name: Deploy
        run: ./deploy.sh
```

The gate step needs these repository settings (Settings → Secrets and variables → Actions):

| Name | Kind | Description |
|---|---|---|
| `REVERIE_URL` | Secret | Base URL of your Reverie service, e.g. `https://reverie.example.com` |
| `REVERIE_API_TOKEN` | Secret | Same value as the service's `REVERIE_API_TOKEN` |
| `REVERIE_ENGINEER` | Variable | Engineer identifier (used by the example `deploy.yml`); must match the service's engineer |

This repository's own [`deploy.yml`](.github/workflows/deploy.yml) is an example: when `REVERIE_URL` is not set it skips the gate with a notice instead of failing.

## Configuration Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `sleep_tracker` | string | — | Tracker adapter name (only `oura` is supported) |
| `engineer` | string | — | Engineer identifier (`REVERIE_ENGINEER` takes precedence) |
| `gate.block_on` | string[] | `[deep, rem]` | Sleep stages that block deploys |
| `gate.allow_on` | string[] | `[awake, light]` | Sleep stages that allow deploys. Stages in neither `block_on` nor `allow_on` use `fallback`; `block_on` wins if a stage is in both |
| `gate.fallback` | string | `block` | Behavior when sleep state is unknown: `block` or `allow` |
| `gate.timeout_minutes` | number | `480` | Max minutes a deploy stays queued; after that it is dropped and its commit status set to `failure` |

## API

### `GET /status`

```json
{
  "engineer": "vlad",
  "sleep_state": "rem",
  "since": "2026-03-24T02:34:00Z",
  "gate": "blocked",
  "queued_deploys": 1
}
```

### `POST /gate/check`

Requires `Authorization: Bearer $REVERIE_API_TOKEN` (otherwise `401`). Request body:

```json
{
  "repo": "org/repo",
  "branch": "main",
  "sha": "abc123",
  "workflow_run_id": "987654",
  "override_by": "alice"
}
```

`repo`, `branch`, `sha` and `workflow_run_id` must be non-empty strings; `override_by` is an optional string. Malformed JSON or invalid fields return `400`. Response (`200` when allowed, `423` when blocked):

```json
{
  "allowed": false,
  "reason": "Engineer is in REM sleep.",
  "sleep_state": "rem",
  "retry_after_seconds": 1800
}
```

## Team Override

Any awake engineer can override the gate for a single deploy by triggering the workflow manually and providing their name in the `override_by` input.

## Architecture

- **Runtime**: Node.js 26+ (TypeScript via built-in type stripping)
- **Persistence**: SQLite (deploy queue)
- **Auth**: GitHub App token
- **Sleep tracker**: Generic adapter interface (Oura Ring reference implementation)

```
┌──────────────┐        poll        ┌──────────────────┐
│  Sleep       │ ──────────────────▶│  Reverie Service │
│  Tracker     │                    │  (Node/TS)       │
└──────────────┘                    │                  │
                                    │  - Sleep state   │
┌──────────────┐   HTTP check       │  - Deploy queue  │
│  GitHub      │ ──────────────────▶│  - Gate logic    │
│  Actions     │ ◀──────────────────│                  │
│              │   pass/fail        └──────────────────┘
└──────────────┘
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OURA_TOKEN` | Yes | Oura Ring API personal access token |
| `GITHUB_TOKEN` | Yes | GitHub App token for commit statuses and workflow dispatch |
| `REVERIE_ENGINEER` | No | Engineer identifier; overrides `engineer` in `.reverie.yml` (default: config value, else `engineer`). The action's `engineer` input must match it. |
| `REVERIE_API_TOKEN` | Yes | Shared secret required as `Authorization: Bearer <token>` on `POST /gate/check`. Store the same value as the `REVERIE_API_TOKEN` repo secret and pass it to the action's `reverie_token` input. The service refuses to start without it. |
| `PORT` | No | HTTP server port (default: `8000`) |
| `REVERIE_DB` | No | SQLite database path (default: `reverie.db`) |
| `REVERIE_CONFIG` | No | Path to the config file (default: `.reverie.yml`) |

## Project Structure

```
src/
  main.ts              # HTTP server entrypoint
  config.ts            # .reverie.yml parser
  sleep/
    types.ts           # SleepState, SleepStatus types
    tracker.ts         # SleepTracker interface
    oura.ts            # Oura Ring adapter
    state.ts           # Sleep state cache with TTL
    watcher.ts         # Wake watcher (auto-retrigger)
  gate/
    gate.ts            # Deploy gate decision logic
    queue.ts           # SQLite deploy queue
  github/
    action.ts          # GitHub Action entrypoint
    workflow.ts        # GitHub API client
test/                  # Mirror of src/ with _test.ts files
action.yml             # GitHub Action metadata
```

## Development

```bash
npm run dev        # run with watch mode
npm test           # run tests
npm run typecheck  # type-check with tsc
npm run format     # format code (Biome)
npm run lint       # lint code (Biome)
```

## Writing a Custom Sleep Tracker Adapter

Implement the `SleepTracker` interface:

```typescript
import type { SleepTracker } from "./src/sleep/tracker.ts";
import type { SleepStatus } from "./src/sleep/types.ts";

class MyTracker implements SleepTracker {
  async getStatus(engineer: string): Promise<SleepStatus | null> {
    // Return { state: "awake" | "light" | "deep" | "rem", since: Date }
    // Return null if status is unavailable
  }
}
```