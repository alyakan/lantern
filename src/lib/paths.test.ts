import { describe, expect, it } from "vitest";
import { middleTruncate, tildePath } from "./paths";

describe("tildePath", () => {
  it("writes the home folder as ~", () => {
    expect(tildePath("/Users/you/projects/acme-api")).toBe("~/projects/acme-api");
    expect(tildePath("/home/you")).toBe("~");
  });

  it("leaves paths outside a home folder as they are", () => {
    expect(tildePath("/opt/acme-api")).toBe("/opt/acme-api");
    expect(tildePath("/Users")).toBe("/Users");
  });
});

describe("middleTruncate", () => {
  it("leaves a short text alone", () => {
    expect(middleTruncate("~/projects/acme-api", 40)).toBe("~/projects/acme-api");
  });

  it("keeps the start and the end of a long path and takes out the middle", () => {
    const long = "~/Documents/Github/Personal/clients/acme/services/billing-api/acme-api";
    const cut = middleTruncate(long, 40);
    expect([...cut]).toHaveLength(40);
    expect(cut.startsWith("~/Documents")).toBe(true);
    expect(cut.endsWith("/billing-api/acme-api")).toBe(true);
    expect(cut).toContain("…");
  });

  it("counts characters, not bytes", () => {
    const cut = middleTruncate("café/".repeat(20), 10);
    expect([...cut]).toHaveLength(10);
  });
});
