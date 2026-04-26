#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import esbuild from "esbuild";
import PostalMime from "postal-mime";

const HERE = dirname(new URL(import.meta.url).pathname);
const PARSER_TS = resolvePath(HERE, "..", "src", "menu-parser.ts");

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  process.stderr.write(
    "Usage: npm run parse -- <path/to/file.eml> [--text-only] [--html-only]\n" +
      "  --text-only    Only run the plain-text body through the parser.\n" +
      "  --html-only    Only run the HTML body through the parser.\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}
const emlPath = args.find((a) => !a.startsWith("--"));
if (!emlPath) {
  process.stderr.write("error: missing .eml path\n");
  process.exit(1);
}

const bundled = await esbuild.build({
  entryPoints: [PARSER_TS],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const tmp = mkdtempSync(join(tmpdir(), "parse-eml-"));
const bundlePath = join(tmp, "menu-parser.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].contents);
const { isCafeteriaMenuSubject, normalizeBodyToText, parseCafeteriaMenuEmail } = await import(pathToFileURL(bundlePath).href);

const raw = readFileSync(emlPath, "utf8");
const email = await PostalMime.parse(raw);
const receivedAt = email.date ? new Date(email.date).toISOString() : undefined;

const textOnly = args.includes("--text-only");
const htmlOnly = args.includes("--html-only");

printSection("Headers", {
  subject: email.subject ?? null,
  from: email.from?.address ?? null,
  fromName: email.from?.name ?? null,
  replyTo: email.replyTo?.[0]?.address ?? null,
  date: receivedAt ?? null,
  hasHtml: Boolean(email.html),
  hasText: Boolean(email.text),
  isCafeteriaMenuSubject: isCafeteriaMenuSubject(email.subject || ""),
});

if (!htmlOnly) {
  runOne("Plain text body", String(email.text || ""), "text", email.subject || "", receivedAt);
}
if (!textOnly && email.html) {
  runOne("HTML body", String(email.html), "html", email.subject || "", receivedAt);
}

if (!htmlOnly && !textOnly) {
  const pref = email.html ? "HTML" : "text";
  process.stdout.write(`\n(worker prefers ${pref} when ingesting this message)\n`);
}

function runOne(label, body, contentType, subject, receivedAt) {
  process.stdout.write(`\n=== ${label}: normalized ===\n`);
  process.stdout.write(normalizeBodyToText(body, contentType) + "\n");
  try {
    const menu = parseCafeteriaMenuEmail(subject, body, contentType, receivedAt);
    printSection(`${label}: parsed`, menu);
  } catch (error) {
    process.stdout.write(`\n=== ${label}: parse error ===\n${error.message}\n`);
  }
}

function printSection(label, payload) {
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
