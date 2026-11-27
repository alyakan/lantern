import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DockedQuestion, LEAVE_MS, PICK_BEAT_MS, QuestionCard } from "./QuestionCard";
import { PermissionCard } from "./PermissionCard";
import { readQuestions, withAnswers } from "../lib/questions";

const input = {
  questions: [
    { question: "Where should retries live?", header: "Retries", multiSelect: false, options: [{ label: "In fetchJson (Recommended)", description: "One place" }, { label: "In each caller", description: "Only where needed" }] },
    { question: "Which codes?", header: "Codes", multiSelect: true, options: [{ label: "429", description: "" }, { label: "503", description: "" }] },
  ],
};
const item = (over = {}) => ({ type: "permission" as const, id: "q1", toolName: "AskUserQuestion", input, decision: null, ...over });

describe("questions", () => {
  it("reads the questions and puts the answers back in the input, keyed by question", () => {
    const qs = readQuestions(input);
    expect(qs.map((q) => [q.header, q.multiSelect, q.options.length])).toEqual([["Retries", false, 2], ["Codes", true, 2]]);
    expect(withAnswers(input, qs, { "Where should retries live?": { picked: [], other: "In a wrapper" }, "Which codes?": { picked: ["429", "503"], other: "" } })).toEqual({
      ...input,
      answers: { "Where should retries live?": "In a wrapper", "Which codes?": "429, 503" },
    });
    expect(readQuestions({ questions: [{ nope: 1 }, "x"] })).toEqual([]);
    expect(readQuestions(null)).toEqual([]);
  });
});

describe("QuestionCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** Past the beat a pick shows for, and the fade of the question it leaves. */
  const moveOn = () => act(() => void vi.advanceTimersByTime(PICK_BEAT_MS + LEAVE_MS + 1));

  it("asks one question at a time: a pick moves on to the next, and the last answer sends them all", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item()} onDecide={onDecide} />);
    expect(screen.getByText("Claude has 2 questions")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.queryByText("Which codes?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /In fetchJson/ }));
    // The pick shows first, then the question fades to the next.
    expect(screen.getByRole("radio", { name: /In fetchJson/ })).toHaveAttribute("aria-checked", "true");
    moveOn();
    expect(screen.queryByText("Where should retries live?")).not.toBeInTheDocument();
    expect(screen.getByText("Which codes?")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    // Several can be picked here: nothing moves on until Send.
    const send = screen.getByRole("button", { name: "Send answers" });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /429/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /503/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /429/ }));
    moveOn();
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(send);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("q1", true, "Retries: In fetchJson (Recommended) · Codes: 503", {
      ...input,
      answers: { "Where should retries live?": "In fetchJson (Recommended)", "Which codes?": "503" },
    });
  });

  it("goes back to an earlier question with its answer kept, and on again to one already reached, from the arrows", () => {
    render(<QuestionCard item={item()} onDecide={() => {}} />);
    // A question not reached yet can't be skipped to, and there is none before the first.
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /In each caller/ }));
    moveOn();
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    moveOn();
    expect(screen.getByRole("radio", { name: /In each caller/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    moveOn();
    expect(screen.getByText("Which codes?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
  });

  it("numbers the options, and a number key picks one and moves on", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item()} onDecide={onDecide} />);
    expect(screen.getByRole("radio", { name: /In each caller/ })).toHaveTextContent(/^2/);
    expect(screen.getByText("Pick one, or press 1–2")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group", { name: "Claude's question" }), { key: "2" });
    expect(screen.getByRole("radio", { name: /In each caller/ })).toHaveAttribute("aria-checked", "true");
    moveOn();
    expect(screen.getByText("Which codes?")).toBeInTheDocument();
    // A number typed in your own words is only typed.
    const own = screen.getByLabelText(/Your own answer: Which codes/);
    fireEvent.keyDown(own, { key: "1" });
    expect(screen.getByRole("checkbox", { name: /429/ })).toHaveAttribute("aria-checked", "false");
  });

  it("docked where the message box is, takes number keys from the window, but not from a field elsewhere", () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <QuestionCard docked item={item({ input: { questions: [input.questions[0]] } })} onDecide={() => {}} />
      </>,
    );
    screen.getByLabelText("elsewhere").focus();
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("radio", { name: /In fetchJson/ })).toHaveAttribute("aria-checked", "false");
    screen.getByLabelText("elsewhere").blur();
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("radio", { name: /In fetchJson/ })).toHaveAttribute("aria-checked", "true");
  });

  it("in the chat's stream, is only a line pointing to where it waits while it is docked", () => {
    render(
      <DockedQuestion.Provider value="q1">
        <PermissionCard item={item()} onDecide={() => {}} />
      </DockedQuestion.Provider>,
    );
    expect(screen.getByRole("note")).toHaveTextContent("Claude is asking 2 questions below");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("sends a lone question's answer as soon as it is picked", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item({ input: { questions: [input.questions[0]] } })} onDecide={onDecide} />);
    expect(screen.getByText("Claude is asking")).toBeInTheDocument();
    expect(screen.queryByText(/of 1/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /In each caller/ }));
    expect(onDecide).not.toHaveBeenCalled();
    moveOn();
    expect(onDecide).toHaveBeenCalledWith("q1", true, "Retries: In each caller", expect.objectContaining({ answers: { "Where should retries live?": "In each caller" } }));
  });

  it("sends nothing of its own once it was answered elsewhere while a pick waited", () => {
    const onDecide = vi.fn();
    const one = { input: { questions: [input.questions[0]] } };
    const { rerender } = render(<QuestionCard item={item(one)} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("radio", { name: /In each caller/ }));
    rerender(<QuestionCard item={item({ ...one, decision: "allowed", note: "Retries: In fetchJson" })} onDecide={onDecide} />);
    moveOn();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("moves on from your own words with Enter", () => {
    render(<QuestionCard item={item()} onDecide={() => {}} />);
    const own = screen.getByLabelText(/Your own answer: Where/);
    fireEvent.change(own, { target: { value: "Behind a flag" } });
    fireEvent.keyDown(own, { key: "Enter" });
    moveOn();
    expect(screen.getByText("Which codes?")).toBeInTheDocument();
  });

  it("moves between the options with the arrow keys, and a radio group picks as it moves", () => {
    render(<QuestionCard item={item({ input: { questions: [input.questions[0]] } })} onDecide={() => {}} />);
    const first = screen.getByRole("radio", { name: /In fetchJson/ });
    const second = screen.getByRole("radio", { name: /In each caller/ });
    // One radio is in the tab order.
    expect(second).toHaveAttribute("tabindex", "-1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-checked", "true");
    expect(second).not.toHaveAttribute("tabindex");
    expect(first).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("aria-checked", "true");
  });

  it("doesn't move on or send when the arrow keys pick", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item({ input: { questions: [input.questions[0]] } })} onDecide={onDecide} />);
    const first = screen.getByRole("radio", { name: /In fetchJson/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    moveOn();
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onDecide.mock.lastCall![3].answers).toEqual({ "Where should retries live?": "In each caller" });
  });

  it("takes an answer in your own words instead", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item({ input: { questions: [input.questions[0]] } })} onDecide={onDecide} />);
    fireEvent.change(screen.getByLabelText(/Your own answer/), { target: { value: "Behind a flag" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onDecide.mock.lastCall![3].answers).toEqual({ "Where should retries live?": "Behind a flag" });
  });

  it("can be skipped, telling Claude to use its judgement, and folds to what was chosen", () => {
    const onDecide = vi.fn();
    const { rerender } = render(<QuestionCard item={item()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onDecide).toHaveBeenCalledWith("q1", false, expect.stringMatching(/chose not to answer/));
    rerender(<QuestionCard item={item({ decision: "allowed", note: "Retries: In each caller" })} onDecide={onDecide} />);
    expect(screen.getByText("✓ Answered")).toBeInTheDocument();
    expect(screen.getByText(/Retries: In each caller/)).toBeInTheDocument();
  });

  it("is the card an Antigravity chat's question gets too, naming Antigravity as the one asking", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item({ provider: "antigravity", input: { questions: [input.questions[0]] } })} onDecide={onDecide} />);
    expect(screen.getByText("Antigravity is asking")).toBeInTheDocument();
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /In each caller/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onDecide.mock.lastCall![3].answers).toEqual({ "Where should retries live?": "In each caller" });
  });
});
