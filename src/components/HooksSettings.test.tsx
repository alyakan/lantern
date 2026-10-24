import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HooksSettings } from "./HooksSettings";
import { NO_HOOKS, type HookTable } from "../lib/chatHooks";

afterEach(cleanup);

function open(table: HookTable = NO_HOOKS, folders = ["/Users/me/lantern", "/Users/me/other"]) {
  const onChange = vi.fn();
  render(<HooksSettings folders={folders} table={table} onChange={onChange} />);
  return onChange;
}

describe("Settings → Hooks", () => {
  it("has the two hooks for every project, off and empty until the user writes them", () => {
    open();
    expect(screen.getByRole("checkbox", { name: /Before: before a chat's first message/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /After: after Claude answers/ })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Before hook, everywhere" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "After hook, everywhere" })).toHaveAttribute("placeholder", "Update the brain if needed.");
  });

  it("says when each one runs, including that the post-hook is not sent after a failed turn or in Step by step", () => {
    open();
    expect(screen.getByText(/first one after the chat is compacted/)).toBeInTheDocument();
    expect(screen.getByText(/isn't sent after a turn that failed or was stopped, after a slash command, or in Step by step/)).toBeInTheDocument();
  });

  it("switches a hook on and changes its words, keeping the rest", () => {
    const onChange = open({ ...NO_HOOKS, post: { text: "save", on: false } });
    fireEvent.click(screen.getByRole("checkbox", { name: /After: after Claude answers/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_HOOKS, post: { text: "save", on: true } });
    fireEvent.change(screen.getByRole("textbox", { name: "Before hook, everywhere" }), { target: { value: "Check the brain." } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_HOOKS, pre: { text: "Check the brain.", on: false }, post: { text: "save", on: false } });
  });

  it("lists each project with its own choice for each hook, starting on the same as everywhere", () => {
    open();
    const pre = screen.getByRole("combobox", { name: "Before hook in lantern" }) as HTMLSelectElement;
    expect(pre.value).toBe("workspace");
    expect([...pre.options].map((o) => o.textContent)).toEqual(["Same as everywhere", "Its own", "None"]);
    expect(screen.queryByRole("textbox", { name: "Before hook for lantern" })).toBeNull();
  });

  it("gives a project its own words, and none when it says none", () => {
    const onChange = open();
    fireEvent.change(screen.getByRole("combobox", { name: "Before hook in lantern" }), { target: { value: "custom" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_HOOKS, projects: { "/Users/me/lantern": { pre: { text: "", on: true } } } });
    fireEvent.change(screen.getByRole("combobox", { name: "After hook in other" }), { target: { value: "off" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_HOOKS, projects: { "/Users/me/other": { post: { text: "", on: false } } } });
  });

  it("shows a project's own box, and edits only that project's", () => {
    const table: HookTable = { ...NO_HOOKS, projects: { "/Users/me/lantern": { pre: { text: "read NOTES.md", on: true } }, "/Users/me/other": { pre: { text: "other's", on: true } } } };
    const onChange = open(table);
    const box = screen.getByRole("textbox", { name: "Before hook for lantern" });
    expect(box).toHaveValue("read NOTES.md");
    fireEvent.change(box, { target: { value: "read the README" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_HOOKS, projects: { ...table.projects, "/Users/me/lantern": { pre: { text: "read the README", on: true } } } });
  });

  it("says so when there are no projects", () => {
    open(NO_HOOKS, []);
    expect(screen.getByText("No projects yet.")).toBeInTheDocument();
  });
});
