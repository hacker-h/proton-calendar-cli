# Proton Calendar CLI

Command-line access to Proton Calendar through a local API bridge. Use `pc` to log in, list events, create events, patch only the fields you change, and delete events, including scoped changes to recurring events.

The CLI talks to a local server started from this repository. Proton auth is bootstrapped from a Chrome login and stored in local `secrets/` files.

## Quickstart

```bash
pnpm install
pnpm pc -- login
source secrets/pc-server.env
pnpm start
```

If pnpm blocks native browser-cookie helpers during install, run `pnpm approve-builds` and reinstall before `pc login`.

In another shell:

```bash
pnpm pc -- doctor auth
pnpm pc -- ls
pnpm pc -- new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC
```

`pc login` opens Chrome for Proton sign-in, exports a cookie/session bundle, generates a local API bearer token, and writes:

- `secrets/proton-cookies.json`
- `secrets/pc-cli.json`
- `secrets/pc-server.env`

If `pc` is not linked globally, keep using `pnpm pc -- <command>` or `node src/cli.js <command>`.

## Core Commands

| Command | Purpose | Example |
| --- | --- | --- |
| `pc login` | Browser login, cookie export, CLI/server config generation | `pnpm pc -- login --target-calendar cal_123` |
| `pc doctor auth` | Check whether the saved Proton session works or can refresh | `pnpm pc -- doctor auth` |
| `pc ls` | List events; defaults to current ISO week | `pnpm pc -- ls w++ --title review` |
| `pc new` | Create an event from `field=value` pairs | `pnpm pc -- new title="Demo" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC` |
| `pc edit` | PATCH-style update; only provided fields are sent | `pnpm pc -- edit evt-1 title="Updated" --clear description` |
| `pc rm` | Delete an event or recurring scope | `pnpm pc -- rm evt-1 --scope series` |

Useful list shortcuts:

```bash
pnpm pc -- ls                  # current week
pnpm pc -- ls w+               # current and next week
pnpm pc -- ls w++              # current and next two weeks
pnpm pc -- ls m 7 2026         # month
pnpm pc -- ls y 2026           # year
pnpm pc -- ls --from 2026-07-01 --to 2026-07-31
pnpm pc -- ls --protected
pnpm pc -- ls --unprotected
pnpm pc -- ls --title review --location "room b"
```

Mutation fields currently supported: `title`, `description`, `location`, `start`, `end`, `timezone`, `allDay`, `protected`, and `recurrence`. `pc edit --clear` only supports `description` and `location`. Output defaults to JSON; use `-o table` for list output.

Recurring event scopes are `series`, `single`, and `following`. `single` and `following` require an occurrence start:

```bash
pnpm pc -- edit evt-series --scope single --at 2026-03-12T09:00:00Z title="One-off"
pnpm pc -- rm evt-series --scope following --at 2026-03-12T09:00:00Z
```

## Configuration And Auth

CLI config is read from `secrets/pc-cli.json` by default:

```json
{
  "apiBaseUrl": "http://127.0.0.1:8787",
  "apiToken": "replace-me"
}
```

Environment overrides:

```bash
export PC_CONFIG_PATH=/absolute/path/to/pc-cli.json
export PC_API_BASE_URL=http://127.0.0.1:8787
export PC_API_TOKEN=replace-me
```

The local API server requires `API_BEARER_TOKEN` plus calendar scope. The generated `secrets/pc-server.env` sets the common values; manual setups need at least one calendar selector:

```bash
export API_BEARER_TOKEN=replace-me
export COOKIE_BUNDLE_PATH=secrets/proton-cookies.json
export TARGET_CALENDAR_ID=cal_123
# or: export ALLOWED_CALENDAR_IDS=cal_123,cal_456
# optional: export DEFAULT_CALENDAR_ID=cal_123
```

`TARGET_CALENDAR_ID` hard-locks all requests to one calendar. Without it, `ALLOWED_CALENDAR_IDS` controls which explicit calendar routes are accepted and `DEFAULT_CALENDAR_ID` is used for plain `/v1/events` requests.

## Automation Behavior

On Proton `401`/`403`, the server tries to refresh auth from saved `REFRESH-*` cookies and persists returned `Set-Cookie` headers back to the cookie bundle.

Runtime browser relogin is available but disabled by the generated env file. Enable it only for unattended workers that need recovery beyond cookie refresh:

```bash
export PROTON_AUTO_RELOGIN=1
export PROTON_RELOGIN_MODE=headless
export PROTON_RELOGIN_COOLDOWN_MS=300000
export PROTON_RELOGIN_LOCK_PATH=secrets/proton-cookies.json.relogin.lock
```

The lock prevents multiple processes from opening Chrome at once; the cooldown avoids repeated failed relogin attempts.

## Development And Testing

```bash
pnpm test              # unit/integration tests
pnpm test:unit
pnpm test:live:api     # requires live Proton session/env
pnpm test:live:cli     # requires live Proton session/env
```

CI runs the unit suite first. Live CI jobs run only when `PROTON_USERNAME` and `PROTON_PASSWORD` are present, bootstrap a headless Proton session with Playwright, start the local API server, and run live API/CLI smoke tests. Accounts that require MFA or extra verification are not suitable for the current CI bootstrap.

## Current Limitations

- Requires a local API server; the CLI does not talk directly to Proton for normal event commands.
- Login/bootstrap depends on Chrome and local cookie/session export.
- Supported recurrence frequencies are `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY`; `count` and `until` cannot both be set.
- Event fields are intentionally narrow: no attendee invitation flow, RSVP state, reminder/alert controls, attachments, conference metadata, categories/tags, or arbitrary ICS import/export passthrough.
- `pc edit --clear` is limited to `description` and `location`.
- Live tests require a Proton account/calendar suitable for automated cleanup.

## Omitted From A Longer README

I deliberately left out the full HTTP route reference, detailed cookie extractor internals, CI artifact paths, long sample JSON responses, and git/mirror maintenance notes. Those belong in deeper operator or contributor docs; this draft is meant to get a user from install to useful calendar commands without hiding the auth model or current product boundaries.
