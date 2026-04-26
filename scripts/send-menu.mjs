#!/usr/bin/env node
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import PostalMime from "postal-mime";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolvePath(HERE, "..");
const PARSER_TS = join(ROOT, "src", "menu-parser.ts");
const SLACK_TS = join(ROOT, "src", "slack.ts");
const DEV_VARS = join(ROOT, ".dev.vars");

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  process.stderr.write(
    [
      "Usage: npm run send -- <path/to/file.eml> [options]",
      "",
      "Options:",
      "  --date YYYY-MM-DD  Pick a specific date (default: today)",
      "  --dry-run          Print the message instead of posting to Slack",
      "",
      "Reads SLACK_BOT_TOKEN and SLACK_CHANNEL_ID from .dev.vars or process env.",
    ].join("\n") + "\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const dryRun = args.includes("--dry-run");
const dateFlagIndex = args.indexOf("--date");
const explicitDate = dateFlagIndex >= 0 ? args[dateFlagIndex + 1] : null;
const emlPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--date");
if (!emlPath) {
  fail("missing .eml path");
}

const env = { ...loadDevVars(DEV_VARS), ...process.env };
if (!dryRun) {
  if (!env.SLACK_BOT_TOKEN) fail("SLACK_BOT_TOKEN is not set (in .dev.vars or env)");
  if (!env.SLACK_CHANNEL_ID) fail("SLACK_CHANNEL_ID is not set (in .dev.vars or env)");
}

const { parseCafeteriaMenuEmail, isCafeteriaMenuSubject } = await loadBundle(PARSER_TS);
const { formatLunchResponse } = await loadBundle(SLACK_TS);

const raw = readFileSync(emlPath, "utf8");
const email = await PostalMime.parse(raw);
const subject = email.subject || "";
const body = String(email.text || "");
const receivedAt = email.date ? new Date(email.date).toISOString() : new Date().toISOString();

if (!isCafeteriaMenuSubject(subject)) {
  process.stderr.write(`warn: subject does not match cafeteria menu pattern: ${JSON.stringify(subject)}\n`);
}

let parsed;
try {
  parsed = parseCafeteriaMenuEmail(subject, body, receivedAt);
} catch (error) {
  fail(`parse failed: ${error.message}`);
}

const targetDate = explicitDate || new Date().toISOString().slice(0, 10);
const special = parsed.specialsByDate[targetDate] || null;
if (!special) {
  const available = Object.keys(parsed.specialsByDate).sort().join(", ") || "(none)";
  const reason = explicitDate ? `no special for ${targetDate}` : `today (${targetDate}) is not in this email`;
  fail(`${reason}. parsed dates: ${available}. pass --date to pick one.`);
}

const text = formatLunchResponse(
  {
    date: targetDate,
    special,
    status: special ? "ok" : "missing",
    sourceSubject: parsed.sourceSubject,
    sourceReceivedAt: receivedAt,
    sourceMessageId: email.messageId || null,
    sourceSupersededCount: 0,
  },
  new Date(`${targetDate}T12:00:00Z`),
);

process.stdout.write(`---\n${text}\n---\n`);

if (dryRun) {
  process.stdout.write("dry-run: not posting to Slack\n");
  process.exit(0);
}

const response = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    "content-type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, mrkdwn: true }),
});
const payload = await response.json().catch(() => null);
if (!response.ok || !payload?.ok) {
  fail(`Slack chat.postMessage failed: ${payload?.error || `http_${response.status}`}`);
}
process.stdout.write(`posted to ${env.SLACK_CHANNEL_ID} (ts=${payload.ts})\n`);

function loadDevVars(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadBundle(entryPath) {
  const built = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(join(tmpdir(), "send-menu-"));
  const out = join(dir, "bundle.mjs");
  writeFileSync(out, built.outputFiles[0].contents);
  return import(pathToFileURL(out).href);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
