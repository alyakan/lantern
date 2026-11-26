import { act, fireEvent, screen } from "@testing-library/react-native";
import type { RemoteWebCard } from "../protocol/generated/RemoteWebCard";
import { reducer, initialState } from "../sync/reducer";
import { attachSession } from "../test/fakeSession";
import { connectedWith, makeController, NOW, renderWith } from "../test/render";
import { WebCards } from "./WebCards";

const card = (over: Partial<RemoteWebCard> = {}): RemoteWebCard => ({ id: "w1", title: "Rayak", canvas: "https://claude.ai/artifact/abc", message: "Build the header from the canvas", project: "/dev/rayak", project_name: "rayak", answer: false, chat: null, at: NOW, ...over });

async function open(cards: RemoteWebCard[], answers: Record<string, unknown> = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { projects: [{ id: "/dev/rayak", name: "rayak" }, { id: "/dev/lantern", name: "lantern" }], ...answers }, ["webclaude"]);
  await renderWith(<WebCards cards={cards} gutter={16} />, { connection: connectedWith(["webclaude"]) }, controller);
  return { session };
}

describe("web Claude's cards on the phone", () => {
  it("shows what web Claude sent and where it runs, and Run runs it in its project", async () => {
    const { session } = await open([card()]);
    expect(screen.getByText("From web Claude")).toBeTruthy();
    expect(screen.getByText("Rayak")).toBeTruthy();
    expect(screen.getByText("About a design canvas · in rayak")).toBeTruthy();
    expect(screen.getByText("Build the header from the canvas")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Run" })));
    expect(session.lastOf("web_run")).toEqual({ op: "web_run", id: "w1", run: true, project: null });
  });

  it("Decline declines it", async () => {
    const { session } = await open([card()]);
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Decline" })));
    expect(session.lastOf("web_run")).toEqual({ op: "web_run", id: "w1", run: false, project: null });
  });

  it("a card with no project asks which one to run it in", async () => {
    const { session } = await open([card({ project: null, project_name: null, canvas: "" })]);
    expect(screen.getByText("No design · pick a project to run it in")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Run in…" })));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "lantern" })));
    expect(session.lastOf("web_run")).toEqual({ op: "web_run", id: "w1", run: true, project: "/dev/lantern" });
  });

  it("says why when the Mac refuses", async () => {
    await open([card()], { web_run: new Error("That was answered already, on your Mac or another phone.") });
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Run" })));
    expect(screen.getByRole("alert")).toHaveTextContent("That was answered already, on your Mac or another phone.");
  });

  it("an answer says which chat it goes back to", async () => {
    await open([card({ answer: true, chat: "Header chat" })]);
    expect(screen.getByText("Web Claude answered")).toBeTruthy();
    expect(screen.getByText("Answers a chat's question · goes to Header chat")).toBeTruthy();
  });

  it("nothing shows when nothing waits", async () => {
    await open([]);
    expect(screen.queryByText("From web Claude")).toBeNull();
  });

  it("the cards the Mac pushes replace those before", () => {
    const s = reducer(initialState, { type: "pushed", msg: { type: "web_cards", cards: [card()] } } as never);
    expect(s.webCards.map((c) => c.id)).toEqual(["w1"]);
    expect(reducer(s, { type: "pushed", msg: { type: "web_cards", cards: [] } } as never).webCards).toEqual([]);
  });
});
