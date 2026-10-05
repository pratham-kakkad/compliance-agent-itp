import { useContext, useEffect, useRef } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";
import { useConfirm } from "./confirm";

/**
 * Warns before the page is left with unsaved changes: closing or reloading the tab (the browser's own
 * prompt), and any in-app navigation (links, the sidebar, programmatic navigate) with a confirm dialog.
 * Returns `allowNext()`, to call right before a navigation you want to let through (after saving).
 * The browser's Back button can only get the tab-close prompt.
 */
export function useUnsavedGuard(dirty: boolean): () => void {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const confirm = useConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const bypass = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const nav = navigator as unknown as {
      push: (...a: unknown[]) => void;
      replace: (...a: unknown[]) => void;
    };
    const { push, replace } = nav;
    const wrap = (orig: (...a: unknown[]) => void) =>
      function (this: unknown, ...args: unknown[]) {
        if (bypass.current) {
          bypass.current = false;
          return orig.apply(this, args);
        }
        confirmRef.current({
          title: "Leave without saving?",
          description: "You have changes that haven't been saved. If you leave now they will be lost.",
          confirm: "Leave without saving",
          cancel: "Keep editing",
          tone: "danger",
          onConfirm: () => {
            orig.apply(this, args);
          },
        });
      };
    nav.push = wrap(push);
    nav.replace = wrap(replace);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      nav.push = push;
      nav.replace = replace;
    };
  }, [dirty, navigator]);

  return () => {
    bypass.current = true;
  };
}
