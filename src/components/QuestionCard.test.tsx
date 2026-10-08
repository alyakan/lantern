import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuestionCard } from "./QuestionCard";
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
  it("sends the chosen options once every question has an answer", () => {
    const onDecide = vi.fn();
    render(<QuestionCard item={item()} onDecide={onDecide} />);
    expect(screen.getByText("Claude has 2 questions")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send answers" });
    fireEvent.click(screen.getByRole("radio", { name: /In fetchJson/ }));
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /429/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /503/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /429/ }));
    fireEvent.click(send);
    expect(onDecide).toHaveBeenCalledWith("q1", true, "Retries: In fetchJson (Recommended) · Codes: 503", {
      ...input,
      answers: { "Where should retries live?": "In fetchJson (Recommended)", "Which codes?": "503" },
    });
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
});
