import { StyleSheet } from "react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith, waiting } from "../test/render";
import { answersFrom, CLOSE_AFTER_MS, DecideScreen } from "./DecideScreen";
import { approvalOf } from "../view/prompts";

const push = waiting({ request_id: "p1" });
const question = waiting({
  request_id: "q1",
  tool_name: "AskUserQuestion",
  input: { questions: [{ question: "Which channel?", header: "Channel", options: [{ label: "Stable", description: "Everyone gets it" }, { label: "Beta", description: "Testers first" }], multiSelect: false }] },
});

async function decide(w = push, answers: Parameters<typeof attachSession>[1] = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const onClose = jest.fn();
  await renderWith(<DecideScreen slot="a" requestId={w.request_id} onClose={onClose} />, { chats: [chat()], waiting: [w] }, controller);
  return { controller, onClose, ...session };
}

const swipe = () => screen.getByLabelText("Swipe to allow");
const activate = (node = swipe()) => fireEvent(node, "accessibilityAction", { nativeEvent: { actionName: "activate" } });

describe("deciding", () => {
  it("says what is asked and where it runs, with the command to read before allowing it", async () => {
    await decide();
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(screen.getByText("Push the release branch")).toBeTruthy();
    expect(screen.getByText("Release 0.1.53, in lantern")).toBeTruthy();
    expect(screen.getByText("git push origin release/0.1.53")).toBeTruthy();
    expect(screen.getByText(/This runs on/)).toBeTruthy();
  });

  it("a tap on the swipe does not allow anything", async () => {
    const { asked } = await decide();
    await fireEvent.press(swipe());
    await fireEvent.press(screen.getByTestId("swipe-knob"));
    expect(asked.filter((r) => r.op === "answer")).toEqual([]);
    expect(screen.queryByText("Allowed.")).toBeNull();
  });

  it("a screen reader's Allow action allows, once", async () => {
    const { lastOf, asked } = await decide();
    const bar = swipe();
    await activate(bar);
    await activate(bar);
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    expect(lastOf("answer")).toEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: null });
    expect(asked.filter((r) => r.op === "answer")).toHaveLength(1);
  });

  it("keeps the bar on screen once allowed, closed in to a check circle that goes back to the chat, in place of Deny and Done", async () => {
    const { onClose } = await decide();
    await act(async () => activate());
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Allowed" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an allow closes by itself after two seconds, and the circle closes it sooner", async () => {
    expect(CLOSE_AFTER_MS).toBe(2000);
    const { onClose } = await decide();
    await activate();
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    const allowedAt = Date.now();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: CLOSE_AFTER_MS + 1500 });
    expect(Date.now() - allowedAt).toBeGreaterThanOrEqual(CLOSE_AFTER_MS - 250);
  });

  it("says what it came to in small, regular text, not a line of its own voice", async () => {
    await decide();
    await act(async () => activate());
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    const style = StyleSheet.flatten(screen.getByText("Allowed.").props.style);
    expect(style).toMatchObject({ fontSize: 13 });
    expect(style.fontWeight).toBeUndefined();
  });

  it("keeps the circle where the bar was: Deny's place is held, unseen, not given up", async () => {
    await decide();
    await act(async () => activate());
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    // Not there to a reader or a finger…
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    // …but still taking its room under the circle.
    expect(screen.getByText("Deny", { includeHiddenElements: true })).toBeTruthy();
  });

  it("the circle can't be tapped away before the answer has gone", async () => {
    let release: (v: unknown) => void = () => {};
    const { controller } = makeController();
    controller.sync.onSession({ welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 }, ask: () => new Promise((r) => (release = r)) } as never);
    const onClose = jest.fn();
    await renderWith(<DecideScreen slot="a" requestId="p1" onClose={onClose} />, { chats: [chat()], waiting: [waiting()] }, controller);
    await act(async () => activate());
    // The bar says it was allowed, but it is not yet something to press.
    await fireEvent.press(screen.getByRole("button", { name: "Allowed" }));
    expect(onClose).not.toHaveBeenCalled();
    release(null);
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Allowed" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("brings a fresh swipe back when the answer failed, not one that looks allowed", async () => {
    await decide(push, { answer: new Error("That was answered already, or Claude stopped asking.") });
    await act(async () => activate());
    await waitFor(() => expect(screen.getByText("That was answered already, or Claude stopped asking.")).toBeTruthy());
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    expect(screen.queryByLabelText("Allowed")).toBeNull();
    // And it can be tried again.
    await act(async () => activate(screen.getByLabelText("Swipe to allow")));
    await waitFor(() => expect(screen.getAllByText("That was answered already, or Claude stopped asking.").length).toBeGreaterThan(0));
  });

  it("denies with one tap", async () => {
    const { lastOf } = await decide();
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.getByText("Denied.")).toBeTruthy());
    expect(lastOf("answer")).toMatchObject({ allow: false, answers: null });
  });

  it("says why when it can't be answered (it was answered already), and stays so it can be closed", async () => {
    await decide(push, { answer: new Error("That was answered already, or Claude stopped asking.") });
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.getByText("That was answered already, or Claude stopped asking.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("closes by itself a moment after it is answered", async () => {
    const { onClose } = await decide();
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: CLOSE_AFTER_MS + 1500 });
  });

  it("when the Mac answers first, says so and closes, without having sent anything", async () => {
    const { controller, onClose, asked } = await decide();
    await act(async () => controller.sync.apply({ type: "waiting", list: [] }));
    expect(screen.getByText("Answered on your Mac.")).toBeTruthy();
    expect(screen.getByText("Push the release branch")).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: CLOSE_AFTER_MS + 1500 });
    expect(asked.filter((r) => r.op === "answer")).toEqual([]);
  });

  it("says a prompt already gone was answered already", async () => {
    const { controller } = makeController();
    const onClose = jest.fn();
    await renderWith(<DecideScreen slot="a" requestId="nope" onClose={onClose} />, { chats: [chat()], waiting: [] }, controller);
    expect(screen.getByText("This was answered already")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("an approval says what it approves, and is approved with a swipe", async () => {
    const approval = waiting({ request_id: "ap", tool_name: "mcp__lantern__request_approval", input: { action: "merge PR 12", reason: "CI is green" } });
    const { lastOf } = await decide(approval);
    expect(screen.getByText("Approval")).toBeTruthy();
    expect(screen.getByText("Approve merge PR 12?")).toBeTruthy();
    expect(screen.getByText("CI is green")).toBeTruthy();
    await act(async () => void activate(screen.getByLabelText("Swipe to approve")));
    await waitFor(() => expect(lastOf("answer")).toMatchObject({ request_id: "ap", allow: true }));
    expect(approvalOf("Bash", {})).toBeNull();
  });
});

describe("a question", () => {
  it("shows its options, and sends the chosen one as the answer", async () => {
    const { lastOf } = await decide(question);
    expect(screen.getByText("Claude has a question")).toBeTruthy();
    expect(screen.getByText("Which channel?")).toBeTruthy();
    expect(screen.getByText("Testers first")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send answer" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByText("Beta"));
    await fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(screen.getByText("Answer sent.")).toBeTruthy());
    expect(lastOf("answer")).toEqual({ op: "answer", slot: "a", request_id: "q1", allow: true, message: null, answers: { "Which channel?": "Beta" } });
  });

  it("takes something typed instead of an option", async () => {
    const { lastOf } = await decide(question);
    await fireEvent.press(screen.getByText("Stable"));
    await fireEvent.changeText(screen.getByLabelText("Something else"), "  Nightly only  ");
    await fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(lastOf("answer")).toMatchObject({ answers: { "Which channel?": "Nightly only" } }));
  });

  it("can be declined", async () => {
    const { lastOf } = await decide(question);
    await fireEvent.press(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.getByText("Declined.")).toBeTruthy());
    expect(lastOf("answer")).toMatchObject({ allow: false, answers: null });
  });
});

describe("a question's answers", () => {
  const qs = [
    { question: "One?", header: "", options: [], multiSelect: false },
    { question: "Many?", header: "", options: [], multiSelect: true },
  ];

  it("come to one string each, a multi-select joined", () => {
    expect(answersFrom(qs, { "One?": ["a"], "Many?": ["x", "y"] }, {})).toEqual({ "One?": "a", "Many?": "x, y" });
  });

  it("prefer what was typed, and are nothing until every question has one", () => {
    expect(answersFrom(qs, { "One?": ["a"], "Many?": ["x"] }, { "One?": " mine " })).toEqual({ "One?": "mine", "Many?": "x" });
    expect(answersFrom(qs, { "One?": ["a"] }, {})).toBeNull();
    expect(answersFrom(qs, {}, {})).toBeNull();
  });
});
