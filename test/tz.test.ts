import { describe, expect, it } from "vitest";
import { CAFETERIA_TZ, isoDateInZone } from "../src/tz";

describe("CAFETERIA_TZ", () => {
  it("is America/New_York", () => {
    expect(CAFETERIA_TZ).toBe("America/New_York");
  });
});

describe("isoDateInZone", () => {
  it("returns the local date in the cafeteria timezone by default", () => {
    expect(isoDateInZone(new Date("2026-04-26T12:00:00Z"))).toBe("2026-04-26");
  });

  it("rolls back across UTC midnight when ET is still the previous day", () => {
    expect(isoDateInZone(new Date("2026-04-26T03:45:00Z"))).toBe("2026-04-25");
  });

  it("agrees with UTC during the daytime ET window", () => {
    const noonEt = new Date("2026-04-26T16:00:00Z");
    expect(isoDateInZone(noonEt)).toBe("2026-04-26");
  });

  it("handles spring-forward (DST starts 2026-03-08)", () => {
    expect(isoDateInZone(new Date("2026-03-08T06:30:00Z"))).toBe("2026-03-08");
    expect(isoDateInZone(new Date("2026-03-08T07:30:00Z"))).toBe("2026-03-08");
  });

  it("handles fall-back (DST ends 2026-11-01)", () => {
    expect(isoDateInZone(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(isoDateInZone(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
  });

  it("respects an explicit timeZone override", () => {
    const instant = new Date("2026-04-26T03:45:00Z");
    expect(isoDateInZone(instant, "UTC")).toBe("2026-04-26");
    expect(isoDateInZone(instant, "America/Los_Angeles")).toBe("2026-04-25");
  });
});
