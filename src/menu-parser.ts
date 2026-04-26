import { CafeteriaMenuParseError, type ParsedCafeteriaMenu } from "./types";

const WEEKDAY_OFFSETS: Record<string, number> = {
  monday: 0,
  mon: 0,
  tuesday: 1,
  tue: 1,
  tues: 1,
  wednesday: 2,
  wed: 2,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  friday: 4,
  fri: 4,
};

const MONTH_NAME_PATTERN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|" +
  "Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

const CORRECTION_MARKERS = /\b(corrected?|update[sd]?|revised?|revision|replacement)\b/i;
const SUBJECT_CORRECTION_MARKERS = /\b(corrected?|changes? to this weeks menu|slight change in todays menu)\b/i;
const INCLUDED_SUBJECT_MARKERS =
  /\b(cafeteria menu|changes to this weeks menu|todays menu|meal planning for next week in cafeteria)\b/i;
const EXCLUDED_SUBJECT_MARKERS = /\b(starlight|weekend|picnic|limited hours|irish stew|maple day)\b/i;
const WEEK_OF_PATTERN = new RegExp(
  String.raw`\bweek\s+of\s+(?<date>(?:[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})|(?:\d{1,2}/\d{1,2}/\d{2,4}))\b`,
  "i",
);
const WEEKDAY_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?<day>monday|mon|tuesday|tue(?:s)?|wednesday|wed|thursday|thu(?:rs?)?|friday|fri)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?\s*[:\-]\s*(?<special>.+?)\s*$/i;
const DATE_RANGE_PATTERNS = [
  new RegExp(
    String.raw`\b(?<month1>${MONTH_NAME_PATTERN})\s+(?<day1>\d{1,2})(?:st|nd|rd|th)?\s*(?:-|[\u2013\u2014]|to|thru)\s*(?<month2>${MONTH_NAME_PATTERN})\s+(?<day2>\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(?<year>\d{2,4})?\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?<month1>${MONTH_NAME_PATTERN})\s+(?<day1>\d{1,2})(?:st|nd|rd|th)?\s*(?:-|[\u2013\u2014]|to|thru)\s*(?<day2>\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(?<year>\d{2,4})?\b`,
    "i",
  ),
  /\b(?<start>\d{1,2}\/\d{1,2})(?:\/\d{2,4})?\s*(?:-|[\u2013\u2014]|to|thru)\s*(?<end>\d{1,2}\/\d{1,2})(?:\/\d{2,4})?\b/i,
  new RegExp(
    String.raw`\bcafeteria menu(?: for)?\s+(?<month1>${MONTH_NAME_PATTERN})\s+(?<day1>\d{1,2})(?:st|nd|rd|th)?\s*(?:-|[\u2013\u2014]|to|thru)\s*(?<month2>${MONTH_NAME_PATTERN})?\s*(?<day2>\d{1,2})(?:st|nd|rd|th)?\b`,
    "i",
  ),
  /\b(?<weekday1>monday|tuesday|wednesday|thursday|friday)\s+(?<day1>\d{1,2})\s*(?:-|[\u2013\u2014]|to|thru)\s*(?<weekday2>monday|tuesday|wednesday|thursday|friday)\s*(?<day2>\d{1,2})\b/i,
];
const SWAP_PATTERN =
  /\bswitch\s+(?<day1>monday|tuesday|wednesday|thursday|friday)\s+and\s+(?<day2>monday|tuesday|wednesday|thursday|friday)(?:'s)?\s+(?:lunch\s+)?menu[s]?\b/gi;
const SWAP_HINT_PATTERN =
  /\bswitch\s+(monday|tuesday|wednesday|thursday|friday)\s+and\s+(monday|tuesday|wednesday|thursday|friday)(?:'s)?\s+(?:lunch\s+)?menu[s]?\b/i;
const TODAY_CHANGE_PATTERN = /\b(?:having|serving)\s+(?:(?:a|an)\s+)?(?<special>.+?)\s+today\b/is;

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export function isCafeteriaMenuSubject(subject: string): boolean {
  const normalized = subject.trim();
  if (!normalized) {
    return false;
  }
  if (EXCLUDED_SUBJECT_MARKERS.test(normalized)) {
    return false;
  }
  return INCLUDED_SUBJECT_MARKERS.test(normalized);
}

export function parseCafeteriaMenuEmail(
  subject: string,
  body: string,
  bodyContentType: "text" | "html" = "text",
  receivedAt?: string | Date,
): ParsedCafeteriaMenu {
  const normalizedText = normalizeBodyToText(body, bodyContentType);
  const todayChange = parseTodayChange(subject, normalizedText, receivedAt);
  if (todayChange) {
    return todayChange;
  }

  const weekStart = resolveWeekStart(subject, normalizedText, receivedAt);
  const specialsByDate = extractSpecialsByDate(normalizedText, weekStart);
  applySwitchCorrections(normalizedText, specialsByDate, weekStart);

  if (Object.keys(specialsByDate).length === 0) {
    throw new CafeteriaMenuParseError("No weekday specials found in cafeteria menu email", isoDate(weekStart));
  }

  return {
    weekStart: isoDate(weekStart),
    weekEnd: isoDate(addDays(weekStart, 4)),
    specialsByDate,
    sourceSubject: subject.trim(),
    correctionHint: Boolean(
        SUBJECT_CORRECTION_MARKERS.test(subject) ||
        CORRECTION_MARKERS.test(subject) ||
        CORRECTION_MARKERS.test(normalizedText) ||
        SWAP_HINT_PATTERN.test(normalizedText),
    ),
  };
}

export function normalizeBodyToText(body: string, contentType?: string): string {
  let text = body || "";
  if ((contentType || "").toLowerCase() === "html") {
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)\s*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  text = decodeHtmlEntities(text).replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  text = stripMailingListFooter(text);
  text = stripFlowedEmphasis(text);
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function stripFlowedEmphasis(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let cleaned = line.replace(/^\s*\/(?=\S)/, "").replace(/(?<=\S)\/\s*$/, "");
      cleaned = cleaned.replace(/\*([^*\n]+)\*/g, "$1");
      if (/^\s*\/+\s*$/.test(cleaned)) {
        return "";
      }
      return cleaned;
    })
    .join("\n");
}

function stripMailingListFooter(text: string): string {
  return text
    .replace(/\n_{3,}\n[^\n]*\bmailing list\b[\s\S]*$/iu, "\n")
    .replace(/\n-- ?\n[\s\S]*$/u, "\n");
}

function resolveWeekStart(subject: string, text: string, receivedAt?: string | Date): Date {
  const combined = [subject, text].filter(Boolean).join("\n").trim();
  const anchor = coerceDate(receivedAt) ?? new Date();
  const anchorYear = anchor.getUTCFullYear();
  const weekOfMatch = WEEK_OF_PATTERN.exec(combined);
  if (weekOfMatch?.groups?.date) {
    const start = parseHumanDate(weekOfMatch.groups.date, anchorYear);
    return startOfWeek(start);
  }

  for (const pattern of DATE_RANGE_PATTERNS) {
    const match = pattern.exec(combined);
    if (!match?.groups) {
      continue;
    }
    const groups = match.groups;
    if (groups.start && groups.end) {
      const startParts = groups.start.split("/");
      const endParts = groups.end.split("/");
      const startYear = coerceYear(startParts[2], anchorYear);
      const endYear = coerceYear(endParts[2], startYear);
      const start = parseHumanDate(startParts.slice(0, 2).join("/"), startYear);
      const end = parseHumanDate(endParts.slice(0, 2).join("/"), endYear);
      return startOfWeek(adjustCrossYear(start, end)[0]);
    }
    if (groups.weekday1) {
      const start = buildDate(monthName(anchor.getUTCMonth()), groups.day1, anchorYear);
      return startOfWeek(start);
    }
    const month1 = groups.month1;
    const month2 = groups.month2 || month1;
    const year = coerceYear(groups.year, anchorYear);
    const start = buildDate(month1, groups.day1, year);
    const end = buildDate(month2, groups.day2, year);
    return startOfWeek(adjustCrossYear(start, end)[0]);
  }

  throw new CafeteriaMenuParseError("Could not determine covered week from cafeteria menu email");
}

function extractSpecialsByDate(normalizedText: string, weekStart: Date): Record<string, string> {
  const specialsByDate: Record<string, string> = {};
  let currentDate: string | null = null;
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (!currentDate) {
      return;
    }
    const combined = cleanMenuLine(currentLines.filter(Boolean).join(" "));
    if (combined) {
      specialsByDate[currentDate] = combined;
    }
    currentDate = null;
    currentLines = [];
  };

  for (const rawLine of normalizedText.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushCurrent();
      continue;
    }
    const weekdayMatch = WEEKDAY_LINE_PATTERN.exec(line);
    if (weekdayMatch?.groups) {
      flushCurrent();
      const offset = WEEKDAY_OFFSETS[weekdayMatch.groups.day.toLowerCase()];
      currentDate = isoDate(addDays(weekStart, offset));
      currentLines = [weekdayMatch.groups.special];
      continue;
    }
    if (currentDate && !/^(subject|date|from|to|reply-to)\s*:/i.test(line)) {
      currentLines.push(line);
    }
  }
  flushCurrent();
  return specialsByDate;
}

function applySwitchCorrections(
  normalizedText: string,
  specialsByDate: Record<string, string>,
  weekStart: Date,
): void {
  for (const match of normalizedText.matchAll(SWAP_PATTERN)) {
    const groups = match.groups;
    if (!groups) {
      continue;
    }
    const day1 = isoDate(addDays(weekStart, WEEKDAY_OFFSETS[groups.day1.toLowerCase()]));
    const day2 = isoDate(addDays(weekStart, WEEKDAY_OFFSETS[groups.day2.toLowerCase()]));
    if (specialsByDate[day1] && specialsByDate[day2]) {
      const first = specialsByDate[day1];
      specialsByDate[day1] = specialsByDate[day2];
      specialsByDate[day2] = first;
    }
  }
}

function parseTodayChange(
  subject: string,
  normalizedText: string,
  receivedAt?: string | Date,
): ParsedCafeteriaMenu | null {
  const receivedDate = coerceDate(receivedAt);
  if (!receivedDate || !subject.toLowerCase().includes("todays menu")) {
    return null;
  }
  const match = TODAY_CHANGE_PATTERN.exec(normalizedText);
  const special = match?.groups?.special ? cleanMenuLine(match.groups.special) : "";
  if (!special) {
    return null;
  }
  const targetDate = startOfUtcDay(receivedDate);
  const weekStart = startOfWeek(targetDate);
  return {
    weekStart: isoDate(weekStart),
    weekEnd: isoDate(addDays(weekStart, 4)),
    specialsByDate: { [isoDate(targetDate)]: special },
    sourceSubject: subject.trim(),
    correctionHint: true,
  };
}

function cleanMenuLine(value: string): string {
  return normalizeBodyToText(value, "text")
    .trim()
    .replace(/^[ *:\t-]+|[ *:\t-]+$/g, "")
    .replace(/^\*+|\*+$/g, "")
    .trim();
}

function parseHumanDate(value: string, anchorYear?: number): Date {
  const stripped = value.replace(/(?<=\d)(st|nd|rd|th)\b/gi, "").trim();
  const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(stripped);
  if (numeric) {
    const year = coerceYear(numeric[3], anchorYear ?? new Date().getUTCFullYear());
    return makeDate(year, Number(numeric[1]) - 1, Number(numeric[2]));
  }
  const named = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*|\s+)?(\d{2,4})?$/.exec(stripped);
  if (named) {
    const year = coerceYear(named[3], anchorYear ?? new Date().getUTCFullYear());
    return buildDate(named[1], named[2], year);
  }
  throw new Error(`Unrecognized date: ${value}`);
}

function buildDate(month: string, day: string, anchorYear: number): Date {
  const monthIndex = MONTHS[month.toLowerCase()];
  if (monthIndex === undefined) {
    throw new Error(`Unrecognized month: ${month}`);
  }
  return makeDate(anchorYear, monthIndex, Number(day));
}

function coerceYear(yearValue: string | undefined, anchorYear: number): number {
  if (!yearValue) {
    return anchorYear;
  }
  const year = Number(yearValue);
  return year < 100 ? 2000 + year : year;
}

function adjustCrossYear(start: Date, end: Date): [Date, Date] {
  if (end < start && end.getUTCMonth() < start.getUTCMonth()) {
    return [start, makeDate(end.getUTCFullYear() + 1, end.getUTCMonth(), end.getUTCDate())];
  }
  return [start, end];
}

function startOfWeek(date: Date): Date {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(date, mondayOffset);
}

function addDays(date: Date, days: number): Date {
  return makeDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function startOfUtcDay(date: Date): Date {
  return makeDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function makeDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function coerceDate(value?: string | Date): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function monthName(monthIndex: number): string {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][monthIndex];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
