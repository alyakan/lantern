/**
 * Drops React's "not wrapped in act(...)" warnings from `target.error`; every other message still prints.
 *
 * On a slow runner React prints one for each state update that lands after a test's act() scope: hundreds per run. Each is
 * a console message the worker sends to the main process, and one still in flight when a worker shuts down fails the whole
 * run with an EnvironmentTeardownError ("Closing rpc while onUserConsoleLog was pending") although every test passed.
 */
export function quietActWarnings(target: { error: (...args: unknown[]) => void }): void {
  const print = target.error.bind(target);
  target.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("was not wrapped in act(")) return;
    print(...args);
  };
}
