import { useSyncExternalStore } from "react";

/** Global in-flight work counter driving the top progress bar (YouTube/GitHub style). */
let active = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const progress = {
  start() {
    active += 1;
    emit();
  },
  done() {
    active = Math.max(0, active - 1);
    emit();
  },
  async track<T>(p: Promise<T>): Promise<T> {
    progress.start();
    try {
      return await p;
    } finally {
      progress.done();
    }
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useIsBusy(): boolean {
  return useSyncExternalStore(subscribe, () => active > 0);
}
