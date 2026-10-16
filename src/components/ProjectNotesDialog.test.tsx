import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProjectNotesDialog } from "./ProjectNotesDialog";
import { PROJECT_NOTES_MAX } from "../lib/projectNotes";

const setup = (notes = "") => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<ProjectNotesDialog project="acme-api" notes={notes} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose, box: screen.getByRole("textbox", { name: "Project notes" }) as HTMLTextAreaElement };
};

describe("the project notes dialog", () => {
  it("says what the notes are for, that they aren't in the files, and that a running chat isn't changed", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Project notes: acme-api" })).toBeInTheDocument();
    expect(screen.getByText("Every new chat in this project starts knowing this. It isn't saved in your files.")).toBeInTheDocument();
    expect(screen.getByText("Applies to chats started after saving.")).toBeInTheDocument();
  });

  it("opens with the saved notes in the box, and focus there", () => {
    const { box } = setup("Always use pnpm.");
    expect(box).toHaveValue("Always use pnpm.");
    expect(box).toHaveFocus();
    // Nothing to save until something changes.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("counts the characters against the limit, and the box stops at it", () => {
    const { box } = setup();
    expect(screen.getByText(`0 / ${PROJECT_NOTES_MAX}`)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "hello" } });
    expect(screen.getByText(`5 / ${PROJECT_NOTES_MAX}`)).toBeInTheDocument();
    expect(box).toHaveAttribute("maxlength", String(PROJECT_NOTES_MAX));
  });

  it("saves what was typed and closes", () => {
    const { onSave, onClose, box } = setup();
    fireEvent.change(box, { target: { value: "The API is in /server.\nNever touch /legacy." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("The API is in /server.\nNever touch /legacy.");
    expect(onClose).toHaveBeenCalled();
  });

  it("saves with ⌘↩ too", () => {
    const { onSave, box } = setup();
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onSave).toHaveBeenCalledWith("x");
  });

  it("Cancel and Escape close it and save nothing", () => {
    const { onSave, onClose, box } = setup("old");
    fireEvent.change(box, { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Clear empties the box and keeps the notes until Save, which then saves nothing in their place", () => {
    const { onSave, box } = setup("Always use pnpm.");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("");
  });
});
