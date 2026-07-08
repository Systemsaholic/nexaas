/**
 * Unit tests for spend-governor day-bucketing (#215 daily budget) —
 * critical-function coverage from #257. The daily spend ledger keys on
 * localDay(); a timezone bug here silently splits or merges budget days,
 * which is exactly how a hard cap gets breached without an alert.
 */
import { describe, expect, it } from "vitest";
import { localDay } from "../packages/runtime/src/models/spend-governor.js";

describe("localDay", () => {
  // 2026-01-02T03:00:00Z: still Jan 1 in Toronto (UTC-5), already Jan 2 in UTC.
  const instant = new Date("2026-01-02T03:00:00Z");

  it("formats YYYY-MM-DD in UTC", () => {
    expect(localDay("UTC", instant)).toBe("2026-01-02");
  });

  it("crosses midnight boundaries per-timezone", () => {
    expect(localDay("America/Toronto", instant)).toBe("2026-01-01");
    expect(localDay("Australia/Sydney", instant)).toBe("2026-01-02");
  });

  it("handles DST-observing zones on a summer instant", () => {
    // 2026-07-02T03:00:00Z: Toronto is UTC-4 in July → still July 1.
    expect(localDay("America/Toronto", new Date("2026-07-02T03:00:00Z"))).toBe("2026-07-01");
  });

  it("falls back to the ISO date on an invalid timezone", () => {
    expect(localDay("Not/AZone", instant)).toBe("2026-01-02");
  });
});
