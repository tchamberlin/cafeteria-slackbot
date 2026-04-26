// Live-API fixture tests: parse each test_emails/*.txt with the real Anthropic
// API and compare against an expectation written for it. SKIPPED by default —
// these cost real $$ and need network. Enable with:
//
//   RUN_LLM_TESTS=1 npm test -- test/llm-fixtures.test.ts
//
// ANTHROPIC_API_KEY (and optional LLM_MODEL override) come from process.env.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCafeteriaMenuWithLlm } from "../src/llm-parser";
import type { Env, ParsedCafeteriaMenu } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURES = join(ROOT, "test_emails");

const RUN = process.env.RUN_LLM_TESTS === "1";
const env: Env = {
  MENU_STORE: undefined as unknown as KVNamespace, // unused — no messageId is passed below
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL,
};

interface Expectation {
  weekStart: string;
  weekEnd: string;
  correctionHint: boolean;
  // Values are case-insensitive substring expectations — the LLM may add
  // qualifiers ("Italian Sub (with chips)") so a substring match is more
  // robust than equality without giving up on signal.
  specialsByDate: Record<string, string>;
}

interface Fixture {
  name: string;
  file: string;
  subject: string;
  receivedAt: string;
  expected: Expectation;
}

const FIXTURES_LIST: Fixture[] = [
  {
    name: "normal_menu — explicit week range, no correction",
    file: "normal_menu.txt",
    subject: "Cafeteria Menu Apr 27 - May 1",
    receivedAt: "2026-04-23T14:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: false,
      specialsByDate: {
        "2026-04-27": "italian sub",
        "2026-04-28": "potato bar",
        "2026-04-29": "big mac",
        "2026-04-30": "chicken sandwich",
        "2026-05-01": "spaghetti",
      },
    },
  },
  {
    name: "swap_mon_wed — correction, Mon/Wed swapped",
    file: "swap_mon_wed.txt",
    subject: "CORRECTION: Cafeteria Menu Apr 27",
    receivedAt: "2026-04-26T18:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: true,
      specialsByDate: {
        "2026-04-27": "big mac",
        "2026-04-28": "potato bar",
        "2026-04-29": "italian sub",
        "2026-04-30": "chicken sandwich",
        "2026-05-01": "spaghetti",
      },
    },
  },
  {
    name: "replace_tuesday — single-day correction",
    file: "replace_tuesday.txt",
    subject: "Cafeteria menu update",
    // Monday Apr 27 sender time → "tomorrow" = Tuesday Apr 28
    receivedAt: "2026-04-27T18:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: true,
      specialsByDate: {
        "2026-04-28": "lasagna",
      },
    },
  },
  {
    name: "correction_swap — Tue/Wed swap from earlier email",
    file: "correction_swap.txt",
    subject: "CORRECTION: Cafeteria Menu Apr 27 - May 1",
    receivedAt: "2026-04-24T15:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: true,
      specialsByDate: {
        "2026-04-27": "italian sub",
        "2026-04-28": "big mac",
        "2026-04-29": "potato bar",
        "2026-04-30": "chicken sandwich",
        "2026-05-01": "spaghetti",
      },
    },
  },
  {
    name: "mixed_prose — narrative format with picnic + holiday noise",
    file: "mixed_prose.txt",
    subject: "Cafeteria Menu Apr 27 - May 1",
    receivedAt: "2026-04-23T14:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: false,
      specialsByDate: {
        "2026-04-27": "italian sub",
        "2026-04-28": "potato bar",
        "2026-04-29": "big mac",
        "2026-04-30": "chicken sandwich",
        "2026-05-01": "spaghetti",
      },
    },
  },
  {
    name: "abbreviated_dates — Mon 4/27 dotted-leader table",
    file: "abbreviated_dates.txt",
    subject: "Cafeteria Menu — wk of 4/27",
    receivedAt: "2026-04-23T14:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: false,
      specialsByDate: {
        "2026-04-27": "italian sub",
        "2026-04-28": "potato bar",
        "2026-04-29": "big mac",
        "2026-04-30": "chicken sandwich",
        "2026-05-01": "spaghetti",
      },
    },
  },
  {
    name: "casual — slangy prose, no week reference",
    file: "casual.txt",
    subject: "lunch",
    // Friday Apr 24 → "next week" anchored to Mon Apr 27
    receivedAt: "2026-04-24T15:00:00Z",
    expected: {
      weekStart: "2026-04-27",
      weekEnd: "2026-05-01",
      correctionHint: false,
      specialsByDate: {
        "2026-04-27": "fish stick",
        "2026-04-28": "potato casserole",
        "2026-04-29": "taco",
        "2026-04-30": "horse burger",
        "2026-05-01": "shrimp nugget",
      },
    },
  },
];

describe.skipIf(!RUN)("LLM fixtures (live API)", () => {
  if (RUN && !env.ANTHROPIC_API_KEY) {
    throw new Error("RUN_LLM_TESTS=1 set but ANTHROPIC_API_KEY is missing");
  }

  for (const fixture of FIXTURES_LIST) {
    it(
      fixture.name,
      async () => {
        const body = readFileSync(join(FIXTURES, fixture.file), "utf8");
        const result = await parseCafeteriaMenuWithLlm(env, fixture.subject, body, fixture.receivedAt);
        assertMatches(result, fixture.expected);
      },
      30_000,
    );
  }
});

function assertMatches(actual: ParsedCafeteriaMenu, expected: Expectation): void {
  expect(actual.weekStart, "weekStart").toBe(expected.weekStart);
  expect(actual.weekEnd, "weekEnd").toBe(expected.weekEnd);
  expect(actual.correctionHint, "correctionHint").toBe(expected.correctionHint);
  expect(Object.keys(actual.specialsByDate).sort(), "specialsByDate keys").toEqual(
    Object.keys(expected.specialsByDate).sort(),
  );
  for (const [date, fragment] of Object.entries(expected.specialsByDate)) {
    const got = actual.specialsByDate[date] ?? "";
    expect(got.toLowerCase(), `specialsByDate[${date}] should contain "${fragment}"`).toContain(
      fragment.toLowerCase(),
    );
  }
}

