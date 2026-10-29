import "@shopify/flash-list/jestSetup";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { ArtifactsPane } from "./ArtifactsPane";

// A stand-in for the web view: it shows what it was given, so a test reads the props the page is drawn with.
jest.mock("react-native-webview", () => {
  const mockReact = require("react");
  const { View } = require("react-native");
  return { WebView: (props: Record<string, unknown>) => mockReact.createElement(View, { testID: "web", ...props }) };
});

const LIST = [
  { name: "tonight.html", kind: "html", modified: 9_000, size: 120 },
  { name: "flow.md", kind: "markdown", modified: 5_000, size: 30 },
  { name: "arch.mmd", kind: "mermaid", modified: 3_000, size: 20 },
];

async function pane(answers: Parameters<typeof attachSession>[1] = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { artifacts: LIST, artifact_read: "<p>hello</p>", ...answers }, ["artifacts"]);
  const onHide = jest.fn();
  await renderWith(<ArtifactsPane slot="a" onHide={onHide} />, { chats: [chat()], events: { a: [] } }, controller);
  return { ...session, onHide };
}

describe("the Artifacts pane", () => {
  it("lists the artifacts and draws the newest page in a web view with scripts off and nothing but the page allowed to load", async () => {
    const { lastOf } = await pane();
    expect(await screen.findByText("3 artifacts")).toBeTruthy();
    await waitFor(() => expect(lastOf("artifact_read")).toEqual({ op: "artifact_read", slot: "a", name: "tonight.html" }));
    const web = await screen.findByTestId("web");
    expect(web.props.javaScriptEnabled).toBe(false);
    expect(web.props.domStorageEnabled).toBe(false);
    // Not a whitelist of its own: what it leaves out is opened in Safari by the web view; the check below refuses it instead.
    expect(web.props.originWhitelist).toEqual(["*"]);
    expect(web.props.source.html).toContain("<p>hello</p>");
    expect(web.props.source.html.indexOf("Content-Security-Policy")).toBeLessThan(web.props.source.html.indexOf("<p>hello</p>"));
    expect(web.props.onShouldStartLoadWithRequest({ url: "about:blank" })).toBe(true);
    expect(web.props.onShouldStartLoadWithRequest({ url: "https://example.com/" })).toBe(false);
    expect(screen.getByText("Shown without scripts, and nothing it links to is loaded.")).toBeTruthy();
  });

  it("draws Markdown as the chat does and a diagram as its source", async () => {
    const { lastOf } = await pane({ artifact_read: "# Release flow\n\nThen **publish**." });
    await fireEvent.press(await screen.findByRole("button", { name: "flow, Notes" }));
    await waitFor(() => expect(lastOf("artifact_read")).toEqual({ op: "artifact_read", slot: "a", name: "flow.md" }));
    expect(await screen.findByText("Release flow")).toBeTruthy();
    expect(screen.queryByTestId("web")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "arch, Diagram" }));
    expect(await screen.findByText("A diagram is drawn on your Mac. Its source is here.")).toBeTruthy();
  });

  it("says why when the Mac can't give an artifact, and when there are none", async () => {
    await pane({ artifact_read: new Error("That artifact is too big to show.") });
    expect(await screen.findByText("That artifact is too big to show.")).toBeTruthy();
  });

  it("says when the folder has none, and hides when asked", async () => {
    const { onHide } = await pane({ artifacts: [] });
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Hide" }));
    expect(onHide).toHaveBeenCalled();
  });

  it("says why when the list doesn't come", async () => {
    await pane({ artifacts: new Error("That chat isn't open on your Mac.") });
    expect(await screen.findByText("That chat isn't open on your Mac.")).toBeTruthy();
  });
});
