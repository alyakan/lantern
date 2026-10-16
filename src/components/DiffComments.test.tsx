import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CommentControls, DiffComment } from "../lib/diffComments";
import { CommentBox, CommentNote, OutdatedNotes } from "./DiffComments";

const comment = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "/p/src/a.ts", side: "new", line: 4, lineText: "const a = 1;", kind: "added", text: "Why 1?", ...over });

describe("CommentBox", () => {
  const box = (over: Partial<Parameters<typeof CommentBox>[0]> = {}) => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<CommentBox label="Comment on line 4 of a.ts" onSave={onSave} onCancel={onCancel} {...over} />);
    return { onSave, onCancel, field: screen.getByRole("textbox", { name: "Comment on line 4 of a.ts" }) };
  };

  it("is a labelled field that takes focus", async () => {
    const { field } = box();
    await vi.waitFor(() => expect(field).toHaveFocus());
  });

  it("Enter adds the comment, trimmed", () => {
    const { field, onSave } = box();
    fireEvent.change(field, { target: { value: "  Why 1?  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("Why 1?");
  });

  it("Shift+Enter starts a new line instead of adding", () => {
    const { field, onSave } = box();
    fireEvent.change(field, { target: { value: "One" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("adds nothing while it is empty", () => {
    const { field, onSave } = box();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });

  it("Escape cancels", () => {
    const { field, onCancel, onSave } = box();
    fireEvent.change(field, { target: { value: "Half" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Add comment and Cancel work with the pointer too", () => {
    const { field, onSave, onCancel } = box();
    fireEvent.change(field, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(onSave).toHaveBeenCalledWith("Hi");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("CommentNote", () => {
  it("shows the line and the comment, with Edit and Delete named for the line and file", () => {
    render(<CommentNote comment={comment()} where="a.ts" onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByRole("group", { name: "Comment on line 4 of a.ts" })).toHaveTextContent("Why 1?");
    expect(screen.getByRole("button", { name: "Edit comment on line 4 of a.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete comment on line 4 of a.ts" })).toBeInTheDocument();
  });

  it("Delete removes it", () => {
    const onDelete = vi.fn();
    render(<CommentNote comment={comment()} where="a.ts" onEdit={() => {}} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete comment/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("Edit opens the box with the comment in it; saving changes it, Escape keeps it", () => {
    const onEdit = vi.fn();
    render(<CommentNote comment={comment()} where="a.ts" onEdit={onEdit} onDelete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Edit comment/ }));
    const field = screen.getByRole("textbox", { name: "Edit your comment on line 4 of a.ts" });
    expect(field).toHaveValue("Why 1?");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toHaveTextContent("Why 1?");
    fireEvent.click(screen.getByRole("button", { name: /^Edit comment/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Why not 2?" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith("Why not 2?");
  });

  it("names a removed line as before, and says an outdated comment is", () => {
    render(<CommentNote comment={comment({ side: "old", line: 9, outdated: true })} where="a.ts" onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByRole("group", { name: "Comment on line 9 before of a.ts" })).toBeInTheDocument();
    expect(screen.getByText("Outdated")).toBeInTheDocument();
  });
});

describe("OutdatedNotes", () => {
  const controls = (items: DiffComment[]): CommentControls => ({ items, update: vi.fn(), send: vi.fn() });

  it("lists this file's outdated comments with the line they were on, and nothing else", () => {
    render(<OutdatedNotes path="/p/src/a.ts" comments={controls([comment({ outdated: true }), comment({ id: "c2" }), comment({ id: "c3", path: "/p/src/b.ts", outdated: true, text: "Other file" })])} />);
    const list = screen.getByRole("region", { name: "Comments on lines that changed" });
    expect(list).toHaveTextContent("This line has changed since you commented on it");
    expect(list).toHaveTextContent("const a = 1;");
    expect(list).toHaveTextContent("Why 1?");
    expect(list).not.toHaveTextContent("Other file");
  });

  it("is absent when no comment on the file is outdated", () => {
    const { container } = render(<OutdatedNotes path="/p/src/a.ts" comments={controls([comment()])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("deletes one from the list", () => {
    const comments = controls([comment({ outdated: true })]);
    render(<OutdatedNotes path="/p/src/a.ts" comments={comments} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete comment/ }));
    expect(vi.mocked(comments.update).mock.calls[0][0](comments.items)).toEqual([]);
  });
});
