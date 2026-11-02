import { forgetPanels, keepPanel, panelOf } from "./panelChoice";

beforeEach(() => forgetPanels());

it("keeps each chat's panel, Changes for a chat where none was picked", () => {
  keepPanel("a", "artifacts");
  keepPanel("b", "todos");
  expect(panelOf("a")).toBe("artifacts");
  expect(panelOf("b")).toBe("todos");
  expect(panelOf("c")).toBe("changes");
  keepPanel("a", "changes");
  expect(panelOf("a")).toBe("changes");
});

it("keeps nothing for no chat, and forgets them all", () => {
  keepPanel(null, "todos");
  expect(panelOf(null)).toBe("changes");
  keepPanel("a", "todos");
  forgetPanels();
  expect(panelOf("a")).toBe("changes");
});
