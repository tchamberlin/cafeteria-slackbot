import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { isCafeteriaMenuSubject, parseCafeteriaMenuEmail } from "../src/menu-parser";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cafeteria_menu");
const REPO_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("cafeteria menu parser", () => {
  it("filters cafeteria subjects and excludes non-menu cafeteria noise", () => {
    expect(isCafeteriaMenuSubject("[Gbemploy] Next weeks cafeteria menu")).toBe(true);
    expect(isCafeteriaMenuSubject("[Gbemploy] Changes to this weeks menu")).toBe(true);
    expect(isCafeteriaMenuSubject("[Gbemploy] Weekend Pizza Special at Starlight Cafe")).toBe(false);
  });

  it("parses plain text weekly menus", () => {
    const parsed = parseCafeteriaMenuEmail(
      "Weekly Cafeteria Menu - Week of April 20, 2026",
      fixture("plain_text_menu.txt"),
    );

    expect(parsed.weekStart).toBe("2026-04-20");
    expect(parsed.specialsByDate["2026-04-20"]).toBe("Chicken Parmesan");
    expect(parsed.specialsByDate["2026-04-24"]).toBe("Fish and Chips");
  });

  it("parses html weekly menus", () => {
    const parsed = parseCafeteriaMenuEmail(
      "Cafeteria Menu for April 20-24, 2026",
      fixture("html_menu.html"),
      "html",
    );

    expect(parsed.specialsByDate["2026-04-21"]).toBe("Black Bean Tacos");
    expect(parsed.specialsByDate["2026-04-24"]).toBe("Shrimp Po' Boy");
  });

  it("uses received date as the year anchor for real subject variants", () => {
    const parsed = parseCafeteriaMenuEmail(
      "[Gbemploy] Next weeks cafeteria menu",
      `
      GBO Cafeteria Menu
      April 20th-24th
      Monday: Italian Sub
      Tuesday: Potato Bar
      Wednesday: Big Mac
      Thursday: Chicken Sandwich
      Friday: Spaghetti
      `,
      "text",
      "2026-04-17T18:43:54Z",
    );

    expect(parsed.weekStart).toBe("2026-04-20");
    expect(parsed.specialsByDate["2026-04-24"]).toBe("Spaghetti");
  });

  it("handles corrections and missing days", () => {
    const parsed = parseCafeteriaMenuEmail(
      "Updated Cafeteria Menu - Week of April 20, 2026",
      fixture("missing_day_menu.txt"),
    );

    expect(parsed.correctionHint).toBe(true);
    expect(parsed.specialsByDate["2026-04-22"]).toBeUndefined();
    expect(parsed.specialsByDate["2026-04-20"]).toBe("Roast Turkey");
  });

  it("applies switch corrections from forwarded messages", () => {
    const parsed = parseCafeteriaMenuEmail(
      "[Gbemploy] Changes to this weeks menu",
      `
      Please switch Tuesday and Thursday menus this week.

      Subject: [Gbemploy] Next weeks cafeteria menu
      GBO Cafeteria Menu
      November 17th-21st
      Monday: Southwest Chicken Wrap
      Tuesday: Baked Potato Bar
      Wednesday: Salad Bar
      Thursday: 8" Hot Italian Sub
      Friday: Chicken Noodle Soup
      `,
      "text",
      "2025-11-17T14:45:50Z",
    );

    expect(parsed.specialsByDate["2025-11-18"]).toBe('8" Hot Italian Sub');
    expect(parsed.specialsByDate["2025-11-20"]).toBe("Baked Potato Bar");
  });

  it("parses today's-menu change emails for the received day only", () => {
    const parsed = parseCafeteriaMenuEmail(
      "[Gbemploy] Slight change in todays menu",
      'We will be having a "Grilled" Chicken Breast Sandwich today....not "Breaded"',
      "text",
      "2025-08-15T14:40:04Z",
    );

    expect(parsed.weekStart).toBe("2025-08-11");
    expect(parsed.specialsByDate).toEqual({ "2025-08-15": '"Grilled" Chicken Breast Sandwich' });
  });

  it("parses Thunderbird format=flowed plain text bodies (real GBO menu)", () => {
    const parsed = parseCafeteriaMenuEmail(
      "[Gbemploy] Next weeks cafeteria menu",
      fixture("gbo_real_email.txt"),
      "text",
      "2026-04-24T17:55:29Z",
    );

    expect(parsed.weekStart).toBe("2026-04-27");
    expect(parsed.weekEnd).toBe("2026-05-01");
    expect(parsed.specialsByDate).toEqual({
      "2026-04-27": "Breaded Chicken Tenders, mashed potatoes with country gravy and corn",
      "2026-04-28": "Grilled Beef and Bean Burrito with chips and salsa",
      "2026-04-29": "Chef Salad with bread sticks",
      "2026-04-30": "Chicken Breast Sandwich with melted provolone served with house made chips",
      "2026-05-01": "Spinach and Mushroom Quesadillas served with black bean salad",
    });
    expect(parsed.correctionHint).toBe(false);
  });

  it("parses the real GBO menu HTML body with cross-month yearless date", () => {
    const parsed = parseCafeteriaMenuEmail(
      "[Gbemploy] Next weeks cafeteria menu",
      fixture("gbo_real_email.html"),
      "html",
      "2026-04-24T17:55:29Z",
    );

    expect(parsed.weekStart).toBe("2026-04-27");
    expect(parsed.specialsByDate["2026-04-27"]).toBe(
      "Breaded Chicken Tenders, mashed potatoes with country gravy and corn",
    );
    expect(parsed.specialsByDate["2026-05-01"]).toBe(
      "Spinach and Mushroom Quesadillas served with black bean salad",
    );
  });

  it("parses Outlook-rule-forwarded menus without losing content to the underscore separator", () => {
    const parsed = parseCafeteriaMenuEmail(
      "FW: [Gbemploy] Next weeks cafeteria menu",
      fixture("forwarded_outlook.txt"),
      "text",
      "2026-04-24T18:30:00Z",
    );

    expect(parsed.weekStart).toBe("2026-04-27");
    expect(Object.keys(parsed.specialsByDate)).toHaveLength(5);
    expect(parsed.specialsByDate["2026-04-27"]).toBe(
      "Breaded Chicken Tenders, mashed potatoes with country gravy and corn",
    );
    expect(parsed.specialsByDate["2026-05-01"]).toBe(
      "Spinach and Mushroom Quesadillas served with black bean salad",
    );
  });

  it("parses the checked-in example_menu_email.eml end-to-end", async () => {
    let raw: string;
    try {
      raw = readFileSync(join(REPO_FIXTURES, "example_menu_email.eml"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const parsedEmail = await PostalMime.parse(raw);
    const parsedMenu = parseCafeteriaMenuEmail(
      parsedEmail.subject || "",
      String(parsedEmail.html || parsedEmail.text || ""),
      parsedEmail.html ? "html" : "text",
      parsedEmail.date ? new Date(parsedEmail.date).toISOString() : undefined,
    );

    expect(parsedMenu.weekStart).toBe("2026-04-27");
    expect(parsedMenu.weekEnd).toBe("2026-05-01");
    expect(Object.keys(parsedMenu.specialsByDate)).toHaveLength(5);
    expect(parsedMenu.specialsByDate["2026-04-27"]).toMatch(/Breaded Chicken Tenders/);
    expect(parsedMenu.specialsByDate["2026-05-01"]).toMatch(/Spinach and Mushroom Quesadillas/);
  });
});
