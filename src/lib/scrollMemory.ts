/**
 * Where each scrolled view was left, so switching chats (or opening one from a toast) brings you back to the same
 * place instead of the top. Keyed by chat and view (a step page's key, or the chat's whole stream); kept while the app
 * runs.
 */
const kept = new Map<string, unknown>();

/** `place`: a scroll offset, or what a view keeps instead (the chat keeps a ChatAnchor, see scrollAnchor). */
export const rememberScroll = <T = number,>(key: string, place: T) => kept.set(key, place);
export const recallScroll = <T = number,>(key: string): T | undefined => kept.get(key) as T | undefined;
