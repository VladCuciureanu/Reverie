# Reverie

Blocks production deploys while the on-call engineer is in deep or REM sleep, and re-runs them when they wake up.

> Deployment rejected: Engineer is in REM sleep.

Reverie has two parts: an HTTP service that reads the engineer's sleep stage from Oura and keeps a SQLite queue of blocked deploys, and a GitHub composite action that asks the service before each deploy. A blocked deploy fails its workflow run, gets a `pending` commit status, and is re-dispatched once the engineer moves from deep/REM to light sleep or awake.

The watcher only re-dispatches after it has itself seen the engineer in deep or REM sleep during the current process lifetime; if the service starts (or restarts) after the engineer is already awake, queued deploys stay queued until the next deep/REM-to-awake transition or until they expire.

## Requirements

- Node.js 26 or later (TypeScript runs directly via type stripping; SQLite via `node:sqlite`)
- An Oura personal access token
- A GitHub token that can write commit statuses and dispatch workflows on the gated repositories

## Running the service

```bash
npm install
OURA_TOKEN=... GITHUB_TOKEN=... REVERIE_API_TOKEN="$(openssl rand -hex 32)" npm start
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `REVERIE_API_TOKEN` | Yes | | Shared secret callers send as `Authorization: Bearer <token>` on `POST /gate/check`. The service exits if it is unset. |
| `OURA_TOKEN` | Yes | | Oura API personal access token |
| `GITHUB_TOKEN` | Yes | | Used to post commit statuses and dispatch queued workflows |
| `REVERIE_ENGINEER` | No | `engineer` from the config file, else `engineer` | Engineer the service gates on |
| `REVERIE_CONFIG` | No | `.reverie.yml` | Path to the config file, relative to the working directory |
| `REVERIE_DB` | No | `reverie.db` | SQLite database path |
| `PORT` | No | `8000` | HTTP port |

### `.reverie.yml`

Optional. If the file is missing, the gate defaults below apply; if it exists but is invalid, the service exits.

```yaml
sleep_tracker: oura   # required; only oura is supported
engineer: vlad        # required; REVERIE_ENGINEER takes precedence
gate:
  block_on: [deep, rem]
  allow_on: [awake, light]
  fallback: block
  timeout_minutes: 480
```

| Key | Default | Description |
|---|---|---|
| `gate.block_on` | `[deep, rem]` | Stages that block deploys. Valid stages: `awake`, `light`, `deep`, `rem`. |
| `gate.allow_on` | `[awake, light]` | Stages that allow deploys. `block_on` wins if a stage is in both. |
| `gate.fallback` | `block` | `allow` or `block`; used when the stage is unknown or in neither list. Any other value is a config error. |
| `gate.timeout_minutes` | `480` | Positive whole number of minutes. Queued deploys older than this are dropped and their commit status set to `failure`. |

## Gating a workflow

The action runs TypeScript with the runner's Node, so set up Node 26 first. The workflow needs a `workflow_dispatch` trigger, because that is how Reverie re-runs it.

```yaml
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
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - uses: VladCuciureanu/Reverie@main
        with:
          reverie_url: ${{ secrets.REVERIE_URL }}
          reverie_token: ${{ secrets.REVERIE_API_TOKEN }}
          engineer: ${{ vars.REVERIE_ENGINEER }}
          override_by: ${{ github.event.inputs.override_by }}
      - run: ./deploy.sh
```

| Input | Required | Description |
|---|---|---|
| `reverie_url` | Yes | Base URL of the service, e.g. `https://reverie.example.com` |
| `reverie_token` | Yes | Same value as the service's `REVERIE_API_TOKEN` |
| `engineer` | Yes | Must match the service's engineer, otherwise the check fails with `400` |
| `override_by` | No | Name of the engineer overriding the gate. Any non-empty value skips the gate for this run and is shown in the reason. |

The step exits `0` when the deploy is allowed and `1` when it is blocked, the service returns an error, or the service cannot be reached. It has no outputs.

Repository settings (Settings → Secrets and variables → Actions):

| Name | Kind | Description |
|---|---|---|
| `REVERIE_URL` | Secret | Base URL of the service |
| `REVERIE_API_TOKEN` | Secret | Same value as the service's `REVERIE_API_TOKEN` |
| `REVERIE_ENGINEER` | Variable | Engineer identifier passed to the `engineer` input |

This repository's [`deploy.yml`](.github/workflows/deploy.yml) is a working example; it skips the gate with a notice when `REVERIE_URL` is not set.

## HTTP API

`GET /status` (no auth):

```json
{
  "engineer": "vlad",
  "sleep_state": "rem",
  "since": "2026-03-24T02:34:00.000Z",
  "gate": "blocked",
  "queued_deploys": 1
}
```

`sleep_state` is `unknown` and `since` is `null` when the stage can't be determined: the Oura request failed or there is no phase data for the current time.

`POST /gate/check` requires `Authorization: Bearer $REVERIE_API_TOKEN` (`401` otherwise):

```json
{
  "repo": "org/repo",
  "branch": "main",
  "sha": "abc123",
  "workflow_run_id": "987654",
  "engineer": "vlad",
  "override_by": "alice"
}
```

`repo`, `branch`, `sha` and `workflow_run_id` must be non-empty strings; `engineer` and `override_by` are optional strings. Invalid JSON, invalid fields or an `engineer` other than the service's return `400` with `{"error": "..."}`. Otherwise the response is `200` (allowed) or `423` (blocked and queued):

```json
{
  "allowed": false,
  "reason": "Engineer is in REM sleep.",
  "sleep_state": "rem",
  "retry_after_seconds": 1800
}
```

The queue keeps one deploy per repository and branch; a newer blocked deploy replaces the older one. The watcher polls every 2 minutes through a 10-minute cache, so Oura is queried at most once per 10 minutes while it returns a stage, and a wake-up can take up to 10 minutes to be noticed.

## Other sleep trackers

Only Oura is wired in, but the service depends on this interface (`src/sleep/tracker.ts`):

```typescript
interface SleepTracker {
  // { state: "awake" | "light" | "deep" | "rem", since: Date }, or null if unknown
  getStatus(engineer: string): Promise<SleepStatus | null>;
}
```

## Development

```bash
npm run dev        # start with --watch
npm test           # node --test, test/**/*.test.ts
npm run typecheck  # tsc, no emit
npm run lint       # biome lint
npm run format     # biome check --write (format, sort imports, safe fixes)
npm run check      # biome check, typecheck and tests, as CI runs them
```
