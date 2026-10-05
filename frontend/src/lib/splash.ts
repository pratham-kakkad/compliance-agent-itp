import { useSyncExternalStore } from "react";

/**
 * The intro splash sets `<html data-splash="on|off|skip">` (an inline script in the root layout sets "on" or
 * "skip" before paint; "off" means it has finished). Components that play an entrance animation read `useAppReady()` and hold it until the
 * splash is gone, so the app's own entrance is not wasted underneath it.
 */
const EVENT = "ic-splash-change";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** True once the splash is finished (or was never going to show). False on the server, so hydration matches. */
export function useAppReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.splash !== "on",
    () => false,
  );
}

/** True when the boot script decided the splash will not play at all this session. */
export function useSplashSkipped(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.splash === "skip",
    () => false,
  );
}

export function setSplash(state: "on" | "off") {
  document.documentElement.dataset.splash = state;
  window.dispatchEvent(new Event(EVENT));
}

export const SPLASH_SEEN_KEY = "ic-splash-seen";

/** Inline script run before first paint: decides whether the splash plays this session. */
export const SPLASH_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;var seen=false;try{seen=sessionStorage.getItem("${SPLASH_SEEN_KEY}")==="1"}catch(e){}d.dataset.splash=(reduce||seen)?"skip":"on"}catch(e){document.documentElement.dataset.splash="off"}})();`;
