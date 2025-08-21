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
deno task start
```

### 2. Add `.reverie.yml` to your repo

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

      - name: Check sleep gate
        uses: reverie/gate@v1
        with:
          reverie_url: ${{ secrets.REVERIE_URL }}
          engineer: vlad
          override_by: ${{ github.event.inputs.override_by }}

      - name: Deploy
        run: ./deploy.sh
```

## Configuration Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `sleep_tracker` | string | — | Tracker adapter name (e.g. `oura`) |
| `engineer` | string | — | Engineer identifier |
| `gate.block_on` | string[] | `[deep, rem]` | Sleep stages that block deploys |
| `gate.allow_on` | string[] | `[awake, light]` | Sleep stages that allow deploys |
| `gate.fallback` | string | `block` | Behavior when sleep state is unknown: `block` or `allow` |
| `gate.timeout_minutes` | number | `480` | Max minutes to hold a deploy before failing |

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

- **Runtime**: Deno (TypeScript)
- **Persistence**: SQLite (deploy queue)
- **Auth**: GitHub App token
- **Sleep tracker**: Generic adapter interface (Oura Ring reference implementation)

```
┌──────────────┐    poll/webhook    ┌──────────────────┐
│  Sleep       │ ──────────────────▶│  Reverie Service │
│  Tracker     │                    │  (Deno/TS)       │
└──────────────┘                    │                  │
                                    │  - Sleep state   │
┌──────────────┐   HTTP check       │  - Deploy queue  │
│  GitHub      │ ──────────────────▶│  - Gate logic    │
│  Actions     │ ◀──────────────────│                  │
│              │   pass/fail        └──────────────────┘
└──────────────┘
```

## Development

```bash
deno task dev      # run with watch mode
deno task test     # run tests
deno task fmt      # format code
deno task lint     # lint code
```