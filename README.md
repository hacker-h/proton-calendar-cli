# proton-calendar-cli

Unofficial Proton Calendar API and JSON-first `pc` CLI for personal automation.

Status: manual and headless Proton login/session bootstrap work locally, and the API supports multi-calendar routing, recurrence, and automation-friendly CLI commands. Proton does not provide a stable public Calendar API for this use case, so live Proton checks are intentionally isolated from normal pull-request CI.

## Quickstart

1) Install dependencies:

```bash
pnpm approve-builds
pnpm install
```

2) Run guided login/bootstrap:

```bash
pnpm pc -- login
```

`pc login` will:

- open Chrome for manual Proton sign-in,
- export Proton cookie/session bundle,
- generate a local API bearer token,
- write CLI config (`secrets/pc-cli.json`), and
- write server env exports (`secrets/pc-server.env`).

3) Load generated environment and start API:

```bash
source secrets/pc-server.env
pnpm start
```

4) Use the CLI:

```bash
pc doctor auth
pc ls
pc new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC
pc edit evt-1 title="Updated" --clear description
pc rm evt-1
```

## Manual login cookie bootstrap

This repo now includes a basic bootstrap flow that:

1. opens a dedicated Chrome window for manual Proton login,
2. detects when Proton Calendar is loaded and auth cookies are present,
3. exports cookies via `@steipete/sweet-cookie` (with DevTools fallback),
4. closes the browser, and
5. writes the cookie bundle to `secrets/proton-cookies.json`.

### Setup

```bash
pnpm approve-builds
pnpm install
```

If keychain prompts block extraction, the bootstrap script will automatically try to read `Chrome Safe Storage` and pass it to `sweet-cookie`.

### Run

```bash
pnpm run bootstrap:cookies
```

Optional flags:

```bash
pnpm run bootstrap:cookies -- --timeout 900 --poll 2 --output secrets/proton-cookies.json
```

## CLI (`pc`)

The repository now includes a JSON-first CLI.

Run it with:

```bash
pnpm pc -- help
```

If `pc` is not available as a shell command yet, use one of these:

```bash
pnpm pc -- ls
node src/cli.js ls
```

To enable `pc` as a direct command in your shell from this repo:

```bash
pnpm link --global
pc help
```

Environment variables:

```bash
export PC_API_BASE_URL="http://127.0.0.1:8787"
export PC_API_TOKEN="replace-me"
```

You usually do not need to set these manually after `pc login`, because `pc` reads `secrets/pc-cli.json` by default.

Local config file (optional, default path `secrets/pc-cli.json`):

```json
{
  "apiBaseUrl": "http://127.0.0.1:8787",
  "apiToken": "replace-me"
}
```

You can override config file location with:

```bash
export PC_CONFIG_PATH="/absolute/path/to/pc-cli.json"
```

### Command Reference

| Command | Purpose | Common options | Example |
| --- | --- | --- | --- |
| `pc login` | Guided browser login + local config generation | `--timeout`, `--poll`, `--profile-dir`, `--chrome-path`, `--target-calendar`, `--cookie-bundle` | `pc login --timeout 900` |
| `pc doctor auth` | Diagnose whether auth is valid/recoverable | `--cookie-bundle`, `--proton-base-url`, `-o` | `pc doctor auth` |
| `pc ls` | List events (default: current week) | `w`, `w+`, `w++`, `m`, `y`, `all`, `--from/--to`, `--start/--end`, `-c`, `-o`, `--protected`, `--unprotected`, `--title`, `--description`, `--location` | `pc ls w++` |
| `pc new` | Create event | `title=`, `start=`, `end=`, `timezone=`, `description=`, `location=`, `recurrence.*`, `-c` | `pc new title="Demo" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC` |
| `pc edit` | Differential update (PATCH) | `field=value`, `--patch @file.json`, `--clear description`, `--clear location`, `--scope`, `--at`, `-c` | `pc edit evt-1 title="Updated" --clear description` |
| `pc rm` | Delete event | `--scope`, `--at`, `-c` | `pc rm evt-series --scope series` |
| `pc help` | Show CLI help | none | `pc help` |

Examples:

```bash
# current week
pc ls

# guided login/bootstrap
pc login

# auth diagnostics (checks access token and refresh recovery)
pc doctor auth

# current + next week(s)
pc ls w+
pc ls w++

# explicit week/month/year shortcuts
pc ls w 37
pc ls m 7 2026
pc ls y 2026

# explicit ranges (date-only or datetime)
pc ls --from 2026-07-01 --to 2026-07-31
pc ls --start 2026-07-01T00:00:00Z --end 2026-07-31T23:59:59Z

# filter by protection state
pc ls --protected
pc ls --unprotected

# filter by event text (case-insensitive substring match)
pc ls --title review
pc ls --description workshop
pc ls --location "room a"

# create
pc new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC

# differential edit
pc edit evt-1 title="Updated title" loc="Room B"

# clear fields explicitly
pc edit evt-1 --clear description --clear location

# recurring scope edits/deletes
pc edit evt-series --scope single --at 2026-03-12T09:00:00Z title="One-off"
pc edit evt-series --scope following --at 2026-03-12T09:00:00Z title="Phase 2"
pc rm evt-series --scope series
```

Notes:

- Output defaults to JSON (`-o json`), with optional `-o table`.
- `pc ls --title/--description/--location` use case-insensitive substring matching and combine with other list filters using AND semantics.
- `pc edit` is PATCH-style: only provided fields are sent.
- `--clear` currently supports `description` and `location`.
- Recurring scope values are `single`, `following`, and `series`.
- `--at <ISO>` is required for `single` and `following` recurrence scope actions.

### Example Output

`pc doctor auth` example (`status=refresh_recovered` means access cookie was expired but refresh still works):

```json
{
  "data": {
    "topic": "auth",
    "status": "refresh_recovered",
    "reloginRequired": false,
    "refreshPossible": true,
    "refreshAttempted": true,
    "refreshSucceeded": true,
    "uid": "<uid>",
    "host": "https://calendar.proton.me",
    "authCookies": {
      "before": [
        {
          "name": "AUTH-<uid>",
          "expiresAtIso": "2026-02-20T18:55:23.000Z"
        }
      ],
      "after": [
        {
          "name": "AUTH-<uid>",
          "expiresAtIso": "2027-02-20T18:56:37.263Z"
        }
      ]
    }
  }
}
```

`pc doctor auth` status values:

- `access_valid`: current session already works.
- `refresh_recovered`: current access was invalid but refresh recovered it.
- `refresh_failed`: refresh was possible but did not recover access.
- `refresh_unavailable`: no usable refresh payload found.

`pc ls --start ... --end ...` example:

```json
{
  "data": {
    "events": [
      {
        "id": "evt-1",
        "title": "Design review",
        "start": "2026-03-10T10:00:00.000Z",
        "end": "2026-03-10T10:30:00.000Z",
        "location": "Room A"
      }
    ],
    "count": 1,
    "range": {
      "start": "2026-03-10T00:00:00.000Z",
      "end": "2026-03-11T00:00:00.000Z"
    },
    "calendarId": null
  }
}
```

## API

Environment variables:

```bash
export TARGET_CALENDAR_ID="assistant-calendar-id"
export DEFAULT_CALENDAR_ID="assistant-calendar-id"
export ALLOWED_CALENDAR_IDS="assistant-calendar-id,team-calendar-id"
export API_BEARER_TOKEN="replace-me"
export COOKIE_BUNDLE_PATH="secrets/proton-cookies.json"
export PROTON_BASE_URL="https://calendar.proton.me"
export PROTON_AUTH_DEBUG="1"
export PROTON_AUTO_RELOGIN="0"
export PROTON_RELOGIN_MODE="headless"
export PROTON_RELOGIN_TIMEOUT_MS="120000"
export PROTON_RELOGIN_POLL_SECONDS="3"
export PROTON_RELOGIN_COOLDOWN_MS="300000"
export PROTON_RELOGIN_LOCK_PATH="secrets/proton-cookies.json.relogin.lock"
export PROTON_RELOGIN_URL="https://calendar.proton.me/u/0"
export PROTON_PROFILE_DIR="$HOME/Library/Application Support/Google/Chrome"
export PROTON_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Run API server:

```bash
pnpm start
```

Routes:

- `GET /v1/health`
- `GET /v1/auth/status`
- `GET /v1/events?start=<iso>&end=<iso>&limit=<n>&cursor=<token>`
- `GET /v1/events/:eventId`
- `POST /v1/events`
- `PATCH /v1/events/:eventId?scope=single|following|series&occurrenceStart=<iso>`
- `DELETE /v1/events/:eventId?scope=single|following|series&occurrenceStart=<iso>`
- `GET /v1/calendars/:calendarId/events?start=<iso>&end=<iso>&limit=<n>&cursor=<token>`
- `GET /v1/calendars/:calendarId/events/:eventId`
- `POST /v1/calendars/:calendarId/events`
- `PATCH /v1/calendars/:calendarId/events/:eventId?scope=single|following|series&occurrenceStart=<iso>`
- `DELETE /v1/calendars/:calendarId/events/:eventId?scope=single|following|series&occurrenceStart=<iso>`

Notes:

- `TARGET_CALENDAR_ID` hard-locks all requests to one calendar.
- Without a target lock, routes can use allowed calendars from `ALLOWED_CALENDAR_IDS`.
- `/v1/events` routes use `DEFAULT_CALENDAR_ID` (or `TARGET_CALENDAR_ID` when set).
- Recurring events are supported and list responses return expanded occurrences in range.

### Auth refresh behavior

- On `401/403` from Proton, the server attempts cookie refresh via Proton refresh endpoints using the stored `REFRESH-*` cookie payload.
- Any returned `Set-Cookie` headers are merged into `COOKIE_BUNDLE_PATH` automatically.
- `pc login` and the generated `secrets/pc-server.env` bootstrap cookies and API tokens, but they do not enable runtime auto-relogin by default.
- When `PROTON_AUTO_RELOGIN=1`, the client can also re-bootstrap cookies automatically after refresh failure. For unattended/OpenClaw-style workloads, prefer `PROTON_RELOGIN_MODE=headless`; `hybrid` can fall back to a visible Chrome window.
- `PROTON_RELOGIN_COOLDOWN_MS` suppresses repeated relogin attempts after a failed bootstrap. The default is `300000` ms (5 minutes).
- `PROTON_RELOGIN_LOCK_PATH` coordinates relogin across multiple processes sharing the same cookie bundle so only one bootstrap opens Chrome at a time.
- When `PROTON_AUTH_DEBUG=1`, refresh logs are emitted with cookie change details and expiry timestamps.

### Unattended / OpenClaw guidance

For unattended automation, treat browser login as a bootstrap step and cookie refresh as the normal steady state:

- Run `pnpm pc -- login` interactively once to create `secrets/proton-cookies.json`, `secrets/pc-cli.json`, and `secrets/pc-server.env`.
- Run `pc doctor auth` before wiring the API into OpenClaw so you know whether refresh already works with the exported cookies.
- Leave `PROTON_AUTO_RELOGIN=0` unless the worker truly needs runtime browser recovery.
- If you must enable runtime relogin, use `PROTON_RELOGIN_MODE=headless`, keep `PROTON_RELOGIN_COOLDOWN_MS` set, and point all workers at the same `PROTON_RELOGIN_LOCK_PATH`.
- Avoid `PROTON_RELOGIN_MODE=hybrid` for unattended agents unless you explicitly want visible Chrome fallback.

Manual verification commands:

```bash
# 1) Re-login/bootstrap and generate local CLI/server config
pnpm pc -- login

# 2) Start API with debug logging
source secrets/pc-server.env
export PROTON_AUTH_DEBUG="1"
pnpm start

# 3) In another terminal, trigger API access
pnpm pc -- ls --start 2026-01-01T00:00:00Z --end 2026-12-31T23:59:59Z

# 4) Inspect cookie bundle expiry fields (AUTH/REFRESH cookies)
node --input-type=module -e "import { readFile } from 'node:fs/promises'; const b=JSON.parse(await readFile('secrets/proton-cookies.json','utf8')); const all=[...(b.cookies||[])]; for (const c of all.filter((x)=>String(x.name||'').startsWith('AUTH-')||String(x.name||'').startsWith('REFRESH-')||x.name==='Session-Id')) console.log(c.name,c.domain,c.path,c.expires||c.expiresAt||'session');"
```

Event fields currently supported by API and CLI:

- `title`
- `description`
- `location`
- `start` (ISO datetime)
- `end` (ISO datetime)
- `timezone`
- `recurrence` object with `freq`, `interval`, `count`, `until`, `byDay`, `byMonthDay`, `weekStart`, `exDates`
- `protected` (boolean, default: `false` — set to `true` to prevent other shared-calendar members from editing)

## Implemented Features

- Manual browser/session bootstrap and cookie export (`secrets/proton-cookies.json`).
- Bearer-authenticated API server with health and auth status endpoints.
- Single and multi-calendar event CRUD with allowlist/target lock enforcement.
- Recurring events with expanded list output in a requested time range.
- Recurring mutation scopes: `single`, `following`, `series`.
- JSON-first CLI (`pc`) with short defaults for week/month/year views.
- Differential event edits (`pc edit`) and explicit field clears (`--clear description|location`).
- Relogin cooldown (`PROTON_RELOGIN_COOLDOWN_MS`) and cross-process lock (`PROTON_RELOGIN_LOCK_PATH`) to prevent repeated browser spawns.
- Automated tests for API behavior, recurrence/scopes, auth reload flow, and CLI parsing.

## Not Implemented Features

- Attendee invitation workflows (invite, RSVP, participation state management).
- Visibility/privacy and free-busy policy controls beyond current defaults.
- Reminder/alert delivery controls and notification channels.
- Conference metadata management (join URLs, dial-ins) as first-class fields.
- Attachments, categories/tags, and richer classification metadata.
- Full raw ICS passthrough/import-export fidelity for unknown custom fields.
- End-to-end live validation for all Proton recurrence edge cases in production accounts.

## Development

Run tests:

```bash
pnpm test
```

Run the no-quota contribution gate used by GitHub Actions:

```bash
pnpm run ci:local
```

## License

MIT. See [LICENSE](LICENSE).

## git-crypt

This repository uses a dedicated `encrypted/` directory for local credentials that should sync between trusted development machines in encrypted form.

- Put shared encrypted files under `encrypted/`.
- Keep generated runtime secrets under `secrets/` or `.tmp/`; those directories are gitignored.
- Do not store exported Proton cookie bundles in git unless there is a deliberate operational reason. They are volatile and high-risk.
- Grant another collaborator access with `git-crypt add-gpg-user <gpg-key-id>`.
- Unlock encrypted files on a machine with the matching private key via `git-crypt unlock`.

The dedicated directory is intentional: it keeps the encryption boundary obvious and avoids accidentally encrypting normal source, config, or fixture files with patterns that are too broad.

Expected local credential file:

```bash
encrypted/local-live.env
```

Expected variables:

```bash
PROTON_USERNAME=<dedicated test account username>
PROTON_PASSWORD=<dedicated test account password>
PROTON_TEST_CALENDAR_ID=<optional dedicated calendar id>
```

## GitHub Actions CI

Pull requests run only no-quota local gates:

- frozen dependency install,
- mocked/unit tests, and
- packaged `pc` binary smoke test.

Live Proton canaries should run only from scheduled/manual workflows after automatic login is reliable and the repository secrets are configured. Do not run live canaries for every pull request.

To sync unlocked local credentials into GitHub Actions secrets without printing values:

```bash
pnpm run sync:github-secrets
```

The sync helper reads `encrypted/local-live.env` by default and sets:

- `PROTON_USERNAME`
- `PROTON_PASSWORD`
- `PROTON_TEST_CALENDAR_ID` when present

## GitLab CI

The tracked GitLab pipeline is intentionally local-only for public safety. Prefer GitHub Actions for pull-request checks and scheduled Proton canaries.
