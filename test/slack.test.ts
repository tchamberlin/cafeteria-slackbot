import { describe, expect, it } from "vitest";
import { formatLunchResponse, parseCommandDate } from "../src/slack";
import type { LunchSpecialResult } from "../src/types";

const SAT_2345_ET = new Date("2026-04-25T23:45:00-04:00");
const SUN_0345_UTC = new Date("2026-04-26T03:45:00Z");
const SUN_0800_ET = new Date("2026-04-26T08:00:00-04:00");
const FRI_0900_ET = new Date("2026-04-24T09:00:00-04:00");
const FRI_0030_ET = new Date("2026-04-24T00:30:00-04:00");

const FALL_BACK_LATE_NIGHT = new Date("2026-11-01T03:30:00-05:00");
const SPRING_FORWARD_PRE = new Date("2026-03-08T01:30:00-05:00");

function makeResult(overrides: Partial<LunchSpecialResult> = {}): LunchSpecialResult {
  return {
    date: "2026-04-26",
    special: "Pizza",
    status: "ok",
    sourceSubject: "GBO Cafeteria Menu",
    sourceReceivedAt: "2026-04-25T12:00:00Z",
    sourceMessageId: "id-1",
    sourceSupersededCount: 0,
    ...overrides,
  };
}

describe("parseCommandDate", () => {
  it("returns today (ET) when given empty input", () => {
    expect(parseCommandDate("", SAT_2345_ET)).toBe("2026-04-25");
  });

  it("returns today (ET) when given `today`", () => {
    expect(parseCommandDate("today", SAT_2345_ET)).toBe("2026-04-25");
    expect(parseCommandDate("TODAY", SUN_0345_UTC)).toBe("2026-04-25");
  });

  it("returns ET tomorrow when called from late-evening ET (UTC has rolled over)", () => {
    expect(parseCommandDate("tomorrow", SAT_2345_ET)).toBe("2026-04-26");
    expect(parseCommandDate("tomorrow", SUN_0345_UTC)).toBe("2026-04-26");
  });

  it("matches ET date during normal weekday hours", () => {
    expect(parseCommandDate("today", FRI_0900_ET)).toBe("2026-04-24");
    expect(parseCommandDate("tomorrow", FRI_0900_ET)).toBe("2026-04-25");
  });

  it("treats just-after-ET-midnight as the new ET day", () => {
    expect(parseCommandDate("today", FRI_0030_ET)).toBe("2026-04-24");
    expect(parseCommandDate("tomorrow", FRI_0030_ET)).toBe("2026-04-25");
  });

  it("works across DST spring-forward (just before 2 AM ET, 2026-03-08)", () => {
    expect(parseCommandDate("today", SPRING_FORWARD_PRE)).toBe("2026-03-08");
    expect(parseCommandDate("tomorrow", SPRING_FORWARD_PRE)).toBe("2026-03-09");
  });

  it("works during the fall-back ambiguity window (2026-11-01 ~01:30 EDT/EST)", () => {
    expect(parseCommandDate("today", FALL_BACK_LATE_NIGHT)).toBe("2026-11-01");
    expect(parseCommandDate("tomorrow", FALL_BACK_LATE_NIGHT)).toBe("2026-11-02");
  });

  it("accepts an explicit YYYY-MM-DD verbatim", () => {
    expect(parseCommandDate("2026-04-27", SAT_2345_ET)).toBe("2026-04-27");
  });

  it("rejects a syntactically valid but impossible date", () => {
    expect(() => parseCommandDate("2026-13-01", SAT_2345_ET)).toThrow(/Use `\/lunch`/);
    expect(() => parseCommandDate("2026-02-30", SAT_2345_ET)).toThrow(/Use `\/lunch`/);
  });

  it("rejects gibberish with the usage hint", () => {
    expect(() => parseCommandDate("yesterday", SAT_2345_ET)).toThrow(/Use `\/lunch`/);
    expect(() => parseCommandDate("monday", SAT_2345_ET)).toThrow(/Use `\/lunch`/);
  });
});

describe("formatLunchResponse", () => {
  it("labels Sunday as `tomorrow` when called Saturday 11:45 PM ET", () => {
    expect(formatLunchResponse(makeResult(), SAT_2345_ET)).toBe(
      "Menu for tomorrow (Sunday, 2026-04-26): Pizza",
    );
  });

  it("labels Sunday as `today` when called Sunday morning ET", () => {
    expect(formatLunchResponse(makeResult(), SUN_0800_ET)).toBe(
      "Menu for today (Sunday, 2026-04-26): Pizza",
    );
  });

  it("labels other dates with the weekday name only", () => {
    expect(formatLunchResponse(makeResult({ date: "2026-04-30" }), SUN_0800_ET)).toBe(
      "Menu for Thursday (2026-04-30): Pizza",
    );
  });

  it("reports parse errors with detail", () => {
    const result = makeResult({ status: "parse_error", special: null, error: "missing weekday" });
    expect(formatLunchResponse(result, SUN_0800_ET)).toBe(
      "Found a menu email for today (Sunday, 2026-04-26), but couldn't parse it.\nParser error: missing weekday",
    );
  });

  it("says `no menu listed` when an email exists but the date is missing", () => {
    const result = makeResult({ status: "missing", special: null });
    expect(formatLunchResponse(result, SUN_0800_ET)).toBe(
      "No menu listed for today (Sunday, 2026-04-26).",
    );
  });

  it("says `no menu email found` when no email was received for that week", () => {
    const result = makeResult({ status: "missing", special: null, sourceSubject: null });
    expect(formatLunchResponse(result, SUN_0800_ET)).toBe(
      "No menu email found for today (Sunday, 2026-04-26).",
    );
  });
});
