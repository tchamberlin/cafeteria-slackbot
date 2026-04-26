import {
  CafeteriaMenuParseError,
  type Env,
  type LunchSpecialResult,
  type MenuCandidate,
  type NormalizedEmailMessage,
  type StoredWeekMenu,
} from "./types";
import { isCafeteriaMenuSubject, parseCafeteriaMenuEmail } from "./menu-parser";

export const EMAIL_INDEX_KEY = "emails:index";
export const MENU_INDEX_KEY = "menus:index";
export const LATEST_MENU_KEY = "menus/latest";
export const MAX_STORED_MESSAGES = 100;

export async function ingestNormalizedMessage(
  env: Env,
  message: NormalizedEmailMessage,
): Promise<{ ignored: boolean; parsed: boolean; weekStart?: string; error?: string }> {
  await storeNormalizedMessage(env, message);

  if (!isAllowedSender(env, message.from)) {
    return { ignored: true, parsed: false, error: "sender_not_allowed" };
  }

  if (!isCafeteriaMenuSubject(message.subject)) {
    return { ignored: true, parsed: false };
  }

  try {
    const parsed = parseCafeteriaMenuEmail(
      message.subject,
      message.bodyText,
      message.receivedAt,
    );
    const candidate: MenuCandidate = {
      weekStart: parsed.weekStart,
      weekEnd: parsed.weekEnd,
      specialsByDate: parsed.specialsByDate,
      correctionHint: parsed.correctionHint,
      sourceSubject: message.subject,
      sourceReceivedAt: message.receivedAt,
      sourceMessageId: message.messageId || message.id,
    };
    await upsertMenuCandidate(env, candidate);
    return { ignored: false, parsed: true, weekStart: parsed.weekStart };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    await env.MENU_STORE.put(parseErrorKey(message.id), JSON.stringify({ message, error: parseError }));
    return {
      ignored: false,
      parsed: false,
      weekStart: error instanceof CafeteriaMenuParseError ? error.weekStart : undefined,
      error: parseError,
    };
  }
}

export async function upsertMenuCandidate(env: Env, candidate: MenuCandidate): Promise<StoredWeekMenu> {
  const key = weekMenuKey(candidate.weekStart);
  const existing = await env.MENU_STORE.get<StoredWeekMenu>(key, "json");
  const candidates = dedupeCandidates([candidate, ...(existing?.candidates || [])]);
  candidates.sort(compareCandidatesDescending);
  const authoritative = candidates[0];
  const menu: StoredWeekMenu = {
    version: 1,
    generatedAt: new Date().toISOString(),
    weekStart: candidate.weekStart,
    weekEnd: candidate.weekEnd,
    candidates,
    authoritative,
  };

  await env.MENU_STORE.put(key, JSON.stringify(menu));
  await env.MENU_STORE.put(LATEST_MENU_KEY, JSON.stringify(menu));
  await addToStringIndex(env, MENU_INDEX_KEY, candidate.weekStart);
  return menu;
}

export async function loadLunchSpecial(env: Env, targetDate: string): Promise<LunchSpecialResult> {
  const weekStart = weekStartForIsoDate(targetDate);
  const menu = await env.MENU_STORE.get<StoredWeekMenu>(weekMenuKey(weekStart), "json");
  if (!menu?.authoritative) {
    return missingResult(targetDate);
  }

  const special = menu.authoritative.specialsByDate[targetDate] || null;
  return {
    date: targetDate,
    special,
    status: special ? "ok" : "missing",
    sourceSubject: menu.authoritative.sourceSubject,
    sourceReceivedAt: menu.authoritative.sourceReceivedAt,
    sourceMessageId: menu.authoritative.sourceMessageId,
    sourceSupersededCount: Math.max(menu.candidates.length - 1, 0),
  };
}

export async function listMessages(env: Env, limit = 50): Promise<NormalizedEmailMessage[]> {
  const index = await readJson<string[]>(env, EMAIL_INDEX_KEY, []);
  const keys = index.slice(0, clamp(limit, 1, MAX_STORED_MESSAGES)).map((id) => normalizedMessageKey(id));
  const messages = await Promise.all(keys.map((key) => env.MENU_STORE.get<NormalizedEmailMessage>(key, "json")));
  return messages.filter((message): message is NormalizedEmailMessage => Boolean(message));
}

export async function listMenus(env: Env): Promise<StoredWeekMenu[]> {
  const index = await readJson<string[]>(env, MENU_INDEX_KEY, []);
  const menus = await Promise.all(index.map((weekStart) => env.MENU_STORE.get<StoredWeekMenu>(weekMenuKey(weekStart), "json")));
  return menus.filter((menu): menu is StoredWeekMenu => Boolean(menu));
}

export async function reparseStoredMessages(env: Env): Promise<{ messages: number; menus: number; errors: number }> {
  const messages = await listMessages(env, MAX_STORED_MESSAGES);
  const candidatesByWeek = new Map<string, MenuCandidate[]>();
  let errors = 0;

  for (const message of messages) {
    if (!isCafeteriaMenuSubject(message.subject)) {
      continue;
    }
    try {
      const parsed = parseCafeteriaMenuEmail(
        message.subject,
        message.bodyText,
        message.receivedAt,
      );
      const candidate: MenuCandidate = {
        weekStart: parsed.weekStart,
        weekEnd: parsed.weekEnd,
        specialsByDate: parsed.specialsByDate,
        correctionHint: parsed.correctionHint,
        sourceSubject: message.subject,
        sourceReceivedAt: message.receivedAt,
        sourceMessageId: message.messageId || message.id,
      };
      candidatesByWeek.set(parsed.weekStart, [candidate, ...(candidatesByWeek.get(parsed.weekStart) || [])]);
    } catch {
      errors += 1;
    }
  }

  for (const [weekStart, candidates] of candidatesByWeek) {
    const deduped = dedupeCandidates(candidates).sort(compareCandidatesDescending);
    const menu: StoredWeekMenu = {
      version: 1,
      generatedAt: new Date().toISOString(),
      weekStart,
      weekEnd: deduped[0].weekEnd,
      candidates: deduped,
      authoritative: deduped[0],
    };
    await env.MENU_STORE.put(weekMenuKey(weekStart), JSON.stringify(menu));
    await addToStringIndex(env, MENU_INDEX_KEY, weekStart);
  }

  const latest = [...candidatesByWeek.keys()].sort().at(-1);
  if (latest) {
    const latestMenu = await env.MENU_STORE.get(weekMenuKey(latest));
    if (latestMenu) {
      await env.MENU_STORE.put(LATEST_MENU_KEY, latestMenu);
    }
  }

  return { messages: messages.length, menus: candidatesByWeek.size, errors };
}

export async function storeRawEmail(
  env: Env,
  id: string,
  receivedAt: string,
  raw: string,
): Promise<string> {
  const key = `emails/raw/${receivedAt.replace(/[:.]/g, "-")}-${safeKey(id)}.eml`;
  await env.MENU_STORE.put(key, raw);
  return key;
}

export function isAllowedSender(env: Env, sender: string | null): boolean {
  const allowed = env.ALLOWED_SENDER?.trim().toLowerCase();
  if (!allowed) {
    return false;
  }
  return normalizeEmailAddress(sender) === normalizeEmailAddress(allowed);
}

async function storeNormalizedMessage(env: Env, message: NormalizedEmailMessage): Promise<void> {
  await env.MENU_STORE.put(normalizedMessageKey(message.id), JSON.stringify(message), {
    metadata: {
      receivedAt: message.receivedAt,
      subject: message.subject,
      from: message.from || "",
    },
  });
  await addToStringIndex(env, EMAIL_INDEX_KEY, message.id, MAX_STORED_MESSAGES);
}

async function addToStringIndex(env: Env, key: string, value: string, maxItems = 200): Promise<void> {
  const index = await readJson<string[]>(env, key, []);
  const deduped = [value, ...index.filter((item) => item !== value)].slice(0, maxItems);
  await env.MENU_STORE.put(key, JSON.stringify(deduped));
}

function dedupeCandidates(candidates: MenuCandidate[]): MenuCandidate[] {
  const byMessage = new Map<string, MenuCandidate>();
  for (const candidate of candidates) {
    byMessage.set(candidate.sourceMessageId, candidate);
  }
  return [...byMessage.values()];
}

function compareCandidatesDescending(left: MenuCandidate, right: MenuCandidate): number {
  return (
    Number(right.correctionHint) - Number(left.correctionHint) ||
    right.sourceReceivedAt.localeCompare(left.sourceReceivedAt) ||
    right.sourceMessageId.localeCompare(left.sourceMessageId)
  );
}

async function readJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  const value = await env.MENU_STORE.get<T>(key, "json");
  return value ?? fallback;
}

function missingResult(targetDate: string): LunchSpecialResult {
  return {
    date: targetDate,
    special: null,
    status: "missing",
    sourceSubject: null,
    sourceReceivedAt: null,
    sourceMessageId: null,
    sourceSupersededCount: 0,
  };
}

function weekStartForIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

function weekMenuKey(weekStart: string): string {
  return `menus/week/${weekStart}`;
}

function normalizedMessageKey(id: string): string {
  return `emails/normalized/${safeKey(id)}.json`;
}

function parseErrorKey(id: string): string {
  return `emails/parse-errors/${safeKey(id)}.json`;
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
}

function normalizeEmailAddress(value: string | null | undefined): string {
  const normalized = (value || "").trim().toLowerCase();
  const match = /<([^>]+)>/.exec(normalized);
  return (match?.[1] || normalized).replace(/^mailto:/, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
