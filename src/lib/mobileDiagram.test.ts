import { expect, it } from "vitest";
// @ts-expect-error Vitest supplies jsdom; it has no bundled declarations.
import { JSDOM } from "jsdom";
import { layoutArchitecture, parseArchitecture } from "./archGraph";
import { diagramDocument, selectionMessage } from "../../shared/mobileDiagram";

const colors = { paper: "#eef1f4", card: "#fff", wash: "#eee", ink: "#15212e", ink2: "#566272", rule: "#dce2e8", stop: "#b3261e", working: "#b85a00", cobalt: "#2f5bff", go: "#28754d", white: "#fff" };
const parsed = parseArchitecture(JSON.stringify({ nodes: [{ id: "phone", label: "Phone", note: "A note" }, { id: "mac", label: "Mac" }, { id: "other", label: "Other" }], edges: [{ from: "phone", to: "mac", label: "connects" }, { from: "mac", to: "other" }] }));
if (!("spec" in parsed)) throw new Error(parsed.error);
const layout = layoutArchitecture(parsed.spec);

function viewer() {
  let resize = () => {};
  let width = 390, height = 700;
  const messages: string[] = [];
  const dom = new JSDOM(diagramDocument(layout, colors, true), {
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window: Window & typeof globalThis) {
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => width });
      Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get: () => height });
      window.ResizeObserver = class { constructor(callback: () => void) { resize = callback; } observe() {} } as never;
      (window as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }).ReactNativeWebView = { postMessage: s => messages.push(s) };
    },
  });
  const doc = dom.window.document;
  const surface = doc.getElementById("surface")!;
  const node = (id: string) => doc.querySelector(`[data-node="${id}"]`)!;
  const edge = (id: string) => doc.querySelector(`[data-edge="${id}"]`)!;
  const transform = () => doc.getElementById("world")!.getAttribute("transform");
  const pointer = (target: Element, type: string, x: number, y: number, id = 1) => {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: id, button: 0 });
    target.dispatchEvent(event);
  };
  const tap = (target: Element) => { pointer(target, "pointerdown", 100, 100); pointer(target, "pointerup", 100, 100); };
  return { dom, doc, surface, node, edge, transform, pointer, tap, messages, rotate: () => { width = 800; height = 300; resize(); } };
}

it("pins node/link connections until tapped again or cleared, including after zoom, pan and rotation", () => {
  const v = viewer();
  v.tap(v.node("phone"));
  expect(v.node("other").getAttribute("style")).toContain("opacity: 0.25");
  expect(v.edge("e0").getAttribute("aria-pressed")).toBe("false");
  expect(v.doc.getElementById("clear")!.hidden).toBe(false);
  v.doc.getElementById("plus")!.click();
  v.pointer(v.surface, "pointerdown", 100, 100);
  v.pointer(v.surface, "pointermove", 160, 120);
  v.pointer(v.surface, "pointerup", 160, 120);
  const before = v.transform();
  v.rotate();
  expect(v.transform()).not.toBe(before);
  expect(v.transform()!.match(/scale\(([^)]+)\)/)![1]).toBe(before!.match(/scale\(([^)]+)\)/)![1]);
  expect(v.node("phone").getAttribute("aria-pressed")).toBe("true");
  v.tap(v.surface);
  expect(v.node("phone").getAttribute("aria-pressed")).toBe("true");
  v.tap(v.node("phone"));
  expect(v.doc.getElementById("clear")!.hidden).toBe(true);
  v.tap(v.edge("e1"));
  expect(v.edge("e1").getAttribute("aria-pressed")).toBe("true");
  expect(v.edge("e0").getAttribute("style")).toContain("opacity: 0.22");
  v.doc.getElementById("clear")!.click();
  expect(v.messages[v.messages.length - 1]).toBe('{"selection":null}');
  v.node("mac").dispatchEvent(new v.dom.window.MouseEvent("click", { bubbles: true, detail: 0 }));
  expect(v.node("mac").getAttribute("aria-pressed")).toBe("true");
  v.dom.window.close();
});

it("distinguishes a tap from a drag, pinch or cancelled touch", () => {
  const v = viewer();
  const n = v.node("phone");
  const initial = v.transform();
  v.pointer(n, "pointerdown", 100, 100);
  v.pointer(n, "pointermove", 150, 100);
  v.pointer(n, "pointerup", 150, 100);
  expect(v.transform()).not.toBe(initial);
  expect(v.messages).toHaveLength(0);
  v.pointer(n, "pointerdown", 100, 100);
  v.pointer(n, "pointerdown", 200, 100, 2);
  const before = v.transform();
  v.pointer(n, "pointermove", 300, 100, 2);
  expect(v.transform()).not.toBe(before);
  v.pointer(n, "pointerup", 300, 100, 2);
  v.pointer(n, "pointerup", 100, 100);
  v.pointer(n, "pointerdown", 100, 100);
  v.pointer(n, "pointercancel", 100, 100);
  expect(v.messages).toHaveLength(0);
  v.tap(n);
  expect(v.messages).toHaveLength(1);
  v.dom.window.close();
});

it("escapes diagram text and accepts only selection messages with existing ids", () => {
  const p = parseArchitecture('{"nodes":[{"id":"a","label":"</script><img src=x onerror=alert(1)>"}]}');
  if (!("spec" in p)) throw new Error(p.error);
  const doc = new JSDOM(diagramDocument(layoutArchitecture(p.spec), colors, true)).window.document;
  expect(doc.querySelector("img")).toBeNull();
  expect(doc.querySelector("[data-node]")!.getAttribute("data-detail")).toContain("</script>");
  expect(selectionMessage('{"selection":{"kind":"node","id":"phone"}}', layout)).toEqual({ kind: "node", id: "phone" });
  expect(selectionMessage('{"selection":{"kind":"edge","id":"e0"}}', layout)).toEqual({ kind: "edge", id: "e0" });
  for (const message of ['{"selection":{"kind":"node","id":"missing"}}', '{"selection":{"kind":"navigate","id":"phone"}}', "bad json"]) expect(selectionMessage(message, layout)).toBeUndefined();
});
