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
npm run parse -- example_menu_email.eml
# Optional flags:
#   --text-only   only run the plain-text body
#   --html-only   only run the HTML body
```

## Cloudflare Setup

Create a KV namespace and put its id in `wrangler.toml`:

```bash
npx wrangler kv namespace create MENU_STORE
```

Configure secrets or dashboard variables:

```bash
npx wrangler secret put ALLOWED_SENDER
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put ADMIN_TOKEN
```

`ALLOWED_SENDER` must be the exact cafeteria sender address. For mailing-list-delivered menus (e.g. `gbemploy@listmgr.nrao.edu`), use the list address — Mailman rewrites `From:` to the list itself even when a human authored the message. Messages from any other sender are stored as normalized email records but ignored for menu parsing and Slack results.

Route the cafeteria destination address to this Worker in Cloudflare Email Routing.

## Slack Setup

Create a Slack slash command:

```text
Command: /lunch
Request URL: https://<worker-domain>/slack/commands
```

The Worker uses Slack's signing secret and direct slash-command responses.

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
menus/week/<YYYY-MM-DD>
menus/latest
menus:index
```
