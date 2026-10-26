/**
 * The card's layout, run as the card's own process runs it: the build turns the layout function into a string of source, and
 * the widget runtime gives that string Expo UI's components and modifiers (and the JSX calls) as globals, by their own names.
 * So this draws that very string with stand-ins for those globals: a name the layout uses that the runtime doesn't have (an
 * alias, a helper) is a ReferenceError here, as it would be a blank card on the phone. It covers what an older Mac sends too.
 */
type Node = { type: string; props: Record<string, any> };

jest.mock("expo-widgets", () => ({ createLiveActivity: (_name: string, layout: unknown) => ({ layout }) }));
jest.mock("@expo/ui/swift-ui", () => ({}));
jest.mock("@expo/ui/swift-ui/modifiers", () => ({}));

const COMPONENTS = ["HStack", "VStack", "ZStack", "Image", "Text", "ProgressView", "Spacer", "Gauge"];
const MODIFIERS = ["font", "foregroundStyle", "minimumScaleFactor", "monospacedDigit", "opacity", "padding", "tint", "lineLimit", "bold", "frame"];
const source = (require("./lanternChat") as { default: { layout: string } }).default.layout;

const jsx = (type: string, props: Record<string, unknown>): Node => ({ type, props });
// Only these names exist where the string runs (a few more, like `Math` and `Date`, are the language's own).
const globals: Record<string, unknown> = { _jsx: jsx, _jsxs: jsx, ...Object.fromEntries(COMPONENTS.map((c) => [c, c])), ...Object.fromEntries(MODIFIERS.map((m) => [m, (...args: unknown[]) => ({ name: m, args })])) };
const layout = new Function(...Object.keys(globals), `"use strict"; return (${source});`)(...Object.values(globals)) as (props: unknown, env: Record<string, unknown>) => Record<string, any>;

const draw = (props: Record<string, unknown>, env: Record<string, unknown> = {}) => layout({ project: "lantern", status: "working", since: 1000, ...props }, env);

/** Every text in a tree, in order. */
function texts(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  const n = node as Node;
  return texts(n.props?.children);
}

/** Every node of a type in a tree. */
function all(node: unknown, type: string): Node[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((c) => all(c, type));
  const n = node as Node;
  return [...(n.type === type ? [n] : []), ...all(n.props?.children, type)];
}

describe("the lock-screen card", () => {
  it("draws what an older Mac sends, the project and a state, as it always did", () => {
    const out = draw({});
    expect(texts(out.banner)).toEqual(expect.arrayContaining(["lantern", "Working"]));
    expect(all(out.banner, "ProgressView")).toHaveLength(0);
    expect(texts(out.banner).some((t) => /steps|Plan/.test(t))).toBe(false);
    expect(texts(out.compactTrailing)).toEqual(["Working"]);
  });

  it("adds the chat's title under the project", () => {
    expect(texts(draw({ title: "Release 0.1.63" }).banner)).toContain("Release 0.1.63");
  });

  it("shows how far the plan is, as a bar and in words, and the steps in the small island", () => {
    const out = draw({ steps_done: 3, steps_total: 5 });
    expect(all(out.banner, "ProgressView")[0].props.value).toBeCloseTo(0.6);
    expect(texts(out.banner)).toContain("3 of 5 steps");
    expect(texts(out.compactTrailing)).toEqual(["3/5"]);
    expect(texts(draw({ steps_done: 5, steps_total: 5 }).banner)).toContain("All 5 steps done");
  });

  it("holds odd numbers to something sensible", () => {
    expect(all(draw({ steps_done: 9, steps_total: 5 }).banner, "ProgressView")[0].props.value).toBe(1);
    expect(all(draw({ steps_done: -2, steps_total: 5 }).banner, "ProgressView")[0].props.value).toBe(0);
    expect(all(draw({ steps_done: 2, steps_total: 0 }).banner, "ProgressView")).toHaveLength(0);
    expect(all(draw({ steps_done: "x", steps_total: "y" }).banner, "ProgressView")).toHaveLength(0);
  });

  it("says in a few words what a chat that needs you is asking for, and only while it needs you", () => {
    const needs = (n: string) => texts(draw({ status: "needs_you", needs: n }).banner);
    expect(needs("command")).toContain("Wants to run a command");
    expect(needs("edit")).toContain("Wants to change a file");
    expect(needs("question")).toContain("Has a question");
    expect(needs("approval")).toContain("Needs your approval");
    expect(needs("tool")).toContain("Wants to use a tool");
    expect(needs("something new")).not.toEqual(expect.arrayContaining([expect.stringMatching(/Wants|Has a|Needs your/)]));
    expect(texts(draw({ status: "working", needs: "command" }).banner)).not.toContain("Wants to run a command");
  });

  it("shows the plan's usage, grey until 80%, yellow from there and red at the limit", () => {
    const colourOf = (plan: number) => {
      const t = all(draw({ plan }).banner, "Text").find((n) => texts(n) [0] === `Plan ${plan}%`)!;
      return t.props.modifiers.find((m: { name: string }) => m.name === "foregroundStyle").args[0];
    };
    expect(colourOf(43)).toBe("#8E8E93");
    expect(colourOf(79)).toBe("#8E8E93");
    expect(colourOf(80)).toBe("#F59E0B");
    expect(colourOf(100)).toBe("#EF4444");
  });

  it("goes grey and says so when the Mac stopped updating it, and white with the screen dimmed", () => {
    expect(texts(draw({ status: "needs_you", needs: "command" }, { isStale: true }).banner)).toEqual(expect.arrayContaining(["Not updating"]));
    expect(texts(draw({ status: "needs_you", needs: "command" }, { isStale: true }).banner)).not.toContain("Wants to run a command");
    const dim = all(draw({ steps_done: 1, steps_total: 2 }, { isLuminanceReduced: true }).banner, "ProgressView")[0];
    expect(dim.props.modifiers[0].args[0]).toBe("#FFFFFF");
  });

  it("has the extra lines in the expanded view too, and every part is present", () => {
    const out = draw({ title: "T", steps_done: 1, steps_total: 2, plan: 10 });
    for (const part of ["banner", "compactLeading", "compactTrailing", "minimal", "expandedLeading", "expandedTrailing", "expandedBottom"]) expect(out[part]).toBeTruthy();
    expect(texts(out.expandedBottom)).toEqual(expect.arrayContaining(["lantern", "T", "1 of 2 steps", "Plan 10%"]));
  });
});
