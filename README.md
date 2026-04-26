# Cafeteria Slackbot

Cloudflare Worker that receives cafeteria menu email, parses weekday specials into KV, and answers Slack `/lunch` slash commands.

```text
Cafeteria email
  -> Cloudflare Email Routing Worker
  -> parse menu
  -> store parsed menu in KV

Slack /lunch
  -> POST /slack/commands
  -> verify Slack signature
  -> read parsed menu from KV
  -> return Slack JSON
```

The deployed system is a single Cloudflare Worker with KV storage.

## Worker

```bash
npm install
npm test
npm run typecheck
npm run deploy
```

Run a `.eml` file through the parser locally to inspect what the worker would see:

```bash
npm run parse -- example_menu_email.eml                   # regex parse
npm run parse -- example_menu_email.eml --show-prompt     # print exact LLM input — no API call
npm run parse -- example_menu_email.eml --llm             # send to Claude (needs ANTHROPIC_API_KEY in env)
```

Or point it at any other file (e.g. `.txt`) — contents are used as the body verbatim, with `--subject`, `--date`, and `--model` flags to override:

```bash
npm run parse -- weird_format.txt --subject "Menu Apr 27 - May 1" --date 2026-04-26
npm run parse -- weird_format.txt --llm --model claude-sonnet-4-6-20251022
```

The LLM path receives only `subject`, normalized `body`, and `receivedAt` — no `From`/`To`/`Reply-To` ever leaves the machine.

Simulate the multi-message ingest pipeline (in-memory KV, real LLM if `ANTHROPIC_API_KEY` is in env) — useful for testing how a normal menu followed by a correction is reranked into the new authoritative:

```bash
npm run ingest-sim -- \
  --message test_emails/normal_menu.txt   --subject "Cafeteria Menu Apr 27 - May 1" --date 2026-04-23T14:00:00Z \
  --message test_emails/swap_mon_wed.txt  --subject "CORRECTION: Menu Apr 27"       --date 2026-04-26T18:00:00Z

# Same but skip the LLM (regex-only, mimics pre-LLM behavior)
npm run ingest-sim -- --no-llm --message test_emails/normal_menu.txt ...
```

Live-API fixture tests (parses each `test_emails/*.txt` with the real API and asserts against per-file expectations) are off by default — they cost real money. Enable with:

```bash
RUN_LLM_TESTS=1 npm test -- test/llm-fixtures.test.ts
```

Post a `.eml` directly to a real Slack channel (no Worker, no KV — bypasses everything to test the message itself):

```bash
npm run send -- example_menu_email.eml --dry-run         # print, don't post
npm run send -- example_menu_email.eml                   # post today's special
npm run send -- example_menu_email.eml --date 2026-04-30 # post a specific day
```

Reads `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` from process env.

## Cloudflare Setup

Create a KV namespace and put its id in `wrangler.toml`:

```bash
npx wrangler kv namespace create MENU_STORE
```

Configure secrets or dashboard variables:

```bash
npx wrangler secret put ALLOWED_SENDER
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_CHANNEL_ID
npx wrangler secret put SLACK_ADMIN_CHANNEL_ID  # optional; admin alerts go here
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY       # optional; enables LLM-assisted parsing
npx wrangler secret put LLM_PARSE_ENABLED       # set to "true" to actually use ANTHROPIC_API_KEY
```

`SLACK_ADMIN_CHANNEL_ID` is the channel (or self-DM) the worker posts to when it detects a follow-up cafeteria email (a 2nd+ email for the same week, including corrections) or a parse error on an allowed-sender email. Leave it unset to silence those alerts.

`ANTHROPIC_API_KEY` + `LLM_PARSE_ENABLED=true` together turn on Claude Haiku as a fallback when the regex parser throws, and as the primary parser when an email is flagged as a correction. Without both set, parsing is regex-only (default behavior). Recommended Anthropic-side setup: in the Anthropic Console create a dedicated workspace, set a low monthly spend limit on it (e.g. $5/mo — orders of magnitude above expected usage at ~1 menu/week), and generate the API key inside that workspace. The cap follows the workspace, so rotating keys preserves the budget. Raw LLM responses are persisted to `emails/llm-parses/<id>.json` in KV for debugging.

The LLM model is set via the plain-text `LLM_MODEL` var in `wrangler.toml` (or the dashboard) — bump it without redeploying secrets when newer Haiku/Sonnet revisions ship. Defaults to `claude-haiku-4-5-20251001` if unset.

`ALLOWED_SENDER` must be the exact cafeteria sender address. For mailing-list-delivered menus (e.g. `gbemploy@listmgr.nrao.edu`), use the list address — Mailman rewrites `From:` to the list itself even when a human authored the message. Messages from any other sender are stored as normalized email records but ignored for menu parsing and Slack results.

Route the cafeteria destination address to this Worker in Cloudflare Email Routing.

## Slack Setup

Create a Slack slash command:

```text
Command: /lunch
Request URL: https://<worker-domain>/slack/commands
```

The Worker uses Slack's signing secret and direct slash-command responses.

For the daily channel post, the Slack app also needs a bot token (`xoxb-...`) with the `chat:write` scope, invited to the target channel. `SLACK_CHANNEL_ID` is the channel ID (e.g. `C0123ABC`), not the name.

The cron is set in `wrangler.toml` (`[triggers] crons = ["0 13 * * *"]`, UTC). 13:00 UTC = 9:00 EDT / 8:00 EST — bump to 14 during EST if you care.

Supported command text:

```text
/lunch
/lunch today
/lunch tomorrow
/lunch 2026-04-27
```

## Endpoints

Public:

```text
GET  /health
POST /slack/commands
```

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`:

```text
GET  /admin/messages
GET  /admin/menus
POST /admin/reparse
```

## KV Keys

```text
emails/raw/<timestamp>-<id>.eml
emails/normalized/<id>.json
emails:index
emails/parse-errors/<id>.json
emails/llm-parses/<id>.json  # raw Anthropic request/response, when LLM_PARSE_ENABLED=true
menus/week/<YYYY-MM-DD>
menus/latest
menus:index
posts/<YYYY-MM-DD>          # ts/channel of each daily Slack post, used to thread correction notices
```
