#!/usr/bin/env node
// Simulate the multi-message ingest pipeline against an in-memory KV.
//
// Walks each --message block through ingestNormalizedMessage exactly the way
// the Worker does, so you can see how a sequence of emails (e.g. normal menu
// followed by a correction) produces IngestResults, candidate ranking, and
// the final authoritative menu.
//
// Usage:
//   npm run ingest-sim -- \
//     --message test_emails/normal_menu.txt   --date 2026-04-23T14:00:00Z --subject "Cafeteria Menu Apr 27 - May 1" \
//     --message test_emails/swap_mon_wed.txt  --date 2026-04-26T18:00:00Z --subject "CORRECTION: Menu Apr 27"
//
// Per-message flags (apply to the most recent --message): --subject, --date, --from, --id.
// Date may be YYYY-MM-DD (treated as 12:00 UTC) or a full ISO timestamp.

import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import PostalMime from "postal-mime";
import { loadBundle } from "./_bundle.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolvePath(HERE, "..");
const STORE_TS = join(ROOT, "src", "menu-store.ts");

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  process.stderr.write(
    [
      "Usage: npm run ingest-sim -- --message <path> [--subject ...] [--date ...] [--from ...] [--id ...]",
      "                            [--message <path> ...]",
      "",
      "  Walks a sequence of messages through ingestNormalizedMessage with an",
      "  in-memory KV. Prints each IngestResult and the final authoritative menu.",
      "",
      "Per-message flags (apply to the preceding --message):",
      "  --subject <text>      default: from .eml, or 'Cafeteria Menu (test)'",
      "  --date <date>         YYYY-MM-DD or ISO timestamp; default: from .eml or now",
      "  --from <email>        default: matches ALLOWED_SENDER (so the sim doesn't reject)",
      "  --id <id>             default: msg-1, msg-2, ...",
      "",
      "Top-level flags:",
      "  --no-llm              disable LLM hooks even if ANTHROPIC_API_KEY is set",
      "  --allowed-sender <e>  override ALLOWED_SENDER (default: 'sim@example.com')",
    ].join("\n") + "\n",
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const { messages, options } = parseArgs(argv);
if (messages.length === 0) {
  process.stderr.write("error: at least one --message is required\n");
  process.exit(1);
}

class MemoryKV {
  constructor() {
    this.values = new Map();
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value);
    return value;
  }
  async put(key, value /*, options */) {
    this.values.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix } = {}) {
    const keys = [...this.values.keys()]
      .filter((k) => (prefix ? k.startsWith(prefix) : true))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const llmEnabled = !options.noLlm && Boolean(process.env.ANTHROPIC_API_KEY);
const allowedSender = options.allowedSender ?? "sim@example.com";

const env = {
  MENU_STORE: new MemoryKV(),
  ALLOWED_SENDER: allowedSender,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  LLM_PARSE_ENABLED: llmEnabled ? "true" : "false",
  LLM_MODEL: process.env.LLM_MODEL,
};

process.stderr.write(
  `LLM ${llmEnabled ? "ENABLED" : "DISABLED"}` +
    (llmEnabled ? ` (model=${env.LLM_MODEL || "default"})` : "") +
    `\n`,
);

const { ingestNormalizedMessage } = await loadBundle(STORE_TS);

let stepNum = 0;
for (const m of messages) {
  stepNum++;
  const normalized = await buildNormalizedMessage(m, stepNum, allowedSender);
  process.stdout.write(`\n=== Step ${stepNum}: ${m.path} ===\n`);
  process.stdout.write(
    JSON.stringify(
      {
        id: normalized.id,
        from: normalized.from,
        subject: normalized.subject,
        receivedAt: normalized.receivedAt,
        bodyChars: normalized.bodyText.length,
      },
      null,
      2,
    ) + "\n",
  );

  const llmKey = `emails/llm-parses/${normalized.id}.json`;
  const llmCallsBefore = env.MENU_STORE.values.has(llmKey) ? 1 : 0;
  const result = await ingestNormalizedMessage(env, normalized);
  const llmCallsAfter = env.MENU_STORE.values.has(llmKey) ? 1 : 0;
  const usedLlm = llmCallsAfter > llmCallsBefore;
  const path = !result.parsed
    ? "parse-error"
    : usedLlm
      ? "LLM (regex failed or correction primary)"
      : "regex";

  process.stdout.write(`\n--- IngestResult (parsed via: ${path}) ---\n${JSON.stringify(result, null, 2)}\n`);
}

const finalMenu = await loadFinalMenu(env);
process.stdout.write(`\n=== Final stored menu ===\n${JSON.stringify(finalMenu, null, 2)}\n`);

async function buildNormalizedMessage(spec, stepNum, allowedSender) {
  const isEml = extname(spec.path).toLowerCase() === ".eml";
  const raw = readFileSync(spec.path, "utf8");
  const id = spec.id ?? `msg-${stepNum}`;

  if (isEml) {
    const email = await PostalMime.parse(raw);
    return {
      id,
      receivedAt: spec.date
        ? toIso(spec.date)
        : email.date
          ? new Date(email.date).toISOString()
          : new Date().toISOString(),
      from: spec.from ?? email.from?.address ?? allowedSender,
      to: email.to?.[0]?.address ?? null,
      subject: spec.subject ?? email.subject ?? "",
      bodyText: String(email.text || ""),
      rawKey: `sim/raw/${id}`,
      messageId: email.messageId ?? null,
    };
  }

  return {
    id,
    receivedAt: spec.date ? toIso(spec.date) : new Date().toISOString(),
    from: spec.from ?? allowedSender,
    to: null,
    subject: spec.subject ?? "Cafeteria Menu (test)",
    bodyText: raw,
    rawKey: `sim/raw/${id}`,
    messageId: null,
  };
}

async function loadFinalMenu(env) {
  const latest = await env.MENU_STORE.get("menus/latest", "json");
  if (!latest) return null;
  return latest;
}

function parseArgs(argv) {
  const messages = [];
  const options = {};
  const perMessageFlags = new Set(["--subject", "--date", "--from", "--id"]);
  let current = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--message") {
      current = { path: requireValue(argv, ++i, a) };
      messages.push(current);
    } else if (perMessageFlags.has(a)) {
      if (!current) {
        process.stderr.write(`error: ${a} must follow a --message\n`);
        process.exit(1);
      }
      current[a.slice(2)] = requireValue(argv, ++i, a);
    } else if (a === "--no-llm") {
      options.noLlm = true;
    } else if (a === "--allowed-sender") {
      options.allowedSender = requireValue(argv, ++i, a);
    } else {
      process.stderr.write(`error: unknown arg ${a}\n`);
      process.exit(1);
    }
  }
  return { messages, options };
}

function requireValue(argv, idx, flag) {
  const value = argv[idx];
  if (value === undefined) {
    process.stderr.write(`error: ${flag} requires a value\n`);
    process.exit(1);
  }
  return value;
}

function toIso(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00Z`).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    process.stderr.write(`error: invalid --date value: ${value}\n`);
    process.exit(1);
  }
  return d.toISOString();
}

