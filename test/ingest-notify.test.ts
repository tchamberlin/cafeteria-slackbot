import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIngestSideEffects } from "../src/ingest-notify";
import { loadDailyPost, recordDailyPost } from "../src/menu-store";
import type { Env, IngestResult, NormalizedEmailMessage } from "../src/types";

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

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    MENU_STORE: new MemoryKV() as unknown as KVNamespace,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_ID: "C-USER",
    SLACK_ADMIN_CHANNEL_ID: "C-ADMIN",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
  return {
    id: "id-correction",
    messageId: "id-correction",
    receivedAt: "2026-04-21T14:08:00.000Z",
    from: "cafeteria@example.com",
    to: "menus@example.com",
    subject: "[Gbemploy] Corrected: weekly menu",
    bodyText: "Tuesday: Lasagna",
    rawKey: "emails/raw/x.eml",
    ...overrides,
  };
}

function followUpResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    ignored: false,
    parsed: true,
    weekStart: "2026-04-20",
    followUp: true,
    becameAuthoritative: true,
    previousAuthoritativeSubject: "[Gbemploy] Next weeks cafeteria menu",
    newAuthoritativeSubject: "[Gbemploy] Corrected: weekly menu",
    changedDates: [
      { date: "2026-04-21", previousSpecial: "Tacos", newSpecial: "Lasagna" },
    ],
    ...overrides,
  };
}

describe("handleIngestSideEffects", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("does nothing for ignored messages", async () => {
    await handleIngestSideEffects(envWith(), makeMessage(), {
      ignored: true,
      parsed: false,
      followUp: false,
      becameAuthoritative: false,
      previousAuthoritativeSubject: null,
      newAuthoritativeSubject: null,
      changedDates: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for first-of-week parsed messages", async () => {
    await handleIngestSideEffects(envWith(), makeMessage(), {
      ignored: false,
      parsed: true,
      weekStart: "2026-04-20",
      followUp: false,
      becameAuthoritative: true,
      previousAuthoritativeSubject: null,
      newAuthoritativeSubject: "[Gbemploy] Next weeks cafeteria menu",
      changedDates: [
        { date: "2026-04-21", previousSpecial: null, newSpecial: "Tacos" },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts admin notification + threaded reply when a correction lands on a posted date", async () => {
    const env = envWith();
    await recordDailyPost(env, {
      date: "2026-04-21",
      special: "Tacos",
      ts: "1714000000.000200",
      channel: "C-USER",
      postedAt: "2026-04-21T13:00:00.000Z",
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1.0", channel: "C-ADMIN" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1.1", channel: "C-USER" }));

    await handleIngestSideEffects(env, makeMessage(), followUpResult());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const adminBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(adminBody.channel).toBe("C-ADMIN");
    expect(adminBody.text).toContain("Follow-up cafeteria email");
    expect(adminBody.text).toContain("Auto-applied as the new authoritative menu");
    expect(adminBody.text).toContain("2026-04-21: Tacos → Lasagna");
    expect(adminBody.text).toContain("Posted 1 thread reply");

    const replyBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(replyBody.channel).toBe("C-USER");
    expect(replyBody.thread_ts).toBe("1714000000.000200");
    expect(replyBody.text).toContain("The 2026-04-21 menu has been updated.");
    expect(replyBody.text).toContain("Was: Tacos");
    expect(replyBody.text).toContain("Now: Lasagna");

    const updated = await loadDailyPost(env, "2026-04-21");
    expect(updated?.special).toBe("Lasagna");
    expect(updated?.ts).toBe("1714000000.000200");
  });

  it("posts admin notification but no threaded reply when no daily post exists for the date", async () => {
    const env = envWith();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1.0", channel: "C-ADMIN" }));

    await handleIngestSideEffects(env, makeMessage(), followUpResult());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const adminBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(adminBody.channel).toBe("C-ADMIN");
    expect(adminBody.text).not.toContain("Posted");
  });

  it("notifies on parse error with the error detail", async () => {
    const env = envWith();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1.0", channel: "C-ADMIN" }));

    await handleIngestSideEffects(env, makeMessage({ subject: "[Gbemploy] cafeteria menu mystery" }), {
      ignored: false,
      parsed: false,
      error: "Could not determine covered week from cafeteria menu email",
      followUp: false,
      becameAuthoritative: false,
      previousAuthoritativeSubject: null,
      newAuthoritativeSubject: null,
      changedDates: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const adminBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(adminBody.text).toContain("Parse error on cafeteria email");
    expect(adminBody.text).toContain("Could not determine covered week");
  });

  it("does not post a thread reply when the recorded post already shows the new special", async () => {
    const env = envWith();
    await recordDailyPost(env, {
      date: "2026-04-21",
      special: "Lasagna",
      ts: "1714000000.000200",
      channel: "C-USER",
      postedAt: "2026-04-21T13:00:00.000Z",
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1.0", channel: "C-ADMIN" }));

    await handleIngestSideEffects(env, makeMessage(), followUpResult());

    expect(fetchMock).toHaveBeenCalledTimes(1); // admin only
  });
});
