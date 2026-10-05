/**
 * Where each scrolled view was left, so switching chats (or opening one from a toast) brings you back to the same
 * place instead of the top. Keyed by chat and view (a step page's key, or the chat's whole stream); kept while the app
 * runs.
 */
const kept = new Map<string, number>();

export const rememberScroll = (key: string, top: number) => kept.set(key, top);
export const recallScroll = (key: string): number | undefined => kept.get(key);
