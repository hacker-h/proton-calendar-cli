export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_LOCAL_CONFIG_PATH = "secrets/pc-cli.json";
export const DEFAULT_SERVER_ENV_PATH = "secrets/pc-server.env";
export const DEFAULT_COOKIE_BUNDLE_PATH = "secrets/proton-cookies.json";
export const DEFAULT_PROTON_BASE_URL = "https://calendar.proton.me";
export const DEFAULT_TIMEOUT_MS = 15000;
export const LIST_PAGE_LIMIT = 100;
export const CLEARABLE_FIELDS = new Set(["description", "location", "notifications"]);
export const VALID_TIMEZONES = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

export const HELP_TEXT = `pc - Proton Calendar CLI

Usage:
  pc login [options]
  pc logout [options]
  pc doctor auth [options]
  pc calendars [options]
  pc ls [today|tomorrow|next N|w|w+|w++|m|y|all] [--protected|--unprotected] [--title TEXT] [--description TEXT] [--location TEXT] [args]
  pc new <field=value...> [--tz TIMEZONE]
  pc edit <eventId> <field=value...> [--tz TIMEZONE] [--clear FIELD]
  pc rm <eventId>

Examples:
  pc login
  pc logout
  pc doctor auth
  pc calendars
  pc ls
  pc ls today --title review
  pc ls tomorrow --unprotected
  pc ls next 7 --location "room a"
  pc ls w+
  pc ls m 7 2026
  pc ls --from 2026-07-01 --to 2026-07-31
  pc ls --protected
  pc ls --unprotected
  pc ls --title review
  pc ls --description workshop
  pc ls --location "room a"
  pc new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC
  pc new title="Reminder" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC notifications='[{"Type":1,"Trigger":"-PT10M"}]'
  pc edit evt-1 title="Updated" --clear description
  pc edit evt-1 notifications=null
  pc edit evt-1 --scope single --at 2026-03-12T09:00:00Z location="Room B"
  pc rm evt-1 --scope series

Environment:
  PC_API_BASE_URL     API base URL (default: http://127.0.0.1:8787)
  PC_API_TOKEN        Bearer token for API requests
  API_BEARER_TOKEN    Fallback token env var
  PC_CONFIG_PATH      Optional path to local CLI config JSON
  PC_SERVER_ENV_PATH  Optional path to generated server env file
  .env                Optional local env file; shell env values take precedence

Login options:
  --target-calendar <id>  Use specific calendar ID (default: first available)
  --default-calendar <id> Use specific default calendar while allowing all discovered calendars
  --timeout <seconds>     Bootstrap login timeout (forwarded)
  --poll <seconds>        Bootstrap polling interval (forwarded)
  --profile-dir <path>    Chrome profile directory (forwarded)
  --chrome-path <path>    Chrome executable path (forwarded)
  --cookie-bundle <path>  Cookie bundle output path

Logout options:
  --cookie-bundle <path>  Cookie bundle path to remove
  --pc-config <path>      Local CLI config path to remove
  --server-env <path>     Server env path to remove

Doctor options:
  --cookie-bundle <path>  Cookie bundle path to inspect
  --proton-base-url <url> Proton base URL to probe
  --fail-on-relogin-required  Exit non-zero when browser login is required

Calendars options:
  --set-default <id> Set the default calendar in the generated server env file
  --server-env <path> Server env file to update when setting default

List options:
  --protected         Show only protected events
  --unprotected       Show only unprotected events
  --title <text>       Show only events whose title contains text (case-insensitive)
  --description <text> Show only events whose description contains text (case-insensitive)
  --location <text>    Show only events whose location contains text (case-insensitive)
  --from <date>        Range start; YYYY-MM-DD stays at 00:00:00Z of that day
  --to <date>          Range end; YYYY-MM-DD advances to 00:00:00Z of the next day (inclusive through end of day)
  --start <datetime>   Range start; YYYY-MM-DD advances to 00:00:00Z (same as --from)
  --end <datetime>     Range end; YYYY-MM-DD advances to 00:00:00Z of the next day (same as --to)

Mutation fields:
  notifications      Null or an array of up to 10 Proton-compatible notification objects; omitted edit fields are preserved

Local config JSON (default: secrets/pc-cli.json):
  { "apiBaseUrl": "http://127.0.0.1:8787", "apiToken": "replace-me" }
`;
