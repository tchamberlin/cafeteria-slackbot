import type { Env, LunchSpecialResult, WeekLunchResult } from "./types";
import { CAFETERIA_TZ, isoDateInZone } from "./tz";

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

export function rollWeekendToMonday(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? 1 : day === 6 ? 2 : 0;
  if (offset === 0) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function parseCommandDate(text: string, now = new Date()): string {
  const normalized = text.trim().toLowerCase();
  const today = isoDateInZone(now, CAFETERIA_TZ);
  if (!normalized || normalized === "today") {
    return today;
  }
  if (normalized === "tomorrow") {
    return addUtcDays(today, 1);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && isoDate(parsed) === normalized) {
      return normalized;
    }
  }
  throw new Error(COMMAND_USAGE);
}

export function formatLunchResponse(result: LunchSpecialResult, now = new Date()): string {
  const label = dateLabel(result.date, now);

  if (result.status === "ok" && result.special) {
    return `Menu for ${label}: ${result.special}`;
  }

  if (result.status === "parse_error") {
    const detail = result.error ? `\nParser error: ${result.error}` : "";
    return `Found a menu email for ${label}, but couldn't parse it.${detail}`;
  }

  if (result.sourceSubject) {
    return `No menu listed for ${label}.`;
  }
  return `No menu email found for ${label}.`;
}

export function formatWeekLunchResponse(result: WeekLunchResult, now = new Date()): string {
  const today = isoDateInZone(now, CAFETERIA_TZ);
  const weekLines = buildWeekLines(result);

  if (isWeekend(today) && result.date !== today) {
    const noServiceLine = `No cafeteria service today (${weekdayName(today)}, ${today}).`;
    if (weekLines.length === 0) {
      return `${noServiceLine} No menu yet for next week.`;
    }
    return `${noServiceLine} Here's next week:\n\n${weekLines.join("\n")}`;
  }

  const header = formatLunchResponse(result, now);
  if (weekLines.length === 0) {
    return header;
  }
  return `${header}\n\nThis week:\n${weekLines.join("\n")}`;
}

function isWeekend(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function buildWeekLines(result: WeekLunchResult): string[] {
  const dates = [0, 1, 2, 3, 4].map((offset) => addUtcDays(result.weekStart, offset));
  if (!dates.some((date) => result.weekSpecials[date])) {
    return [];
  }
  return dates.map((date) => {
    const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: CAFETERIA_TZ,
    });
    const special = result.weekSpecials[date] ?? "(no menu)";
    const line = `${weekday} ${date}: ${special}`;
    return date === result.date ? `*${line}*` : line;
  });
}

function dateLabel(targetDate: string, now: Date): string {
  const today = isoDateInZone(now, CAFETERIA_TZ);
  const tomorrow = addUtcDays(today, 1);
  const weekday = weekdayName(targetDate);
  if (targetDate === today) return `today (${weekday}, ${targetDate})`;
  if (targetDate === tomorrow) return `tomorrow (${weekday}, ${targetDate})`;
  return `${weekday} (${targetDate})`;
}

function weekdayName(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: CAFETERIA_TZ,
  });
}

function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface SlackPostResult {
  ts: string;
  channel: string;
}

export async function postSlackMessage(env: Env, text: string): Promise<SlackPostResult> {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured.");
  }
  if (!env.SLACK_CHANNEL_ID) {
    throw new Error("SLACK_CHANNEL_ID is not configured.");
  }
  return chatPostMessage(env.SLACK_BOT_TOKEN, {
    channel: env.SLACK_CHANNEL_ID,
    text,
    mrkdwn: true,
  });
}

export async function postSlackAdminMessage(env: Env, text: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) {
    console.warn("postSlackAdminMessage skipped: SLACK_BOT_TOKEN is not configured.");
    return;
  }
  if (!env.SLACK_ADMIN_CHANNEL_ID) {
    console.warn("postSlackAdminMessage skipped: SLACK_ADMIN_CHANNEL_ID is not configured.");
    return;
  }
  await chatPostMessage(env.SLACK_BOT_TOKEN, {
    channel: env.SLACK_ADMIN_CHANNEL_ID,
    text,
    mrkdwn: true,
  });
}

export async function postSlackThreadReply(
  env: Env,
  channel: string,
  threadTs: string,
  text: string,
): Promise<SlackPostResult> {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured.");
  }
  return chatPostMessage(env.SLACK_BOT_TOKEN, {
    channel,
    thread_ts: threadTs,
    text,
    mrkdwn: true,
  });
}

async function chatPostMessage(
  botToken: string,
  body: { channel: string; text: string; mrkdwn: boolean; thread_ts?: string },
): Promise<SlackPostResult> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string; ts?: string; channel?: string }
    | null;
  if (!response.ok || !payload?.ok) {
    const detail = payload?.error || `http_${response.status}`;
    throw new Error(`Slack chat.postMessage failed: ${detail}`);
  }
  return { ts: payload.ts || "", channel: payload.channel || body.channel };
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
