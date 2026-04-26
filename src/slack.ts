import type { Env, LunchSpecialResult } from "./types";

const COMMAND_USAGE = "Use `/lunch`, `/lunch today`, `/lunch tomorrow`, or `/lunch YYYY-MM-DD`.";
const FIVE_MINUTES_SECONDS = 60 * 5;

export async function verifySlackRequest(request: Request, env: Env, body: string): Promise<boolean> {
  if (!env.SLACK_SIGNING_SECRET) {
    return false;
  }

  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";
  const timestampSeconds = Number(timestamp);
  if (!signature || !Number.isFinite(timestampSeconds)) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > FIVE_MINUTES_SECONDS) {
    return false;
  }

  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  return timingSafeEqual(signature, `v0=${hex(digest)}`);
}

export function parseCommandDate(text: string, today = new Date()): string {
  const normalized = text.trim().toLowerCase();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!normalized || normalized === "today") {
    return isoDate(base);
  }
  if (normalized === "tomorrow") {
    base.setUTCDate(base.getUTCDate() + 1);
    return isoDate(base);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && isoDate(parsed) === normalized) {
      return normalized;
    }
  }
  throw new Error(COMMAND_USAGE);
}

export function formatLunchResponse(result: LunchSpecialResult): string {
  if (result.status === "ok" && result.special) {
    return `*${result.date} cafeteria special:* ${result.special}${formatSource(result)}`;
  }

  if (result.status === "parse_error") {
    const detail = result.error ? `\nParser error: ${result.error}` : "";
    return `I found a cafeteria menu email for ${result.date}, but could not parse weekday specials from it.${formatSource(result)}${detail}`;
  }

  if (result.sourceSubject) {
    return `No cafeteria special was listed for ${result.date}.${formatSource(result)}`;
  }
  return `No cafeteria menu email was found for ${result.date}.`;
}

export function slackJson(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text,
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function formatSource(result: LunchSpecialResult): string {
  if (!result.sourceSubject) {
    return "";
  }
  const superseded = result.sourceSupersededCount
    ? ` (${result.sourceSupersededCount} older menu email${result.sourceSupersededCount === 1 ? "" : "s"} superseded)`
    : "";
  return `\nSource: ${result.sourceSubject}${superseded}`;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
