export const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait one macrotask without setTimeout, so it works under mocked timers. */
export const immediate = () => new Promise((resolve) => setImmediate(resolve));
