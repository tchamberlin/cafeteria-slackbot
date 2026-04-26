import {
  CafeteriaMenuParseError,
  type Env,
  type ParsedCafeteriaMenu,
} from "./types";
import { normalizeBodyToText } from "./menu-parser";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const TOOL_NAME = "record_menu";

const SYSTEM_PROMPT = [
  "You parse cafeteria menu emails into structured JSON via the record_menu tool.",
  "",
  "Rules:",
  "- Only extract Monday-Friday weekday specials. Ignore weekend items, holiday closures, picnic notices, and special events.",
  "- Anchor week dates to the email's RECEIVED_AT timestamp, which is provided. If the subject or body explicitly states the week (\"Week of August 4\", \"Aug 4-8\", \"Cafeteria Menu April 27 - May 1\"), that is authoritative.",
  "- Output dates must be ISO calendar dates (YYYY-MM-DD) — the actual Monday and Friday of the covered week.",
  "- specialsByDate keys are ISO dates, not weekday names.",
  "- If the email is a CORRECTION (\"corrected\", \"updated\", \"switch X and Y menus\", \"today's menu is now Z instead of Y\", \"please disregard\"), apply the correction so output reflects the FINAL state. Do not return pre-correction values.",
  "- If the email only changes a single day (e.g. \"today's lunch is now lasagna\"), return only that day in specialsByDate, with the date matching RECEIVED_AT (in UTC).",
  "- Set correctionHint=true when the email amends a previously sent menu. Set false for fresh weekly announcements.",
  "- Strip ornamental punctuation (asterisks, leading dashes, trailing colons) from special descriptions.",
  "- If you cannot determine the week or no weekday specials are present, call the tool with an empty specialsByDate; the caller treats that as a parse failure.",
].join("\n");

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: "Record the parsed weekday lunch menu extracted from a cafeteria email.",
  input_schema: {
    type: "object",
    required: ["weekStart", "weekEnd", "specialsByDate", "sourceSubject", "correctionHint"],
    properties: {
      weekStart: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Monday of the covered week, ISO date (YYYY-MM-DD).",
      },
      weekEnd: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Friday of the covered week, ISO date (YYYY-MM-DD).",
      },
      specialsByDate: {
        type: "object",
        description: "Map of ISO date (YYYY-MM-DD) to the lunch special string for that weekday. Empty when no specials can be extracted.",
        additionalProperties: { type: "string" },
      },
      sourceSubject: {
        type: "string",
        description: "The original email subject, trimmed.",
      },
      correctionHint: {
        type: "boolean",
        description: "True if this email amends, corrects, swaps, or replaces a previously sent menu.",
      },
    },
  },
} as const;

export interface LlmParseInput {
  subject: string;
  body: string;
  receivedAt: string;
}

export function buildLlmUserMessage({ subject, body, receivedAt }: LlmParseInput): string {
  const cleanedBody = normalizeBodyToText(body);
  return `RECEIVED_AT: ${receivedAt}\n\nSUBJECT:\n${subject.trim()}\n\nBODY:\n${cleanedBody}`;
}

export async function parseCafeteriaMenuWithLlm(
  env: Env,
  subject: string,
  body: string,
  receivedAt: string,
  messageId?: string,
): Promise<ParsedCafeteriaMenu> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CafeteriaMenuParseError("ANTHROPIC_API_KEY is not set; cannot call LLM parser");
  }

  const userMessage = buildLlmUserMessage({ subject, body, receivedAt });
  const requestBody = {
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEFINITION],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userMessage }],
  };

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new CafeteriaMenuParseError(
      `Anthropic API error ${response.status}: ${responseText.slice(0, 500)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new CafeteriaMenuParseError("Anthropic API returned non-JSON response");
  }

  if (env.MENU_STORE && messageId) {
    await env.MENU_STORE.put(
      `emails/llm-parses/${safeKey(messageId)}.json`,
      JSON.stringify({ receivedAt, request: requestBody, response: payload }, null, 2),
    );
  }

  const toolInput = extractToolInput(payload);
  return validateParsed(toolInput, subject);
}

function extractToolInput(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    throw new CafeteriaMenuParseError("Anthropic response was not an object");
  }
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new CafeteriaMenuParseError("Anthropic response missing content array");
  }
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === TOOL_NAME
    ) {
      return (block as { input?: unknown }).input;
    }
  }
  throw new CafeteriaMenuParseError("Anthropic response did not include a record_menu tool call");
}

function validateParsed(input: unknown, fallbackSubject: string): ParsedCafeteriaMenu {
  if (!input || typeof input !== "object") {
    throw new CafeteriaMenuParseError("LLM tool input was not an object");
  }
  const record = input as Record<string, unknown>;
  const weekStart = record.weekStart;
  const weekEnd = record.weekEnd;
  const specialsByDate = record.specialsByDate;
  const sourceSubject = typeof record.sourceSubject === "string" ? record.sourceSubject : fallbackSubject.trim();
  const correctionHint = Boolean(record.correctionHint);

  if (!isIsoDate(weekStart)) {
    throw new CafeteriaMenuParseError(`LLM returned invalid weekStart: ${JSON.stringify(weekStart)}`);
  }
  if (!isIsoDate(weekEnd)) {
    throw new CafeteriaMenuParseError(`LLM returned invalid weekEnd: ${JSON.stringify(weekEnd)}`, weekStart);
  }
  if (!specialsByDate || typeof specialsByDate !== "object" || Array.isArray(specialsByDate)) {
    throw new CafeteriaMenuParseError("LLM returned invalid specialsByDate", weekStart);
  }

  const cleaned: Record<string, string> = {};
  for (const [date, special] of Object.entries(specialsByDate as Record<string, unknown>)) {
    if (isIsoDate(date) && typeof special === "string" && special.trim().length > 0) {
      cleaned[date] = special.trim();
    }
  }
  if (Object.keys(cleaned).length === 0) {
    throw new CafeteriaMenuParseError("LLM returned no weekday specials", weekStart);
  }

  return { weekStart, weekEnd, specialsByDate: cleaned, sourceSubject, correctionHint };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
}
