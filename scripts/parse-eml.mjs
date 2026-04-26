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
  process.stderr.write("Usage: npm run parse -- <path/to/file.eml>\n");
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
const body = String(email.text || "");

printSection("Headers", {
  subject: email.subject ?? null,
  from: email.from?.address ?? null,
  fromName: email.from?.name ?? null,
  replyTo: email.replyTo?.[0]?.address ?? null,
  date: receivedAt ?? null,
  hasText: Boolean(email.text),
  isCafeteriaMenuSubject: isCafeteriaMenuSubject(email.subject || ""),
});

process.stdout.write("\n=== Plain text body: normalized ===\n");
process.stdout.write(normalizeBodyToText(body) + "\n");
try {
  const menu = parseCafeteriaMenuEmail(email.subject || "", body, receivedAt);
  printSection("Plain text body: parsed", menu);
} catch (error) {
  process.stdout.write(`\n=== Plain text body: parse error ===\n${error.message}\n`);
}

function printSection(label, payload) {
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
