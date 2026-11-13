import type { Hash } from "viem";

import { tick, type BotClient, type Order, type TickResult } from "./tick.ts";

/**
 * Ticks the order on every new block until it fills, and resolves with the swap's hash.
 *
 * A block that arrives while a tick is still running is skipped. Rejects with the first
 * error a tick or `onTick` throws, even on the tick that fills. When the block watcher
 * fails or `signal` aborts, it stops watching, lets a running tick finish (a sent
 * transaction can't be called back), then rejects with the watcher's error or the signal's
 * reason, unless that tick filled the order or threw.
 */
export function run({
  client,
  order,
  signal,
  onTick,
}: {
  client: BotClient;
  order: Order;
  signal?: AbortSignal;
  onTick?: (result: TickResult) => void;
}): Promise<Hash> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let ticking = false;
    // Why run() stops, once no tick is running.
    let stopped: { reason: unknown } | undefined;

    const unwatchAll = () => {
      unwatch();
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (reason: unknown) => {
      unwatchAll();
      stopped ??= { reason };
      if (!ticking) reject(stopped.reason);
    };
    const onAbort = () => {
      stop(signal?.reason);
    };

    const onBlockNumber = async () => {
      if (ticking) return;
      ticking = true;
      try {
        const result = await tick({ client, order });
        onTick?.(result);
        if (result.kind === "filled") {
          unwatchAll();
          resolve(result.hash);
        }
      } catch (error) {
        unwatchAll();
        reject(error);
      } finally {
        ticking = false;
      }
      // A no-op once the promise has settled above.
      if (stopped) reject(stopped.reason);
    };

    const unwatch = client.watchBlockNumber({ emitOnBegin: true, onBlockNumber, onError: stop });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
