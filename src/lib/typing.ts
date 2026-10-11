/**
 * Whether keystrokes are going into something you type in, so single-key shortcuts (J/K between files) must leave
 * them alone: a field, or the file editor. Monaco's read-only diff has a textarea too, which isn't typing.
 */
export const isTyping = (el: Element | null): boolean => {
  if (!el) return false;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || !!(el as HTMLElement).isContentEditable;
  return field && (!el.closest(".monaco-editor") || !!el.closest(".editable-editor"));
};
