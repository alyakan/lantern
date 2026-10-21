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
    await act(async () => {
      activate();
      activate();
    });
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    expect(lastOf("answer")).toEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: null });
    expect(asked.filter((r) => r.op === "answer")).toHaveLength(1);
  });

  it("keeps the swipe on screen once allowed, saying so, with a Done beside it instead of Deny", async () => {
    await decide();
    await act(async () => activate());
    await waitFor(() => expect(screen.getByText("Allowed.")).toBeTruthy());
    expect(screen.getByLabelText("Allowed")).toBeTruthy();
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
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
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByRole("button", { name: "Deny" }));
      await act(async () => void (await Promise.resolve()));
      await act(async () => void jest.advanceTimersByTime(CLOSE_AFTER_MS + 100));
      expect(onClose).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("when the Mac answers first, says so and closes, without having sent anything", async () => {
    const { controller, onClose, asked } = await decide();
    jest.useFakeTimers();
    try {
      await act(async () => controller.sync.apply({ type: "waiting", list: [] }));
      expect(screen.getByText("Answered on your Mac.")).toBeTruthy();
      expect(screen.getByText("Push the release branch")).toBeTruthy();
      await act(async () => void jest.advanceTimersByTime(CLOSE_AFTER_MS + 100));
      expect(onClose).toHaveBeenCalled();
      expect(asked.filter((r) => r.op === "answer")).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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
