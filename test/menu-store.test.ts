import { describe, expect, it } from "vitest";
import { ingestNormalizedMessage, loadLunchSpecial } from "../src/menu-store";
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

    expect(result).toMatchObject({ ignored: false, parsed: true, weekStart: "2026-04-20" });
    expect(await loadLunchSpecial(testEnv, "2026-04-20")).toMatchObject({
      status: "ok",
      special: "Italian Sub",
    });
  });
});
