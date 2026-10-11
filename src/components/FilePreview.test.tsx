import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import { clearStash, discard } from "../lib/editStash";
import FilePreview from "./FilePreview";

// Monaco as a textarea, handing over the one thing the component asks of it: a command bound to ⌘S.
const commands: Record<number, () => void> = {};
vi.mock("@monaco-editor/react", () => ({
  Editor: ({ value, onChange, onMount }: { value: string; onChange: (v: string) => void; onMount: (e: unknown, m: unknown) => void }) => {
    const editor = { addCommand: (key: number, run: () => void) => (commands[key] = run), revealLineInCenter: () => {}, createDecorationsCollection: () => ({ clear: () => {} }) };
    return (
      <textarea
        aria-label="editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        ref={(el) => {
          if (el && !el.dataset.mounted) {
            el.dataset.mounted = "1";
            onMount(editor, { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } });
          }
        }}
      />
    );
  },
}));
vi.mock("../monaco", () => ({ LIGHT_THEME: "l", DARK_THEME: "d" }));
vi.mock("../lib/editorFind", () => ({ registerFindable: () => {} }));
vi.mock("../api", () => ({ api: { readFile: vi.fn(), writeFile: vi.fn() } }));

const read = vi.mocked(api.readFile);
const write = vi.mocked(api.writeFile);
const type = (text: string) => fireEvent.change(screen.getByLabelText("editor"), { target: { value: text } });
const editor = () => screen.getByLabelText("editor") as HTMLTextAreaElement;

describe("FilePreview as an editor", () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue("one\n");
    write.mockReset().mockResolvedValue({ status: "saved", changed: true });
    for (const k of Object.keys(commands)) delete commands[Number(k)];
    clearStash();
  });

  it("shows the file, marks edits as unsaved, and saves them with what the file was when opened", async () => {
    const onSaved = vi.fn();
    const onDirty = vi.fn();
    render(<FilePreview path="/p/a.ts" onSaved={onSaved} onDirty={onDirty} />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    type("one\ntwo\n");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(write).toHaveBeenCalledWith("s1", "/p/a.ts", "one\ntwo\n", "one\n");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(onDirty).toHaveBeenLastCalledWith(false);
    // Edited again, it saves on top of what it just saved.
    type("three\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith("s1", "/p/a.ts", "three\n", "one\ntwo\n");
  });

  it("saves with ⌘S in the editor, and reverts edits", async () => {
    render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("changed\n");
    await act(async () => commands[2048 | 49]());
    expect(write).toHaveBeenCalledWith("s1", "/p/a.ts", "changed\n", "one\n");
    type("oops\n");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(editor().value).toBe("changed\n");
  });

  it("sends one save for a double ⌘S, and doesn't take its own save for a conflict", async () => {
    let finish: (r: { status: "saved"; changed: boolean }) => void = () => {};
    write.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("two\n");
    await act(async () => {
      commands[2048 | 49]();
      commands[2048 | 49]();
    });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "saved", changed: true }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // After it, saving works again.
    type("three\n");
    await act(async () => commands[2048 | 49]());
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("offers your version or the one on disk when a save finds the file changed", async () => {
    write.mockResolvedValueOnce({ status: "conflict", current: "claude's\n" });
    render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("mine\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This file changed on disk while you were editing it.")).toBeInTheDocument();
    // Keeping yours overwrites, expecting the file as it is now.
    fireEvent.click(screen.getByRole("button", { name: "Keep my version" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(write).toHaveBeenLastCalledWith("s1", "/p/a.ts", "mine\n", "claude's\n");
    expect(editor().value).toBe("mine\n");
  });

  it("can take the file on disk instead", async () => {
    write.mockResolvedValueOnce({ status: "conflict", current: "claude's\n" });
    render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("mine\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use the file on disk" }));
    expect(editor().value).toBe("claude's\n");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("follows the disk while there are no edits, and warns at once when there are", async () => {
    const { rerender } = render(<FilePreview path="/p/a.ts" refreshKey={0} />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    read.mockResolvedValue("claude edited\n");
    rerender(<FilePreview path="/p/a.ts" refreshKey={1} />);
    await waitFor(() => expect(editor().value).toBe("claude edited\n"));
    expect(screen.queryByRole("alert")).toBeNull();
    // With edits in, a later change on disk is a conflict, and the edits stay.
    type("claude edited\nmine\n");
    read.mockResolvedValue("claude edited again\n");
    rerender(<FilePreview path="/p/a.ts" refreshKey={2} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk");
    expect(editor().value).toBe("claude edited\nmine\n");
  });

  it("says when the file was deleted under your edits, and can recreate it", async () => {
    const { rerender } = render(<FilePreview path="/p/a.ts" refreshKey={0} />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("mine\n");
    read.mockRejectedValue("No such file");
    rerender(<FilePreview path="/p/a.ts" refreshKey={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("deleted");
    fireEvent.click(screen.getByRole("button", { name: "Keep my version" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("s1", "/p/a.ts", "mine\n", null));
  });

  it("keeps unsaved edits when the editor closes and brings them back, unless they were discarded", async () => {
    const first = render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("kept\n");
    first.unmount();
    const again = render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(editor().value).toBe("kept\n"));
    expect(screen.getByText("Your unsaved edits are back")).toBeInTheDocument();
    // The file changed while they were away: that's a conflict, not a silent overwrite.
    type("kept\nmore\n");
    again.unmount();
    read.mockResolvedValue("new on disk\n");
    render(<FilePreview path="/p/a.ts" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk");
    expect(editor().value).toBe("kept\nmore\n");
  });

  it("forgets edits that were discarded", async () => {
    const first = render(<FilePreview path="/p/b.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    type("thrown away\n");
    discard("s1:/p/b.ts");
    first.unmount();
    render(<FilePreview path="/p/b.ts" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    expect(screen.queryByText("Your unsaved edits are back")).toBeNull();
  });

  it("shows the error for a file that can't be opened", async () => {
    read.mockRejectedValue("This file is binary and can't be opened.");
    render(<FilePreview path="/p/a.png" />);
    expect(await screen.findByText("This file is binary and can't be opened.")).toBeInTheDocument();
  });
});
