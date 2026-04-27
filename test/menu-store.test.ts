import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ingestNormalizedMessage,
  loadDailyPost,
  loadLunchSpecial,
  loadWeekLunch,
  recordDailyPost,
} from "../src/menu-store";
import type { Env, NormalizedEmailMessage } from "../src/types";

class MemoryKV {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.values.get(key) ?? null;
    if (type === "json" && value) {
      return JSON.parse(value);
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function env(allowedSender = "cafeteria@example.com"): Env {
  return {
    MENU_STORE: new MemoryKV() as unknown as KVNamespace,
    ALLOWED_SENDER: allowedSender,
  };
}

function message(from: string): NormalizedEmailMessage {
  return {
    id: `message-${from}`,
    messageId: `message-${from}`,
    receivedAt: "2026-04-17T18:43:54.000Z",
    from,
    to: "menus@example.com",
    subject: "[Gbemploy] Next weeks cafeteria menu",
    bodyText: `
      GBO Cafeteria Menu
      April 20th-24th
      Monday: Italian Sub
      Tuesday: Potato Bar
      Wednesday: Big Mac
      Thursday: Chicken Sandwich
      Friday: Spaghetti
    `,
    rawKey: "emails/raw/sample.eml",
  };
}

describe("menu store ingestion", () => {
  it("ignores menu-looking emails from non-configured senders", async () => {
    const testEnv = env("cafeteria@example.com");

    const result = await ingestNormalizedMessage(testEnv, message("someone@example.com"));

    expect(result).toMatchObject({ ignored: true, parsed: false, error: "sender_not_allowed" });
    expect(await loadLunchSpecial(testEnv, "2026-04-20")).toMatchObject({
      status: "missing",
      sourceSubject: null,
    });
  });

  it("ignores all menu-looking emails when no sender is configured", async () => {
    const testEnv = {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
    };

    const result = await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    expect(result).toMatchObject({ ignored: true, parsed: false, error: "sender_not_allowed" });
    expect(await loadLunchSpecial(testEnv, "2026-04-20")).toMatchObject({ status: "missing" });
  });

  it("parses menu emails from the configured sender", async () => {
    const testEnv = env("cafeteria@example.com");

    const result = await ingestNormalizedMessage(testEnv, message("Cafeteria <cafeteria@example.com>"));

    expect(result).toMatchObject({
      ignored: false,
      parsed: true,
      weekStart: "2026-04-20",
      followUp: false,
      becameAuthoritative: true,
      changedDates: [
        { date: "2026-04-20", previousSpecial: null, newSpecial: "Italian Sub" },
        { date: "2026-04-21", previousSpecial: null, newSpecial: "Potato Bar" },
        { date: "2026-04-22", previousSpecial: null, newSpecial: "Big Mac" },
        { date: "2026-04-23", previousSpecial: null, newSpecial: "Chicken Sandwich" },
        { date: "2026-04-24", previousSpecial: null, newSpecial: "Spaghetti" },
      ],
    });
    expect(await loadLunchSpecial(testEnv, "2026-04-20")).toMatchObject({
      status: "ok",
      special: "Italian Sub",
    });
  });
});

describe("menu store follow-up handling", () => {
  function correctionMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
    return {
      id: "message-correction",
      messageId: "message-correction",
      receivedAt: "2026-04-20T14:00:00.000Z",
      from: "cafeteria@example.com",
      to: "menus@example.com",
      subject: "[Gbemploy] Corrected: Next weeks cafeteria menu",
      bodyText: `
        GBO Cafeteria Menu (corrected)
        April 20th-24th
        Monday: Italian Sub
        Tuesday: Lasagna
        Wednesday: Big Mac
        Thursday: Chicken Sandwich
        Friday: Spaghetti
      `,
      rawKey: "emails/raw/correction.eml",
      ...overrides,
    };
  }

  function nonCorrectionMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
    return {
      id: "message-extra",
      messageId: "message-extra",
      // Earlier than the baseline message in `message()` (18:43Z) so it loses the recency tiebreak.
      receivedAt: "2026-04-17T17:00:00.000Z",
      from: "cafeteria@example.com",
      to: "menus@example.com",
      subject: "[Gbemploy] Next weeks cafeteria menu",
      bodyText: `
        GBO Cafeteria Menu
        April 20th-24th
        Monday: Italian Sub
        Tuesday: Salad Bar
        Wednesday: Big Mac
        Thursday: Chicken Sandwich
        Friday: Spaghetti
      `,
      rawKey: "emails/raw/extra.eml",
      ...overrides,
    };
  }

  it("flags follow-up correction emails and reports per-date diff", async () => {
    const testEnv = env("cafeteria@example.com");

    await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));
    const result = await ingestNormalizedMessage(testEnv, correctionMessage());

    expect(result.followUp).toBe(true);
    expect(result.becameAuthoritative).toBe(true);
    expect(result.changedDates).toEqual([
      { date: "2026-04-21", previousSpecial: "Potato Bar", newSpecial: "Lasagna" },
    ]);
    expect(result.previousAuthoritativeSubject).toContain("cafeteria menu");
    expect(await loadLunchSpecial(testEnv, "2026-04-21")).toMatchObject({ special: "Lasagna" });
  });

  it("flags follow-up but reports no changes when ranking keeps the original authoritative", async () => {
    const testEnv = env("cafeteria@example.com");

    await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));
    const result = await ingestNormalizedMessage(testEnv, nonCorrectionMessage());

    expect(result.followUp).toBe(true);
    expect(result.becameAuthoritative).toBe(false);
    expect(result.changedDates).toEqual([]);
    expect(await loadLunchSpecial(testEnv, "2026-04-21")).toMatchObject({ special: "Potato Bar" });
  });

  it("first-of-week message has followUp=false", async () => {
    const testEnv = env("cafeteria@example.com");

    const result = await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    expect(result.followUp).toBe(false);
    expect(result.becameAuthoritative).toBe(true);
  });
});

describe("weekend week resolution", () => {
  // The seeded menu is for the week of 2026-04-20 (Mon) – 2026-04-24 (Fri).
  // `2026-04-25` is the Saturday after that week; `2026-04-19` is the Sunday before it.
  // Both should resolve to the *upcoming* Monday's week.

  it("Saturday rolls forward to the next Monday's week", async () => {
    const testEnv = env("cafeteria@example.com");
    await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    // 2026-04-18 is the Saturday before the seeded week; should resolve to weekStart 2026-04-20.
    const result = await loadWeekLunch(testEnv, "2026-04-18");

    expect(result.weekStart).toBe("2026-04-20");
    expect(result.weekSpecials).toMatchObject({ "2026-04-20": "Italian Sub" });
  });

  it("Sunday rolls forward to the next Monday's week", async () => {
    const testEnv = env("cafeteria@example.com");
    await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    // 2026-04-19 is the Sunday before the seeded week; should resolve to weekStart 2026-04-20.
    const result = await loadWeekLunch(testEnv, "2026-04-19");

    expect(result.weekStart).toBe("2026-04-20");
    expect(result.weekSpecials).toMatchObject({ "2026-04-24": "Spaghetti" });
  });
});

describe("daily post records", () => {
  it("recordDailyPost / loadDailyPost round-trip", async () => {
    const testEnv: Env = {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
    };

    expect(await loadDailyPost(testEnv, "2026-04-21")).toBeNull();

    await recordDailyPost(testEnv, {
      date: "2026-04-21",
      special: "Tacos",
      ts: "1714000000.000200",
      channel: "C123",
      postedAt: "2026-04-21T13:00:00.000Z",
    });

    expect(await loadDailyPost(testEnv, "2026-04-21")).toMatchObject({
      date: "2026-04-21",
      special: "Tacos",
      ts: "1714000000.000200",
      channel: "C123",
    });
    expect(await loadDailyPost(testEnv, "2026-04-22")).toBeNull();
  });
});

describe("menu store LLM hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function llmEnv(): Env {
    return {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
      ALLOWED_SENDER: "cafeteria@example.com",
      ANTHROPIC_API_KEY: "test-key",
      LLM_PARSE_ENABLED: "true",
    };
  }

  function regexFailingMessage(): NormalizedEmailMessage {
    // No recognizable date pattern → resolveWeekStart throws CafeteriaMenuParseError.
    return {
      id: "message-llm-fallback",
      messageId: "message-llm-fallback",
      receivedAt: "2026-04-17T18:43:54.000Z",
      from: "cafeteria@example.com",
      to: "menus@example.com",
      subject: "[Gbemploy] Next weeks cafeteria menu",
      bodyText: "Lunch this coming week will rotate through staff favorites — see you in line.",
      rawKey: "emails/raw/llm-fallback.eml",
    };
  }

  function correctionMessageForLlm(): NormalizedEmailMessage {
    return {
      id: "message-llm-correction",
      messageId: "message-llm-correction",
      receivedAt: "2026-04-21T13:00:00.000Z",
      from: "cafeteria@example.com",
      to: "menus@example.com",
      subject: "[Gbemploy] Slight change in todays menu",
      bodyText: "Apologies — switch tuesday and thursday's lunch menus this week.",
      rawKey: "emails/raw/llm-correction.eml",
    };
  }

  function mockToolUse(toolInput: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "msg_test",
            content: [{ type: "tool_use", name: "record_menu", input: toolInput }],
          }),
          { status: 200 },
        ),
      ),
    );
  }

  it("falls back to LLM when the regex parser throws", async () => {
    const testEnv = llmEnv();
    mockToolUse({
      weekStart: "2026-04-20",
      weekEnd: "2026-04-24",
      specialsByDate: {
        "2026-04-20": "Italian Sub",
        "2026-04-21": "Potato Bar",
        "2026-04-22": "Big Mac",
        "2026-04-23": "Chicken Sandwich",
        "2026-04-24": "Spaghetti",
      },
      sourceSubject: "[Gbemploy] Next weeks cafeteria menu",
      correctionHint: false,
    });

    const result = await ingestNormalizedMessage(testEnv, regexFailingMessage());

    expect(result).toMatchObject({ ignored: false, parsed: true, weekStart: "2026-04-20" });
    expect(await loadLunchSpecial(testEnv, "2026-04-22")).toMatchObject({
      status: "ok",
      special: "Big Mac",
    });
  });

  it("re-runs LLM and replaces regex output when correctionHint is true", async () => {
    const testEnv = llmEnv();
    // First seed the week with the original menu (regex path, no LLM call needed because correctionHint=false).
    mockToolUse({
      weekStart: "2026-04-20",
      weekEnd: "2026-04-24",
      specialsByDate: { "2026-04-20": "noop" },
      sourceSubject: "noop",
      correctionHint: false,
    });
    await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    // Now ingest a correction. The regex matches "switch X and Y" hint pattern → correctionHint=true,
    // so the LLM runs and its output replaces the (incomplete) regex result.
    mockToolUse({
      weekStart: "2026-04-20",
      weekEnd: "2026-04-24",
      specialsByDate: {
        "2026-04-20": "Italian Sub",
        "2026-04-21": "Chicken Sandwich",
        "2026-04-22": "Big Mac",
        "2026-04-23": "Potato Bar",
        "2026-04-24": "Spaghetti",
      },
      sourceSubject: "[Gbemploy] Slight change in todays menu",
      correctionHint: true,
    });

    const result = await ingestNormalizedMessage(testEnv, correctionMessageForLlm());

    expect(result.parsed).toBe(true);
    expect(result.followUp).toBe(true);
    expect(result.becameAuthoritative).toBe(true);
    // Tuesday and Thursday were swapped by the LLM relative to the seeded week.
    expect(result.changedDates).toEqual(
      expect.arrayContaining([
        { date: "2026-04-21", previousSpecial: "Potato Bar", newSpecial: "Chicken Sandwich" },
        { date: "2026-04-23", previousSpecial: "Chicken Sandwich", newSpecial: "Potato Bar" },
      ]),
    );
    expect(await loadLunchSpecial(testEnv, "2026-04-21")).toMatchObject({ special: "Chicken Sandwich" });
  });

  it("falls through to parse-error when LLM is disabled and regex throws", async () => {
    const testEnv: Env = {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
      ALLOWED_SENDER: "cafeteria@example.com",
      // LLM_PARSE_ENABLED unset
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ingestNormalizedMessage(testEnv, regexFailingMessage());

    expect(result).toMatchObject({ ignored: false, parsed: false });
    expect(result.error).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call LLM when correctionHint is false and regex succeeds", async () => {
    const testEnv = llmEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ingestNormalizedMessage(testEnv, message("cafeteria@example.com"));

    expect(result.parsed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
