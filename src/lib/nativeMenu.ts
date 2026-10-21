/** Where the system's own menu (Copy, Paste, spelling) is of use: in a text field, or over text that is selected. */
function wantsNativeMenu(target: EventTarget | null, doc: Document): boolean {
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  return !!doc.getSelection()?.toString();
}

/**
 * The webview's own right-click menu (Reload, Back, and Inspect Element in a dev build) means nothing in an app: held back
 * everywhere, except where Copy and Paste are wanted and where a component has its own menu (it has already prevented the default).
 * Returns the way to undo it.
 */
export function holdBackBrowserMenu(doc: Document = document): () => void {
  const onMenu = (e: MouseEvent) => {
    if (!e.defaultPrevented && !wantsNativeMenu(e.target, doc)) e.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  return () => doc.removeEventListener("contextmenu", onMenu);
}
