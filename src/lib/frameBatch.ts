/**
 * Collects items and hands them over together, in the order they came, once per frame: however many events a busy chat (or
 * seven of them) sends in a frame, the app draws once. A timer backs the frame up, because a window that is hidden or in
 * the background gets no animation frames, and what its chats are doing mustn't wait for it to come back.
 */
export function batchPerFrame<T>(flush: (items: T[]) => void, fallbackMs = 50) {
  let queue: T[] = [];
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
    const items = queue;
    queue = [];
    if (items.length > 0) flush(items);
  };
  return {
    push(item: T) {
      queue.push(item);
      if (frame === 0 && timer === undefined) {
        frame = requestAnimationFrame(run);
        timer = setTimeout(run, fallbackMs);
      }
    },
    /** Hands over what is waiting now. */
    flush: run,
  };
}
