export interface Env {
  MENU_STORE: KVNamespace;
  ALLOWED_SENDER?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  SLACK_ADMIN_CHANNEL_ID?: string;
  ADMIN_TOKEN?: string;
}

export interface PostedMenuRecord {
  date: string;
  special: string;
  ts: string;
  channel: string;
  postedAt: string;
}

export interface MenuChange {
  date: string;
  previousSpecial: string | null;
  newSpecial: string | null;
}

export interface IngestResult {
  ignored: boolean;
  parsed: boolean;
  weekStart?: string;
  error?: string;
  followUp: boolean;
  becameAuthoritative: boolean;
  previousAuthoritativeSubject: string | null;
  newAuthoritativeSubject: string | null;
  changedDates: MenuChange[];
}

export interface ParsedCafeteriaMenu {
  weekStart: string;
  weekEnd: string;
  specialsByDate: Record<string, string>;
  sourceSubject: string;
  correctionHint: boolean;
}

export interface NormalizedEmailMessage {
  id: string;
  receivedAt: string;
  from: string | null;
  to: string | null;
  subject: string;
  bodyText: string;
  rawKey: string;
  messageId: string | null;
}

export interface MenuCandidate {
  weekStart: string;
  weekEnd: string;
  specialsByDate: Record<string, string>;
  correctionHint: boolean;
  sourceSubject: string;
  sourceReceivedAt: string;
  sourceMessageId: string;
}

export interface StoredWeekMenu {
  version: 1;
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  candidates: MenuCandidate[];
  authoritative: MenuCandidate;
}

export interface LunchSpecialResult {
  date: string;
  special: string | null;
  status: "ok" | "missing" | "parse_error";
  sourceSubject: string | null;
  sourceReceivedAt: string | null;
  sourceMessageId: string | null;
  sourceSupersededCount: number;
  error?: string;
}

export class CafeteriaMenuParseError extends Error {
  readonly weekStart?: string;

  constructor(message: string, weekStart?: string) {
    super(message);
    this.name = "CafeteriaMenuParseError";
    this.weekStart = weekStart;
  }
}
