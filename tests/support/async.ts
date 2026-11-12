import { mock } from "node:test";

export const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait one macrotask without setTimeout, so it works under mocked timers. */
export const immediate = () => new Promise((resolve) => setImmediate(resolve));

/** Run a call through its retry delays under fake timers. */
export async function drainRetries<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  pending.then(done, done);
  for (let attempt = 0; attempt < 50; attempt++) {
    await immediate();
    if (settled) break;
    mock.timers.tick(1_000);
  }
  return pending;
}

export async function withMockTimers<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    return await run();
  } finally {
    mock.timers.reset();
  }
}

export function retryWithMockTimers<T>(run: () => Promise<T>): Promise<T> {
  return withMockTimers(() => drainRetries(run()));
}
