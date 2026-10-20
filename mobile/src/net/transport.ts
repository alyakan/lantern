/**
 * What carries frames to and from the Mac (the Mac's transport.rs): a WebSocket on the Wi-Fi now, a relay later. A
 * transport only moves frames the secure channel sealed; it can't read them.
 */

/** One connection: frames out, the next frame in (null: closed, or nothing within the wait). */
export interface Link {
  send(frame: Uint8Array): void;
  next(waitMs?: number): Promise<Uint8Array | null>;
  close(): void;
  /** Resolves once the connection is gone, from either side. */
  readonly closed: Promise<void>;
}

export interface Transport {
  open(host: string, port: number, waitMs: number): Promise<Link>;
}

/** A Link fed by `push`, ended by `end` (what each transport, and the tests' fakes, build theirs from). */
export function queueLink(send: (frame: Uint8Array) => void, close: () => void) {
  const queue: Uint8Array[] = [];
  const waiting: ((f: Uint8Array | null) => void)[] = [];
  let ended = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const end = () => {
    if (ended) return;
    ended = true;
    for (const w of waiting.splice(0)) w(null);
    resolveClosed();
  };
  const link: Link = {
    send: (frame) => {
      if (!ended) send(frame);
    },
    next: (waitMs) => {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = waitMs === undefined ? null : setTimeout(() => {
          const i = waiting.indexOf(take);
          if (i >= 0) waiting.splice(i, 1);
          resolve(null);
        }, waitMs);
        const take = (f: Uint8Array | null) => {
          if (timer) clearTimeout(timer);
          resolve(f);
        };
        waiting.push(take);
      });
    },
    close: () => {
      close();
      end();
    },
    closed,
  };
  const push = (frame: Uint8Array) => {
    if (ended) return;
    const w = waiting.shift();
    if (w) w(frame);
    else queue.push(frame);
  };
  return { link, push, end };
}

/** The Wi-Fi transport: a WebSocket to the Mac (binary messages only, as the Mac's pump takes them). */
export const webSocketTransport: Transport = {
  open: (host, port, waitMs) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/`);
      ws.binaryType = "arraybuffer";
      const { link, push, end } = queueLink(
        (frame) => ws.send(frame),
        () => ws.close(),
      );
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${host} didn't answer.`));
      }, waitMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(link);
      };
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) push(new Uint8Array(e.data));
        else ws.close();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Couldn't reach ${host}.`));
      };
      ws.onclose = () => end();
    }),
};
