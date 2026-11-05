import type { Controller } from "../shell/controller";
import type { Request } from "../protocol/generated/Request";
import type { Session } from "../net/session";

/**
 * A connection to the Mac for the screens' tests: it records what was asked and answers from a table (an Error in the
 * table is thrown back as the Mac's error; a function is asked with the request). Handed to the controller's sync, as a real connection would be.
 */
export function attachSession(controller: Controller, answers: Partial<Record<Request["op"], unknown>> = {}, features: string[] = []) {
  const asked: Request[] = [];
  const session = {
    welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1, features },
    ask: async (r: Request) => {
      asked.push(r);
      // An answer may be worked out from the request (a function of it).
      const given = answers[r.op];
      const a = typeof given === "function" ? (given as (r: Request) => unknown)(r) : given;
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  } as unknown as Session;
  controller.sync.onSession(session);
  const lastOf = (op: Request["op"]) => [...asked].reverse().find((r) => r.op === op);
  return { asked, lastOf };
}
