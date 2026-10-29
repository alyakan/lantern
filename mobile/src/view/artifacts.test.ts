import { artifactDocument, artifactFolder, artifactList, artifactTitle, isOwnPage, PAGE_POLICY, themeCss } from "./artifacts";
import { darkColors, lightColors } from "../ui/theme";

describe("the artifacts list", () => {
  it("keeps the well formed rows, newest first, and drops names that go up or out and kinds it doesn't know", () => {
    const list = artifactList([
      { name: "old.md", kind: "markdown", modified: 1, size: 3 },
      { name: "maps/new.html", kind: "html", modified: 9, size: 5 },
      { name: "../secret.md", kind: "markdown", modified: 99, size: 1 },
      { name: "/etc/passwd", kind: "markdown", modified: 99, size: 1 },
      { name: "a//b.md", kind: "markdown", modified: 99, size: 1 },
      { name: "x.pdf", kind: "pdf", modified: 99, size: 1 },
      { name: 4, kind: "html" },
      null,
    ]);
    expect(list.map((a) => a.name)).toEqual(["maps/new.html", "old.md"]);
  });

  it("is empty for anything that isn't a list", () => {
    expect(artifactList(null)).toEqual([]);
    expect(artifactList({ name: "a.md" })).toEqual([]);
  });

  it("makes a title and a folder from a name", () => {
    expect(artifactTitle("maps/auth-flow_v2.html")).toBe("auth flow v2");
    expect(artifactTitle("notes.md")).toBe("notes");
    expect(artifactFolder("maps/deep/auth.html")).toBe("maps/deep/");
    expect(artifactFolder("notes.md")).toBe("");
  });
});

describe("the page for the web view", () => {
  it("puts the policy first, with no way to run a script or make a request", () => {
    const doc = artifactDocument("<p>hi</p>", lightColors);
    expect(doc.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>hi</p>"));
    expect(PAGE_POLICY.startsWith("default-src 'none'")).toBe(true);
    for (const open of ["script-src", "connect-src", "frame-src", "form-action *"]) expect(PAGE_POLICY).not.toContain(open);
    expect(PAGE_POLICY).toContain("form-action 'none'");
    expect(PAGE_POLICY).toContain("base-uri 'none'");
  });

  it("gives the page the phone's colours under the names the Mac's theme file uses, for light and for dark", () => {
    const light = themeCss(lightColors);
    const dark = themeCss(darkColors);
    for (const name of ["--text", "--bg", "--pane", "--line", "--muted", "--accent", "--add", "--del", "--series-1", "--series-7", "--mono"]) {
      expect(light).toContain(`${name}:`);
    }
    expect(light).toContain("--color-scheme:light");
    expect(dark).toContain("--color-scheme:dark");
    expect(dark).toContain(`--text:${darkColors.ink}`);
    expect(light).not.toEqual(dark);
  });

  it("lets nothing load but the page itself", () => {
    expect(isOwnPage("about:blank")).toBe(true);
    for (const url of ["https://example.com/", "http://127.0.0.1:9/", "file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "lantern://x"]) expect(isOwnPage(url)).toBe(false);
  });
});
