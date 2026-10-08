import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "./MessageInput";

describe("MessageInput", () => {
  it("shows a ready update under the box, even with no mode or branch to show", () => {
    render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} update={{ version: "0.1.2", busy: 0, onRestart: () => {}, onLater: () => {} }} />);
    expect(screen.getByRole("button", { name: /Update ready/ })).toBeInTheDocument();
  });

  it("sends trimmed text on Enter and clears", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "  fix it  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("fix it");
    expect(box).toHaveValue("");
  });

  it("sends what you typed on Enter while a grey prediction shows, but lets an input method confirm", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    // A prediction: a composition with no input-method keys (keyCode 229) before it, its text marked in the box.
    fireEvent.keyDown(box, { key: "y", keyCode: 89 });
    fireEvent.change(box, { target: { value: "add a retry" } });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "add a retry loop" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onSend).toHaveBeenCalledWith("add a retry");
    fireEvent.compositionEnd(box);
    // Japanese input: its keys arrive as 229, and Enter confirms the characters instead of sending.
    fireEvent.keyDown(box, { key: "Process", keyCode: 229 });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("にほん");
  });

  const type = (box: HTMLElement, value: string) => {
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  it("queues messages while running instead of sending them", () => {
    const onSend = vi.fn();
    render(<MessageInput status="running" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Queue a message…");
    type(box, " then add tests ");
    type(box, "and update the docs");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("");
    expect(screen.getByText("then add tests")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[1]);
    expect(screen.queryByText("and update the docs")).toBeNull();
  });

  it("uses the chat's queue when given one", () => {
    const set = vi.fn();
    render(<MessageInput status="running" onSend={() => {}} onStop={() => {}} queue={{ items: ["first"], set }} />);
    expect(screen.getByText("first")).toBeInTheDocument();
    type(screen.getByPlaceholderText("Queue a message…"), "second");
    expect(set).toHaveBeenCalledWith(["first", "second"]);
  });

  it("puts the queue back into the box on Stop instead of sending it", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(<MessageInput status="running" onSend={onSend} onStop={onStop} />);
    const box = screen.getByPlaceholderText("Queue a message…");
    type(box, "first");
    fireEvent.change(box, { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(box).toHaveValue("first\n\nhalf-typed");
    rerender(<MessageInput status="idle" onSend={onSend} onStop={onStop} />);
    expect(onSend).not.toHaveBeenCalled();
  });

  const commands = [
    { name: "compact", description: "Clear history but keep a summary", argument_hint: "<instructions>" },
    { name: "context", description: "Show context usage", argument_hint: "" },
    { name: "clear", description: "Clear conversation history", argument_hint: "" },
  ];

  it("offers slash commands as you type, and runs one with Enter", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} commands={commands} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "/c" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "/clearClear conversation historyBuilt-in",
      "/compact<instructions>Clear history but keep a summaryBuilt-in",
      "/contextShow context usageBuilt-in",
    ]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/context");
    expect(box).toHaveValue("");
  });

  describe("anywhere in the message", () => {
    const withSkills = [...commands, { name: "grill-me", description: "Interview the user (user)", argument_hint: "" }, { name: "mcp__github__review", description: "Review a PR (MCP)", argument_hint: "" }];
    const index = [{ name: "grill-me", kind: "skill" as const, source: "user" as const, plugin: null, path: "/h/SKILL.md", description: "Interview the user" }];
    const type = (box: HTMLElement, value: string) => {
      fireEvent.change(box, { target: { value, selectionStart: value.length } });
    };

    it("sorts the menu into sections, and mid-message offers skills and MCP prompts but not commands", () => {
      render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} commands={withSkills} skillIndex={index} />);
      const box = screen.getByPlaceholderText("Ask Claude…");
      type(box, "/");
      const menu = screen.getByRole("listbox", { name: "Commands" });
      expect(menu).toHaveTextContent("Skills");
      expect(menu).toHaveTextContent("Commands");
      expect(menu).toHaveTextContent("MCP prompts");
      type(box, "plan this, then /");
      const names = screen.getAllByRole("option").map((o) => o.querySelector(".slash-name")?.textContent);
      expect(names).toEqual(["/grill-me", "/mcp__github__review"]);
    });

    it("puts a picked skill where the / was, and the caret after it", () => {
      const onSend = vi.fn();
      render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} commands={withSkills} skillIndex={index} />);
      const box = screen.getByPlaceholderText("Ask Claude…") as HTMLTextAreaElement;
      type(box, "design the cache, /gri");
      fireEvent.keyDown(box, { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(box).toHaveValue("design the cache, /grill-me ");
      expect(box.selectionStart).toBe("design the cache, /grill-me ".length);
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("isn't fooled by paths", () => {
      render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} commands={withSkills} />);
      const box = screen.getByPlaceholderText("Ask Claude…");
      type(box, "look at src/c");
      expect(screen.queryByRole("listbox")).toBeNull();
      type(box, "/Users/c");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("warns about MCP servers that need you, linking to Settings", () => {
      const onOpenSettings = vi.fn();
      render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} commands={withSkills} mcpIssues={[{ name: "sentry", problem: "needs you to log in" }]} onOpenSettings={onOpenSettings} />);
      type(screen.getByPlaceholderText("Ask Claude…"), "/");
      fireEvent.click(screen.getByRole("button", { name: /sentry needs you to log in/ }));
      expect(onOpenSettings).toHaveBeenCalled();
    });

    it("offers files after @ and puts the picked one in", async () => {
      const findFiles = vi.fn().mockResolvedValue([{ path: "/p/src/net/fetchJson.ts", rel: "src/net/fetchJson.ts", hits: [] }]);
      render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} findFiles={findFiles} />);
      const box = screen.getByPlaceholderText("Ask Claude…");
      type(box, "why does @fetch");
      const option = await screen.findByRole("option", { name: "@src/net/fetchJson.ts" });
      expect(findFiles).toHaveBeenCalledWith("fetch");
      fireEvent.click(option.querySelector("button")!);
      expect(box).toHaveValue("why does @src/net/fetchJson.ts ");
    });
  });

  it("completes a command that takes arguments instead of running it, and Escape hides the menu", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} commands={commands} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "/comp" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("/compact ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();

    fireEvent.change(box, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    // With the menu hidden, Enter sends what's typed.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/");
  });

  it("starts from the chat's unsent text and saves what's typed", () => {
    const save = vi.fn();
    render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} draft={{ initial: "half a thought", save }} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    expect(box).toHaveValue("half a thought");
    fireEvent.change(box, { target: { value: "half a thought, finished" } });
    expect(save).toHaveBeenLastCalledWith("half a thought, finished");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(save).toHaveBeenLastCalledWith("");
  });

  it("focuses on ⌘L and stops on ⌘. while running", () => {
    const onStop = vi.fn();
    const { rerender } = render(<MessageInput status="idle" onSend={() => {}} onStop={onStop} />);
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(screen.getByPlaceholderText("Ask Claude…")).toHaveFocus();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).not.toHaveBeenCalled();
    rerender(<MessageInput status="running" onSend={() => {}} onStop={onStop} />);
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("is disabled while starting", () => {
    render(<MessageInput status="starting" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByPlaceholderText("Starting Claude…")).toBeDisabled();
  });

  it("on a Step-by-step page, Enter stays on the step and ⌘Enter sends and moves on", () => {
    const onSend = vi.fn();
    const sendAndNext = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} sendAndNext={sendAndNext} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "why a Set?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("why a Set?");
    fireEvent.change(box, { target: { value: "rename it" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(sendAndNext).toHaveBeenCalledWith("rename it");
    fireEvent.change(box, { target: { value: "and this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send & next" }));
    expect(sendAndNext).toHaveBeenLastCalledWith("and this");
  });
  describe("terminal mode", () => {
    it("turns on with \"!\", runs the command on Enter (even while Claude works) and leaves on Backspace", () => {
      const onRun = vi.fn();
      const onSend = vi.fn();
      const { container } = render(<MessageInput status="running" onSend={onSend} onStop={() => {}} onRun={onRun} folder="/Users/you/app" />);
      const box = screen.getByPlaceholderText("Queue a message…");
      fireEvent.change(box, { target: { value: "!" } });
      expect(container.querySelector(".composer-box")).toHaveClass("terminal");
      expect(box).toHaveValue("");
      expect(box).toHaveAttribute("placeholder", "Run a command in app…");
      fireEvent.change(box, { target: { value: " git status " } });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(onRun).toHaveBeenCalledWith("git status");
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Queued messages")).not.toBeInTheDocument();
      // Ran: the box is empty and back to normal.
      expect(container.querySelector(".composer-box")).not.toHaveClass("terminal");

      fireEvent.change(box, { target: { value: "!" } });
      fireEvent.keyDown(box, { key: "Backspace" });
      expect(container.querySelector(".composer-box")).not.toHaveClass("terminal");
      expect(box).toHaveValue("");
    });

    it("pasting \"!command\" starts it with the command in the box", () => {
      const onRun = vi.fn();
      render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} onRun={onRun} />);
      const box = screen.getByPlaceholderText("Ask Claude…");
      fireEvent.change(box, { target: { value: "!ls -la" } });
      expect(box).toHaveValue("ls -la");
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(onRun).toHaveBeenCalledWith("ls -la");
    });

    it("is a plain \"!\" without a way to run commands", () => {
      const onSend = vi.fn();
      const { container } = render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} />);
      const box = screen.getByPlaceholderText("Ask Claude…");
      fireEvent.change(box, { target: { value: "!important" } });
      expect(container.querySelector(".composer-box")).not.toHaveClass("terminal");
      fireEvent.keyDown(box, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("!important");
    });
  });
});
