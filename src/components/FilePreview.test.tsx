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
const addProjectLibs = vi.fn();
vi.mock("../monaco", () => ({ LIGHT_THEME: "l", DARK_THEME: "d", addProjectLibs: (...a: unknown[]) => addProjectLibs(...a) }));
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
    addProjectLibs.mockReset().mockReturnValue(() => {});
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
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
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

  it("gives the TypeScript service the files a script imports, and takes them back when it closes", async () => {
    const dispose = vi.fn();
    addProjectLibs.mockReturnValue(dispose);
    const files: Record<string, string> = { "/p/a.ts": 'import { b } from "./b";\n', "/p/b.ts": "export const b = 1;\n" };
    read.mockImplementation(async (_slot, path) => files[path] ?? Promise.reject("missing"));
    const view = render(<FilePreview path="/p/a.ts" />);
    await waitFor(() => expect(addProjectLibs).toHaveBeenCalledWith("typescript", [{ path: "/p/b.ts", text: "export const b = 1;\n" }]));
    expect(dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(dispose).toHaveBeenCalled();
  });

  it("doesn't go looking for imports in a file the language service doesn't cover", async () => {
    render(<FilePreview path="/p/notes.txt" />);
    await waitFor(() => expect(editor().value).toBe("one\n"));
    expect(addProjectLibs).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shows the error for a file that can't be opened", async () => {
    read.mockRejectedValue("This file is binary and can't be opened.");
    render(<FilePreview path="/p/a.png" />);
    expect(await screen.findByText("This file is binary and can't be opened.")).toBeInTheDocument();
  });

  describe("a markdown file", () => {
    beforeEach(() => localStorage.clear());
    const preview = () => screen.getByLabelText("Markdown preview");

    it("opens as a styled document, and Edit switches to the editor with the same text", async () => {
      read.mockResolvedValue("# Title\n\nSome **bold** text\n");
      render(<FilePreview path="/p/notes.md" />);
      expect(await screen.findByRole("heading", { name: "Title" })).toBeInTheDocument();
      expect(preview()).toHaveTextContent("Some bold text");
      expect(screen.queryByLabelText("editor")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      expect(editor().value).toBe("# Title\n\nSome **bold** text\n");
      expect(screen.queryByLabelText("Markdown preview")).not.toBeInTheDocument();
    });

    it("shows unsaved edits in the preview, and remembers the view you chose", async () => {
      read.mockResolvedValue("# One\n");
      const first = render(<FilePreview path="/p/notes.md" />);
      await screen.findByRole("heading", { name: "One" });
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      type("# Two\n");
      fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
      expect(screen.getByRole("heading", { name: "Two" })).toBeInTheDocument();
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      first.unmount();
      render(<FilePreview path="/p/other.md" />);
      expect(await screen.findByLabelText("editor")).toBeInTheDocument();
    });

    it("shows the editor for a line to show, and has no switch on other files", async () => {
      read.mockResolvedValue("# One\n");
      const view = render(<FilePreview path="/p/notes.md" line={1} />);
      expect(await screen.findByLabelText("editor")).toBeInTheDocument();
      view.unmount();
      render(<FilePreview path="/p/a.ts" />);
      await screen.findByLabelText("editor");
      expect(screen.queryByRole("tab", { name: "Preview" })).not.toBeInTheDocument();
    });

    it("shows front matter as code instead of a rule and a heading", async () => {
      read.mockResolvedValue("---\nname: demo\n---\n\nBody\n");
      render(<FilePreview path="/p/SKILL.md" />);
      await screen.findByText("Body");
      expect(preview()).toHaveTextContent("name: demo");
      expect(preview().querySelector("hr")).toBeNull();
    });
  });
});
