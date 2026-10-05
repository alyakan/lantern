/**
 * ⌘F in the right pane: Monaco's find bar for the file on screen (a diff's new side, a created file, a file
 * preview), wherever the focus is. Editors register as they mount; the one shown last wins.
 */

interface Findable {
  focus(): void;
  getDomNode(): HTMLElement | null;
  getAction(id: string): { run(): Promise<void> | void } | null;
  onDidDispose(listener: () => void): unknown;
}

const editors: Findable[] = [];

export function registerFindable(editor: Findable): void {
  editors.push(editor);
  editor.onDidDispose(() => {
    const i = editors.indexOf(editor);
    if (i >= 0) editors.splice(i, 1);
  });
}

/** Opens the find bar on the newest editor that's on screen; false when there's none. */
export function openFind(): boolean {
  const shown = editors.filter((e) => {
    const node = e.getDomNode();
    return !!node && node.offsetParent !== null && node.getClientRects().length > 0;
  });
  const editor = shown[shown.length - 1];
  if (!editor) return false;
  editor.focus();
  void editor.getAction("actions.find")?.run();
  return true;
}
