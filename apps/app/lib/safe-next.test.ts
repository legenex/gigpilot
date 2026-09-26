import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext (M1 open redirect)", () => {
  it.each([
    ["/", "/"],
    ["/radar", "/radar"],
    ["/radar?sel=abc&x=1", "/radar?sel=abc&x=1"],
    ["/jobs/123#dag", "/jobs/123#dag"],
    ["/a/../settings", "/settings"],
    ["/radar/%E2%9C%93", "/radar/%E2%9C%93"],
  ])("keeps same-origin path %j", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    ["/\t/evil"],
    ["/\n/evil"],
    ["/\r//evil"],
    ["/\\evil"],
    ["/\\/evil"],
    ["\\\\evil"],
    ["//evil"],
    ["//evil.com/path"],
    ["///evil"],
    ["https://evil"],
    ["https://evil.com/radar"],
    ["http:/evil"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["evil.com"],
    ["radar"],
    ["/%2F%2Fevil"],
    ["/%2fevil"],
    ["/%5Cevil"],
    ["/%5c%5cevil"],
    ["/%09/evil"],
    ["/%0A/evil"],
    ["/%00"],
    ["/%E0%A4%A"],
    ["/api/auth/sign-out"],
    ["/API/events/stream"],
    ["/%61pi/auth/sign-out"],
    ["/api"],
    ["\u0000/radar"],
    ["/\u0085evil"],
    [""],
    [null],
    [undefined],
    ["/" + "a".repeat(3000)],
  ])("rejects %j", (input) => {
    expect(safeNext(input as string | null | undefined)).toBe("/");
  });

  it("never returns an absolute or protocol-relative URL", () => {
    const probes = ["/\t\t//evil", "/ /evil", "/.//evil", "/./\\evil", "/@evil", "/%40evil", "/?next=//evil", "/#//evil"];
    for (const p of probes) {
      const out = safeNext(p);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "http://app.local").origin).toBe("http://app.local");
    }
  });
});
