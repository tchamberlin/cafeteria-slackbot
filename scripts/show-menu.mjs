#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { loadBundle } from "./_bundle.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolvePath(HERE, "..");
const TZ_TS = join(ROOT, "src", "tz.ts");
const DEV_VARS = join(ROOT, ".dev.vars");

const { CAFETERIA_TZ, isoDateInZone } = await loadBundle(TZ_TS);

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stderr.write(
    [
      "Usage: npm run menu [-- options]",
      "",
      "Prints the cafeteria menu starting today through today+5 by default.",
      "",
      "Options:",
      "  --days N            Number of days to show (default: 6 — today + 5)",
      "  --start YYYY-MM-DD  Start date (default: today)",
      "  --json              Print the raw /admin/menus payload instead",
      "",
      "Reads WORKER_URL and ADMIN_TOKEN from .dev.vars or process env.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const days = Number(flagValue("--days") ?? 6);
if (!Number.isInteger(days) || days < 1) fail("--days must be a positive integer");
const start = flagValue("--start") ?? isoToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail("--start must be YYYY-MM-DD");
const asJson = args.includes("--json");

const env = { ...loadDevVars(DEV_VARS), ...process.env };
const url = (env.WORKER_URL || "").replace(/\/+$/, "");
const token = env.ADMIN_TOKEN;
if (!url) fail("WORKER_URL is not set (in .dev.vars or env)");
if (!token) fail("ADMIN_TOKEN is not set (in .dev.vars or env)");

const response = await fetch(`${url}/admin/menus`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
  fail(`GET /admin/menus failed: http_${response.status} ${await response.text().catch(() => "")}`);
}
const { menus } = await response.json();

if (asJson) {
  process.stdout.write(JSON.stringify(menus, null, 2) + "\n");
  process.exit(0);
}

const byDate = {};
for (const menu of menus || []) {
  const specials = menu?.authoritative?.specialsByDate;
  if (specials) Object.assign(byDate, specials);
}

const lines = [];
for (let i = 0; i < days; i += 1) {
  const date = addDays(start, i);
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: CAFETERIA_TZ,
  });
  const special = byDate[date];
  lines.push(`${weekday} ${date}  ${special || "(no menu)"}`);
}
process.stdout.write(lines.join("\n") + "\n");

function isoToday() {
  return isoDateInZone(new Date());
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
