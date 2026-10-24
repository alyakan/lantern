import { EMBER, tint } from "./accent";

describe("a faint wash of the accent", () => {
  it("is the colour at the strength asked for", () => {
    expect(tint(EMBER, 0.08)).toBe("rgba(217,72,15,0.08)");
    expect(tint("#0000FF", 0.5)).toBe("rgba(0,0,255,0.5)");
  });

  it("leaves anything that isn't a #rrggbb colour as it is", () => {
    expect(tint("rgba(1,2,3,0.4)", 0.08)).toBe("rgba(1,2,3,0.4)");
    expect(tint("blue", 0.08)).toBe("blue");
    expect(tint("#fff", 0.08)).toBe("#fff");
  });
});
