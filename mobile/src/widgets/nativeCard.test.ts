import fs from "fs";
import path from "path";

// The lock-screen card is plain SwiftUI that plugins/withLanternCard.js puts into expo-widgets before the pods are installed.
// Swift isn't compiled by these tests (the card is drawn to a picture by native/preview/render.sh, and built by the TestFlight
// lane), so they hold what would otherwise fail only at that build: the pinned version, the files, and the names the
// generated widget bundle looks for.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../../plugins/withLanternCard") as { EXPO_WIDGETS_VERSION: string; FILES: string[] };
const root = path.resolve(__dirname, "../..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");

describe("the native lock-screen card", () => {
  it("is made from the expo-widgets version that is installed", () => {
    const installed = (JSON.parse(read("node_modules", "expo-widgets", "package.json")) as { version: string }).version;
    expect(plugin.EXPO_WIDGETS_VERSION).toBe(installed);
  });

  it("brings both Swift files, and the plugin is in the app's config after expo-widgets", () => {
    for (const name of plugin.FILES) expect(fs.existsSync(path.join(root, "native", name))).toBe(true);
    const plugins = (JSON.parse(read("app.json")) as { expo: { plugins: (string | [string, unknown])[] } }).expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(plugins.indexOf("./plugins/withLanternCard")).toBeGreaterThan(plugins.indexOf("expo-widgets"));
  });

  it("still gives the widget bundle the struct it names, and keeps expo-widgets' attributes as they were", () => {
    const ours = read("native", "WidgetLiveActivity.swift");
    const theirs = read("node_modules", "expo-widgets", "ios", "Widgets", "WidgetLiveActivity.swift");
    expect(ours).toContain("public struct WidgetLiveActivity: Widget");
    // The app starts and updates the card through these (LiveActivity.swift in the package), so the shape must be the same.
    const attributes = (s: string) => s.slice(s.indexOf("struct LiveActivityAttributes"), s.indexOf("public struct WidgetLiveActivity")).replace(/\s+/g, " ");
    const original = attributes(theirs);
    expect(original).toContain("var props: String?");
    expect(attributes(ours)).toContain("var name: String var props: String?");
    expect(attributes(ours).startsWith(original.slice(0, original.indexOf("init(url")))).toBe(true);
  });

  it("draws the card named LanternChat, the name the Mac's pushes and the app's layout use", () => {
    expect(read("native", "WidgetLiveActivity.swift")).toContain('lanternCardName = "LanternChat"');
    expect(read("src", "widgets", "lanternChat.tsx")).toContain('ACTIVITY_NAME = "LanternChat"');
  });

  it("reads only the words the Mac sends, and never fails to a blank card on ones it can't read", () => {
    const card = read("native", "LanternCard.swift");
    for (const key of ["project", "status", "since", "title", "steps_done", "steps_total", "needs", "plan"]) expect(card).toContain(key);
    expect(card).toContain("try? JSONDecoder().decode(LanternCardProps.self");
    expect(card).toContain("return LanternCardProps()");
  });

  it("draws a summary card from the chats and counts the Mac sends (lanternChat.tsx's layout is not what iOS draws)", () => {
    const card = read("native", "LanternCard.swift");
    expect(card).toContain("case project, status, since, title, steps_done, steps_total, needs, plan, chats, counts }");
    expect(card).toContain("case project, status, title, since }");
    expect(card).toContain("case needs_you, working, done, failed }");
    expect(card).toContain("var isSummary: Bool { props.chats != nil }");
    // No more rows than the Mac sends (SUMMARY_ROWS in live_activity.rs).
    const mac = fs.readFileSync(path.join(root, "..", "src-tauri", "src", "remote", "live_activity.rs"), "utf8");
    const rows = /pub const SUMMARY_ROWS: usize = (\d+);/.exec(mac)?.[1];
    expect(rows).toBeDefined();
    expect(card).toContain(`let lanternSummaryRows = ${rows}`);
  });
});
