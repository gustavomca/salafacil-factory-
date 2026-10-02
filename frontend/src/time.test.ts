import { describe, it, expect, vi, afterEach } from "vitest";
import {
  estimatedNow,
  localCandidates,
  localDayRange,
  localValue,
  rangeError,
  suggestedStart,
  syncClock,
} from "./time";
afterEach(() => vi.restoreAllMocks());
describe("local dates and server clock", () => {
  it("rejects nonexistent spring time without silently shifting it", () => {
    expect(localCandidates("2026-03-08T02:30", "America/New_York")).toEqual([]);
  });
  it("requires an explicit offset for a repeated local hour", () => {
    const candidates = localCandidates("2026-11-01T01:30", "America/New_York");
    expect(candidates.map((c) => c.iso)).toEqual([
      "2026-11-01T01:30:00-04:00",
      "2026-11-01T01:30:00-05:00",
    ]);
    expect(candidates[1].epoch - candidates[0].epoch).toBe(3600000);
  });
  it("handles half-hour timezone transitions and quarter-hour offsets", () => {
    expect(
      localCandidates("2026-10-04T02:15", "Australia/Lord_Howe"),
    ).toHaveLength(0);
    expect(
      localCandidates("2026-04-05T01:45", "Australia/Lord_Howe"),
    ).toHaveLength(2);
    expect(localCandidates("2026-10-02T10:30", "Asia/Kathmandu")[0].iso).toBe(
      "2026-10-02T10:30:00+05:45",
    );
  });
  it("rejects invalid calendar dates", () => {
    expect(localCandidates("2026-02-30T09:00", "UTC")).toEqual([]);
    expect(localCandidates("bad", "UTC")).toEqual([]);
  });
  it("calculates real duration across midnight and DST", () => {
    const start = localCandidates("2026-03-08T01:30", "America/New_York")[0];
    const end = localCandidates("2026-03-08T03:30", "America/New_York")[0];
    expect((end.epoch - start.epoch) / 60000).toBe(60);
    expect(rangeError(start, end, false)).toBe("");
    const midnight = localCandidates("2030-01-01T23:30", "UTC")[0],
      later = localCandidates("2030-01-02T00:00", "UTC")[0];
    expect(rangeError(midnight, later, false)).toBe("");
    expect(localValue(later.epoch, "UTC")).toBe("2030-01-02T00:00");
  });
  it("rejects subminimum duration and end before start", () => {
    const start = localCandidates("2030-01-01T10:00", "UTC")[0],
      end = localCandidates("2030-01-01T10:14", "UTC")[0];
    expect(rangeError(start, end, false)).toMatch(/15 minutos/);
    expect(rangeError(end, start, false)).toMatch(/15 minutos/);
  });
  it("uses midpoint and monotonic elapsed time instead of a divergent client clock", () => {
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("1990-01-01T00:00:00Z"));
    syncClock("2030-01-01T10:01:30Z", 800, 1200);
    expect(estimatedNow()).toBe(Date.parse("2030-01-01T10:01:30Z"));
    expect(suggestedStart()).toBe(Date.parse("2030-01-01T10:05:00Z"));
    performanceNow.mockReturnValue(181000);
    expect(estimatedNow()).toBe(Date.parse("2030-01-01T10:04:30Z"));
    expect(suggestedStart()).toBe(Date.parse("2030-01-01T10:10:00Z"));
  });
});

describe("calendar day boundaries", () => {
  it.each([
    ["2027-03-14", 23],
    ["2026-11-01", 25],
  ])("builds %s using %s actual hours", (date, hours) => {
    const range = localDayRange(String(date), "America/New_York")!;
    expect((Date.parse(range.to) - Date.parse(range.from)) / 3600000).toBe(
      hours,
    );
  });
  it("rejects malformed calendar dates without crashing navigation", () => {
    expect(localDayRange("broken", "UTC")).toBeNull();
    expect(localDayRange("2030-02-30", "UTC")).toBeNull();
  });
});
