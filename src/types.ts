export interface Env {
  MENU_STORE: KVNamespace;
  ALLOWED_SENDER?: string;
  SLACK_SIGNING_SECRET?: string;
  ADMIN_TOKEN?: string;
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
