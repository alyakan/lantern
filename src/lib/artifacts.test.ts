import { describe, expect, it } from "vitest";
import { artifactName, artifactUrl, themeVars } from "./artifacts";

describe("artifactName", () => {
  it("names the folder's artifacts and nothing else", () => {
    expect(artifactName("/p/.lantern/artifacts/map.html", "/p")).toBe("map.html");
    expect(artifactName("/p/.lantern/artifacts/maps/Flow.MMD", "/p/")).toBe("maps/Flow.MMD");
    expect(artifactName("/p/.lantern/artifacts/data.json", "/p")).toBeNull();
    expect(artifactName("/p/src/map.html", "/p")).toBeNull();
    expect(artifactName("/other/.lantern/artifacts/map.html", "/p")).toBeNull();
    expect(artifactName("/p/.lantern/artifacts/../../x.html", "/p")).toBeNull();
    expect(artifactName("/p/.lantern/artifacts/map.html", null)).toBeNull();
  });
});

describe("artifactUrl", () => {
  it("escapes each part of the name and keeps the folders", () => {
    expect(artifactUrl("k", "maps/a b#1.html")).toBe("lantern-artifact://localhost/k/maps/a%20b%231.html");
    expect(artifactUrl("k", "x.svg", 7)).toBe("lantern-artifact://localhost/k/x.svg?v=7");
  });
});

describe("themeVars", () => {
  it("gives the shared variables, the series colours under their own names, and the scheme", () => {
    const root = document.createElement("div");
    root.style.setProperty("--text", "#111111");
    root.style.setProperty("--storage-2", "#c4570c");
    root.style.setProperty("--pc-tint", "13%");
    document.body.append(root);
    const vars = themeVars(true, root);
    expect(vars["--text"]).toBe("#111111");
    expect(vars["--series-2"]).toBe("#c4570c");
    expect(vars["--color-scheme"]).toBe("dark");
    expect(vars["--pc-tint"]).toBeUndefined();
    root.remove();
  });
});
