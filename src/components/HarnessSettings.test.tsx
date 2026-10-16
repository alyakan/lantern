import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BUILT_IN } from "../lib/harness";
import { HarnessSettings } from "./HarnessSettings";

describe("HarnessSettings", () => {
  const props = { saved: BUILT_IN.slice(1), folder: "/p/acme", folderDefault: "default", onFolderDefault: vi.fn(), fallbackModel: null };

  it("edits a preset, keeping its advisor one Claude Code accepts", () => {
    const onSave = vi.fn();
    render(<HarnessSettings {...props} onSave={onSave} />);
    fireEvent.click(within(screen.getByRole("list", { name: "Model presets" })).getByText("Thrifty"));
    // Haiku main: Haiku can advise it.
    expect(within(screen.getByLabelText("Advisor")).getByRole("option", { name: "Haiku" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Advisor"), { target: { value: "haiku" } });
    expect(onSave).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: "thrifty", advisor: "haiku" })]));
  });

  it("drops an advisor the new main model can't take", () => {
    const onSave = vi.fn();
    render(<HarnessSettings {...props} saved={[{ ...BUILT_IN[2], advisor: "haiku" }]} onSave={onSave} />);
    fireEvent.click(within(screen.getByRole("list", { name: "Model presets" })).getByText("Thrifty"));
    fireEvent.change(screen.getByLabelText("Main model"), { target: { value: "opus" } });
    expect(onSave).toHaveBeenLastCalledWith([expect.objectContaining({ model: "opus", advisor: null })]);
  });

  it("sets the folder's default, adds presets and notes Fable", () => {
    const onSave = vi.fn();
    render(<HarnessSettings {...props} onSave={onSave} />);
    fireEvent.change(screen.getByRole("combobox", { name: /New chats in acme start with/ }), { target: { value: "max" } });
    expect(props.onFolderDefault).toHaveBeenCalledWith("max");
    fireEvent.click(within(screen.getByRole("list", { name: "Model presets" })).getByText("Max"));
    expect(screen.getByText(/run \/model fable in Claude Code/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    expect(onSave.mock.lastCall![0]).toHaveLength(4);
  });
});
