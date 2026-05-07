// Tiny in-process pub/sub for the harness pipeline.
//
// Why a custom bus instead of node:events? Two reasons:
//   1. We want a single subscribe path for SSE clients (the `subscribe` method
//      returns an async iterator that respects backpressure) AND a fire-and-
//      forget path for stages publishing the next event.
//   2. We want to track metrics per topic without monkey-patching EventEmitter.
//
// Decoupling note: this module is dependency-free on purpose. When we
// eventually pull the harness out into its own process, this same eventbus
// can be swapped for a Redis pub/sub or NATS without touching any stage.

const buses = new Map(); // topic → Set<callback>

/**
 * Publish an event to all subscribers of `topic`. Subscribers are called
 * synchronously in registration order; any exception is logged and swallowed
 * so one bad subscriber can't take down the pipeline.
 *
 * @param {string} topic
 * @param {object} event
 */
export function publish(topic, event) {
  const subs = buses.get(topic);
  if (!subs || subs.size === 0) return;
  for (const cb of subs) {
    try {
      cb(event);
    } catch (err) {
      console.error(`[eventbus] subscriber for "${topic}" threw:`, err?.message);
    }
  }
}

/**
 * Subscribe to a topic. Returns an unsubscribe function.
 *
 * @param {string} topic
 * @param {(event: object) => void} cb
 * @returns {() => void}
 */
export function subscribe(topic, cb) {
  let subs = buses.get(topic);
  if (!subs) {
    subs = new Set();
    buses.set(topic, subs);
  }
  subs.add(cb);
  return () => subs.delete(cb);
}

/**
 * Async-iterator interface — convenient for SSE handlers and for tests that
 * need to await events. Buffer is bounded so a slow consumer doesn't blow up
 * memory (the oldest events are dropped if buffer overflows).
 *
 * @param {string} topic
 * @param {{ bufferSize?: number, signal?: AbortSignal }} [opts]
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* subscribeIterator(topic, { bufferSize = 256, signal } = {}) {
  const queue = [];
  let waiter = null;
  let done = false;

  const unsubscribe = subscribe(topic, (event) => {
    if (queue.length >= bufferSize) queue.shift();
    queue.push(event);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });

  const onAbort = () => {
    done = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!done) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (done) break;
      await new Promise((resolve) => {
        waiter = resolve;
      });
    }
  } finally {
    unsubscribe();
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Diagnostic snapshot — used by /api/agent/status and unit tests.
 * @returns {{topic: string, subscribers: number}[]}
 */
export function inspect() {
  return [...buses.entries()].map(([topic, subs]) => ({ topic, subscribers: subs.size }));
}

/** Clear all subscribers. Test-only. */
export function _resetForTests() {
  buses.clear();
}
