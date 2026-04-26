import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCafeteriaMenuWithLlm } from "../src/llm-parser";
import { CafeteriaMenuParseError, type Env } from "../src/types";

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function envWithKey(): Env & { MENU_STORE: MemoryKV } {
  const store = new MemoryKV();
  return {
    MENU_STORE: store as unknown as KVNamespace,
    ANTHROPIC_API_KEY: "test-key",
    LLM_PARSE_ENABLED: "true",
  } as Env & { MENU_STORE: MemoryKV };
}

function mockFetch(responseInit: { ok: boolean; status?: number; body: unknown }) {
  return vi.fn(async () => {
    return new Response(typeof responseInit.body === "string" ? responseInit.body : JSON.stringify(responseInit.body), {
      status: responseInit.status ?? (responseInit.ok ? 200 : 500),
    });
  });
}

function toolUseResponse(toolInput: unknown) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "record_menu",
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
  };
}

const SUBJECT = "[Gbemploy] Next weeks cafeteria menu";
const BODY = "Monday: Italian Sub\nTuesday: Potato Bar\nWednesday: Big Mac\nThursday: Chicken Sandwich\nFriday: Spaghetti";
const RECEIVED_AT = "2026-04-17T18:43:54.000Z";

describe("parseCafeteriaMenuWithLlm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, body: { content: [] } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    const env = { MENU_STORE: new MemoryKV() as unknown as KVNamespace } as Env;
    await expect(
      parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT),
    ).rejects.toBeInstanceOf(CafeteriaMenuParseError);
  });

  it("returns ParsedCafeteriaMenu on a valid tool_use response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: toolUseResponse({
          weekStart: "2026-04-20",
          weekEnd: "2026-04-24",
          specialsByDate: {
            "2026-04-20": "Italian Sub",
            "2026-04-21": "Potato Bar",
            "2026-04-22": "Big Mac",
            "2026-04-23": "Chicken Sandwich",
            "2026-04-24": "Spaghetti",
          },
          sourceSubject: SUBJECT,
          correctionHint: false,
        }),
      }),
    );
    const env = envWithKey();
    const result = await parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-1");
    expect(result.weekStart).toBe("2026-04-20");
    expect(result.weekEnd).toBe("2026-04-24");
    expect(result.specialsByDate).toEqual({
      "2026-04-20": "Italian Sub",
      "2026-04-21": "Potato Bar",
      "2026-04-22": "Big Mac",
      "2026-04-23": "Chicken Sandwich",
      "2026-04-24": "Spaghetti",
    });
    expect(result.correctionHint).toBe(false);
  });

  it("persists the raw response to KV when messageId and MENU_STORE are present", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: toolUseResponse({
          weekStart: "2026-04-20",
          weekEnd: "2026-04-24",
          specialsByDate: { "2026-04-20": "Italian Sub" },
          sourceSubject: SUBJECT,
          correctionHint: false,
        }),
      }),
    );
    const env = envWithKey();
    await parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-abc");
    expect(env.MENU_STORE.values.get("emails/llm-parses/msg-abc.json")).toBeTruthy();
  });

  it("throws CafeteriaMenuParseError on malformed tool input", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: toolUseResponse({
          weekStart: "not-a-date",
          weekEnd: "2026-04-24",
          specialsByDate: { "2026-04-20": "Italian Sub" },
          sourceSubject: SUBJECT,
          correctionHint: false,
        }),
      }),
    );
    const env = envWithKey();
    await expect(
      parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-bad"),
    ).rejects.toBeInstanceOf(CafeteriaMenuParseError);
  });

  it("throws when specialsByDate is empty", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: toolUseResponse({
          weekStart: "2026-04-20",
          weekEnd: "2026-04-24",
          specialsByDate: {},
          sourceSubject: SUBJECT,
          correctionHint: false,
        }),
      }),
    );
    const env = envWithKey();
    await expect(
      parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-empty"),
    ).rejects.toThrow(/no weekday specials/i);
  });

  it("throws when no tool_use block is present in the response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: { content: [{ type: "text", text: "Sorry, I can't parse this." }] },
      }),
    );
    const env = envWithKey();
    await expect(
      parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-notool"),
    ).rejects.toThrow(/record_menu/);
  });

  it("throws on API error responses", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ ok: false, status: 401, body: { error: { message: "invalid x-api-key" } } }),
    );
    const env = envWithKey();
    await expect(
      parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT, "msg-401"),
    ).rejects.toThrow(/Anthropic API error 401/);
  });

  it("uses env.LLM_MODEL when set, falls back to default otherwise", async () => {
    const captured: { url?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured.push({ url, body: typeof init.body === "string" ? init.body : "" });
        return new Response(
          JSON.stringify(
            toolUseResponse({
              weekStart: "2026-04-20",
              weekEnd: "2026-04-24",
              specialsByDate: { "2026-04-20": "Italian Sub" },
              sourceSubject: SUBJECT,
              correctionHint: false,
            }),
          ),
          { status: 200 },
        );
      }),
    );

    const overridden: Env = {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
      ANTHROPIC_API_KEY: "test-key",
      LLM_MODEL: "claude-sonnet-4-6-20251999",
    };
    await parseCafeteriaMenuWithLlm(overridden, SUBJECT, BODY, RECEIVED_AT);
    expect(JSON.parse(captured[0].body!).model).toBe("claude-sonnet-4-6-20251999");

    const defaulted: Env = {
      MENU_STORE: new MemoryKV() as unknown as KVNamespace,
      ANTHROPIC_API_KEY: "test-key",
    };
    await parseCafeteriaMenuWithLlm(defaulted, SUBJECT, BODY, RECEIVED_AT);
    expect(JSON.parse(captured[1].body!).model).toBe("claude-haiku-4-5-20251001");
  });

  it("does not write to KV when messageId is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ok: true,
        body: toolUseResponse({
          weekStart: "2026-04-20",
          weekEnd: "2026-04-24",
          specialsByDate: { "2026-04-20": "Italian Sub" },
          sourceSubject: SUBJECT,
          correctionHint: false,
        }),
      }),
    );
    const env = envWithKey();
    await parseCafeteriaMenuWithLlm(env, SUBJECT, BODY, RECEIVED_AT);
    expect(env.MENU_STORE.values.size).toBe(0);
  });
});
