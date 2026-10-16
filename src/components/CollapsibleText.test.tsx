import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleText } from "./CollapsibleText";

// jsdom has no layout: the box is as tall as its content is told to be.
let content = 20;
let shown = 60;
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => content });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => shown });

describe("CollapsibleText", () => {
  afterEach(() => {
    content = 20;
    shown = 60;
  });

  it("shows a short message as it is, with nothing to expand", () => {
    const { container } = render(<CollapsibleText>hello</CollapsibleText>);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".collapsible")).toHaveClass("clamped");
  });

  it("clamps a message that is taller than its three lines, and Show more and Show less open and close it", () => {
    content = 300;
    const { container } = render(<CollapsibleText>{"line\n".repeat(30)}</CollapsibleText>);
    const body = container.querySelector(".collapsible")!;
    expect(body).toHaveClass("clamped");
    expect(body).toHaveStyle("--clamp-lines: 3");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(body).not.toHaveClass("clamped");
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(body).toHaveClass("clamped");
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
  });

  it("is one element, so a message that is a row (the terminal themes' > mark, then the text) doesn't put Show more in a column of its own", () => {
    content = 300;
    const { container } = render(<CollapsibleText>{"line\n".repeat(30)}</CollapsibleText>);
    expect(container.children).toHaveLength(1);
    const wrap = container.firstElementChild!;
    expect(wrap).toHaveClass("collapsible-wrap");
    expect(wrap.querySelector(".collapsible")).not.toBeNull();
    expect(wrap).toContainElement(screen.getByRole("button", { name: "Show more" }));
  });
});
