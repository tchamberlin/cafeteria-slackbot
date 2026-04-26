#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import PostalMime from "postal-mime";
import { loadBundle } from "./_bundle.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolvePath(HERE, "..");
const PARSER_TS = join(ROOT, "src", "menu-parser.ts");
const LLM_PARSER_TS = join(ROOT, "src", "llm-parser.ts");

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  process.stderr.write(
    [
      "Usage: npm run parse -- <path/to/file> [options]",
      "",
      "  <path> may be a .eml (parsed via PostalMime) or any other file",
      "  (e.g. .txt) whose contents are used as the body verbatim.",
      "",
      "Options:",
      "  --show-prompt       Print exactly what would be sent to Claude (no API call)",
      "  --llm               Send to Claude and print the parsed result",
      "                      (requires ANTHROPIC_API_KEY in env)",
      "  --subject <text>    Override subject (default: from .eml, or 'Cafeteria Menu (test)')",
      "  --date <YYYY-MM-DD> Override receivedAt (default: from .eml, or today)",
      "  --model <name>      Override LLM model (default: env LLM_MODEL or built-in)",
    ].join("\n") + "\n",
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const args = parseArgs(argv);
const filePath = args._[0];
if (!filePath) {
  process.stderr.write("error: missing file path\n");
  process.exit(1);
}

const { isCafeteriaMenuSubject, normalizeBodyToText, parseCafeteriaMenuEmail } = await loadBundle(PARSER_TS);

const isEml = extname(filePath).toLowerCase() === ".eml";
const raw = readFileSync(filePath, "utf8");

let subject;
let body;
let receivedAt;
let headerInfo;

if (isEml) {
  const email = await PostalMime.parse(raw);
  subject = args.subject ?? email.subject ?? "";
  body = String(email.text || "");
  receivedAt = args.date
    ? toIsoFromDate(args.date)
    : email.date
      ? new Date(email.date).toISOString()
      : new Date().toISOString();
  headerInfo = {
    subject: subject || null,
    from: email.from?.address ?? null,
    fromName: email.from?.name ?? null,
    replyTo: email.replyTo?.[0]?.address ?? null,
    date: receivedAt,
    hasText: Boolean(email.text),
    isCafeteriaMenuSubject: isCafeteriaMenuSubject(subject),
  };
} else {
  subject = args.subject ?? "Cafeteria Menu (test)";
  body = raw;
  receivedAt = args.date ? toIsoFromDate(args.date) : new Date().toISOString();
  headerInfo = {
    subject,
    source: filePath,
    date: receivedAt,
    isCafeteriaMenuSubject: isCafeteriaMenuSubject(subject),
  };
}

printSection("Headers", headerInfo);

process.stdout.write("\n=== Plain text body: normalized ===\n");
process.stdout.write(normalizeBodyToText(body) + "\n");

try {
  const menu = parseCafeteriaMenuEmail(subject, body, receivedAt);
  printSection("Plain text body: parsed (regex)", menu);
} catch (error) {
  process.stdout.write(`\n=== Plain text body: parse error (regex) ===\n${error.message}\n`);
}

if (args.showPrompt || args.llm) {
  const promptPayload = {
    subject,
    body: normalizeBodyToText(body),
    receivedAt,
  };
  printSection("LLM prompt input (no headers)", promptPayload);
}

if (args.llm) {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("error: ANTHROPIC_API_KEY is not set\n");
    process.exit(1);
  }
  const { parseCafeteriaMenuWithLlm } = await loadBundle(LLM_PARSER_TS);
  try {
    const llmEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      LLM_MODEL: args.model ?? process.env.LLM_MODEL,
    };
    const llmMenu = await parseCafeteriaMenuWithLlm(llmEnv, subject, body, receivedAt);
    printSection("LLM-parsed menu", llmMenu);
  } catch (error) {
    process.stdout.write(`\n=== LLM parse error ===\n${error.message}\n`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  const flagsWithValues = new Set(["--subject", "--date", "--model"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--show-prompt") out.showPrompt = true;
    else if (a === "--llm") out.llm = true;
    else if (flagsWithValues.has(a)) {
      const value = argv[++i];
      if (value === undefined) {
        process.stderr.write(`error: ${a} requires a value\n`);
        process.exit(1);
      }
      out[a.slice(2)] = value;
    } else if (a.startsWith("--")) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      process.exit(1);
    } else {
      out._.push(a);
    }
  }
  return out;
}

function toIsoFromDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    process.stderr.write(`error: --date must be YYYY-MM-DD, got ${dateStr}\n`);
    process.exit(1);
  }
  return new Date(`${dateStr}T12:00:00Z`).toISOString();
}

function printSection(label, payload) {
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
