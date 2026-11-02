/**
 * Where a Step by step chat was being read: the page on screen, and how far down each page was scrolled. A chat opened again
 * opens there, not at the top of its newest page. Kept in memory while the app runs (a chat is made again each time it is
 * opened), never on the phone: it is only a reading place.
 */

export interface StepPlace {
  /** The key of the page on screen (`StepPage.key`, the same as the page grows). */
  page: string;
  /** How many pages there were then: more now says a new one came while away. */
  of: number;
  /** How far down each page was scrolled, by its key. */
  offsets: Record<string, number>;
}

const places = new Map<string, StepPlace>();

export const placeOf = (slot: string): StepPlace | undefined => places.get(slot);

/** The page on screen now, and how many there are. */
export function keepPage(slot: string, page: string, of: number) {
  const held = places.get(slot);
  places.set(slot, { page, of, offsets: held?.offsets ?? {} });
}

/** How far down a page is scrolled. */
export function keepOffset(slot: string, page: string, y: number) {
  const held = places.get(slot);
  if (held) held.offsets[page] = y;
  else places.set(slot, { page, of: 0, offsets: { [page]: y } });
}

/** For tests, and a phone unpaired from its Mac: forget every place. */
export function forgetPlaces() {
  places.clear();
}
