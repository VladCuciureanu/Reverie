# Reverie

Blocks production deploys while the on-call engineer is in deep or REM sleep, and re-runs them when they wake up.

> reverie: deploy blocked (sleep state: rem): Engineer is in REM sleep. It is queued and will be re-run when the engineer wakes.

Reverie has two parts: an HTTP service that reads the engineer's sleep stage from Oura and keeps a SQLite queue of blocked deploys, and a GitHub composite action that asks the service before each deploy. A blocked deploy fails its workflow run, gets a `pending` commit status, and is re-dispatched once the gate opens again: with the default settings, when the engineer moves from deep/REM to light sleep or awake.

The watcher applies the same `gate` settings as `POST /gate/check`, and re-dispatches when one poll finds the gate closed (a `block_on` stage, or a stage the `fallback` blocks, including unknown with `fallback: block`) and the next poll with a known stage finds it open. An unknown stage never counts as the gate opening, even with `fallback: allow`. The watcher only re-dispatches after it has itself seen the gate closed during the current process lifetime; if the service starts (or restarts) while the gate is already open, queued deploys stay queued until the gate next closes and reopens, or until they expire.

## Requirements

- Node.js 26 or later (TypeScript runs directly via type stripping; SQLite via `node:sqlite`)
- An Oura personal access token
- A GitHub token that can write commit statuses and dispatch workflows on the gated repositories

## Running the service

```bash
npm install
REVERIE_ENGINEER=vlad OURA_TOKEN=... GITHUB_TOKEN=... REVERIE_API_TOKEN="$(openssl rand -hex 32)" npm start
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `REVERIE_API_TOKEN` | Yes | | Shared secret callers send as `Authorization: Bearer <token>` on every endpoint. |
| `OURA_TOKEN` | Yes | | Oura API personal access token |
| `GITHUB_TOKEN` | Yes | | Used to post commit statuses and dispatch queued workflows |
| `REVERIE_ENGINEER` | If not in the config file | `engineer` from the config file | Engineer the service gates on. Takes precedence over the config file; the service exits if neither sets it. |
| `REVERIE_CONFIG` | No | `.reverie.yml` | Path to the config file, relative to the working directory |
| `REVERIE_DB` | No | `reverie.db` | SQLite database path |
| `PORT` | No | `8000` | HTTP port, an integer from 0 to 65535 |

If a required variable is unset or empty, no engineer is set, `PORT` is not a valid port, or the config file is invalid, the service prints one line to stderr (for example `reverie: OURA_TOKEN must be set`) and exits with status 1 without starting.

### `.reverie.yml`

Optional. If the file is missing, the gate defaults below apply; if it exists but is invalid, the service exits.

```yaml
sleep_tracker: oura   # optional; only oura is supported
engineer: vlad        # optional if REVERIE_ENGINEER is set, which takes precedence
gate:
  block_on: [deep, rem]
  allow_on: [awake, light]
  fallback: block
  timeout_minutes: 480
```

| Key | Default | Description |
|---|---|---|
| `sleep_tracker` | `oura` | Sleep tracker to read. Any other value is a config error. |
| `engineer` | | Engineer the service gates on, unless `REVERIE_ENGINEER` is set. |
| `gate.block_on` | `[deep, rem]` | Stages that block deploys. Valid stages: `awake`, `light`, `deep`, `rem`. |
| `gate.allow_on` | `[awake, light]` | Stages that allow deploys. `block_on` wins if a stage is in both. |
| `gate.fallback` | `block` | `allow` or `block`; used when the stage is unknown or in neither list. Any other value is a config error. |
| `gate.timeout_minutes` | `480` | Positive whole number of minutes. Queued deploys older than this are dropped and their commit status set to `failure`. |

## Gating a workflow

The action does not install Node: it runs its TypeScript source with whatever `node` is on the runner's `PATH`, which must be Node 26 or later. Add `actions/setup-node` with Node 26 before it, as below. The workflow needs a `workflow_dispatch` trigger, because that is how Reverie re-runs it.

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

The step exits `0` when the deploy is allowed and `1` otherwise, and prints one line saying which case applies:

| Case | Exit | Output |
|---|---|---|
| Allowed (`200`) | `0` | `Deploy allowed: <reason>` on stdout |
| Blocked (`423`) | `1` | `reverie: deploy blocked (sleep state: <state>): <reason> It is queued and will be re-run when the engineer wakes.` on stderr |
| Error: any other status, a non-JSON body, or the service is unreachable | `1` | `reverie: gate check failed: <reason>` on stderr. Nothing is queued, so nothing will be re-run; fix the cause and re-run the workflow. |

| Output | Description |
|---|---|
| `allowed` | `true` if the deploy may proceed, otherwise `false` (blocked or error) |
| `sleep_state` | `awake`, `light`, `deep` or `rem`; `unknown` when the stage can't be determined or the check failed |

Because the step fails unless the deploy is allowed, a later step that reads the outputs after a block needs `if: always()` (or `continue-on-error: true` on the gate step), and the gate step needs an `id`:

```yaml
      - id: gate
        uses: VladCuciureanu/Reverie@main
        with:
          reverie_url: ${{ secrets.REVERIE_URL }}  # and the other inputs above
      - if: always() && steps.gate.outputs.allowed == 'false'
        run: echo "Gate closed; engineer is ${{ steps.gate.outputs.sleep_state }}"
```

Repository settings (Settings → Secrets and variables → Actions):

| Name | Kind | Description |
|---|---|---|
| `REVERIE_URL` | Secret | Base URL of the service |
| `REVERIE_API_TOKEN` | Secret | Same value as the service's `REVERIE_API_TOKEN` |
| `REVERIE_ENGINEER` | Variable | Engineer identifier passed to the `engineer` input |

This repository's [`deploy.yml`](.github/workflows/deploy.yml) is a working example; it skips the gate with a notice when `REVERIE_URL` is not set.

## HTTP API

Both endpoints require `Authorization: Bearer $REVERIE_API_TOKEN` and return `401` with `{"error": "Unauthorized"}` without it. Other paths return `404`.

`GET /status`:

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

`POST /gate/check`:

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

`retry_after_seconds` is `null` when allowed, `300` when the stage is unknown, and `1800` otherwise. It is only a hint: the deploy is already queued and is re-dispatched automatically, so callers don't need to retry.

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

## License

MIT. See [LICENSE](LICENSE).
