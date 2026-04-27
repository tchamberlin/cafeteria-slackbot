import PostalMime from "postal-mime";
import { handleIngestSideEffects } from "./ingest-notify";
import {
  ingestNormalizedMessage,
  listMenus,
  listMessages,
  loadLunchSpecial,
  loadWeekLunch,
  recordDailyPost,
  reparseStoredMessages,
  storeRawEmail,
} from "./menu-store";
import {
  formatLunchResponse,
  formatWeekLunchResponse,
  parseCommandDate,
  postSlackMessage,
  rollWeekendToMonday,
  slackJson,
  verifySlackRequest,
} from "./slack";
import type { Env, NormalizedEmailMessage } from "./types";

interface EmailEventMessage {
  raw: ReadableStream | ArrayBuffer | string;
  from?: string;
  to?: string;
  headers: Headers;
}

export default {
  async email(message: EmailEventMessage, env: Env): Promise<void> {
    const normalized = await normalizeEmailMessage(message, env);
    const result = await ingestNormalizedMessage(env, normalized);
    await handleIngestSideEffects(env, normalized, result);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const today = parseCommandDate("today");
    const result = await loadLunchSpecial(env, today);
    const post = await postSlackMessage(env, formatLunchResponse(result));
    if (result.status === "ok" && result.special && post.ts) {
      await recordDailyPost(env, {
        date: result.date,
        special: result.special,
        ts: post.ts,
        channel: post.channel,
        postedAt: new Date().toISOString(),
      });
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        allowedSenderConfigured: Boolean(env.ALLOWED_SENDER),
        slackSigningConfigured: Boolean(env.SLACK_SIGNING_SECRET),
      });
    }

    if (url.pathname === "/slack/commands" && request.method === "POST") {
      return handleSlackCommand(request, env);
    }

    if (url.pathname.startsWith("/admin/")) {
      const authError = requireAdminToken(request, env);
      if (authError) {
        return authError;
      }
      return handleAdmin(request, env, url);
    }

    return json({ error: "not_found" }, { status: 404 });
  },
};

async function handleSlackCommand(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlackRequest(request, env, body))) {
    return json({ error: "invalid_slack_signature" }, { status: 401 });
  }

  const form = new URLSearchParams(body);
  const text = (form.get("text") || "").trim();
  try {
    const targetDate = parseCommandDate(text);
    if (text === "") {
      const highlightDate = rollWeekendToMonday(targetDate);
      const week = await loadWeekLunch(env, highlightDate);
      return slackJson(formatWeekLunchResponse(week));
    }
    const result = await loadLunchSpecial(env, targetDate);
    return slackJson(formatLunchResponse(result));
  } catch (error) {
    return slackJson(error instanceof Error ? error.message : "Invalid lunch command.", 200);
  }
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/admin/messages" && request.method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
    return json({ messages: await listMessages(env, Number.isFinite(limit) ? limit : 50) });
  }
  if (url.pathname === "/admin/menus" && request.method === "GET") {
    return json({ menus: await listMenus(env) });
  }
  if (url.pathname === "/admin/reparse" && request.method === "POST") {
    return json(await reparseStoredMessages(env));
  }
  return json({ error: "not_found" }, { status: 404 });
}

async function normalizeEmailMessage(message: EmailEventMessage, env: Env): Promise<NormalizedEmailMessage> {
  const raw = await rawMessageText(message.raw);
  const parsed = await PostalMime.parse(raw);
  const receivedAt = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();
  const id = parsed.messageId || `${receivedAt}-${crypto.randomUUID()}`;
  const rawKey = await storeRawEmail(env, id, receivedAt, raw);
  const subject = parsed.subject || message.headers.get("subject") || "";
  const from = parsed.from?.address || message.from || null;
  const bodyText = String(parsed.text || "");

  return {
    id,
    receivedAt,
    from,
    to: message.to || null,
    subject,
    bodyText: normalizeLineEndings(bodyText).trim(),
    rawKey,
    messageId: parsed.messageId || null,
  };
}

async function rawMessageText(raw: EmailEventMessage["raw"]): Promise<string> {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ReadableStream || raw instanceof ArrayBuffer) {
    return new Response(raw).text();
  }
  return new Response(raw as BodyInit).text();
}

function requireAdminToken(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "server_missing_admin_token" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}
