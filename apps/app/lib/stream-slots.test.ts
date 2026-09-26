import { describe, expect, it } from "vitest";
import { acquireStreamSlot, openStreamCount } from "./stream-slots";

describe("stream slots", () => {
  it("caps concurrent streams per user and releases idempotently", () => {
    const a = Array.from({ length: 5 }, () => acquireStreamSlot("u1", 5));
    expect(a.every(Boolean)).toBe(true);
    expect(acquireStreamSlot("u1", 5)).toBeNull();
    expect(acquireStreamSlot("u2", 5)).not.toBeNull();
    a[0]!.release();
    a[0]!.release();
    expect(openStreamCount("u1")).toBe(4);
    expect(acquireStreamSlot("u1", 5)).not.toBeNull();
    expect(acquireStreamSlot("u1", 5)).toBeNull();
  });
});
