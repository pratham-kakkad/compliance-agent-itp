import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { IconButton } from "./ui";
import { duration, ease } from "../lib/motion";

interface OverlayState {
  openModal: (content: React.ReactNode) => void;
  openPanel: (content: React.ReactNode) => void;
  close: () => void;
}

const OverlayContext = createContext<OverlayState | null>(null);

export function useOverlay(): OverlayState {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error("useOverlay must be used within OverlayProvider");
  return ctx;
}

type Kind = "modal" | "panel";

/**
 * One overlay at a time: a centered dialog ("modal") or a right-hand sheet
 * ("panel"). Opening while one is open swaps the content with a crossfade.
 */
export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [kind, setKind] = useState<Kind>("modal");
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<React.ReactNode>(null);
  const seq = useRef(0);
  const [key, setKey] = useState(0);

  const show = useCallback((k: Kind, c: React.ReactNode) => {
    seq.current += 1;
    setKey(seq.current);
    setKind(k);
    setContent(c);
    setOpen(true);
  }, []);

  const openModal = useCallback((c: React.ReactNode) => show("modal", c), [show]);
  const openPanel = useCallback((c: React.ReactNode) => show("panel", c), [show]);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ openModal, openPanel, close }), [openModal, openPanel, close]);

  const body = (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={key}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: duration.base, ease: ease.decelerate } }}
        exit={{ opacity: 0, transition: { duration: duration.fast } }}
      >
        {content}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <OverlayContext.Provider value={value}>
      {children}
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="mc-scrim fixed inset-0 z-50" style={{ background: "var(--scrim)" }} />
          {kind === "modal" ? (
            <div className="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none">
              <D.Content
                aria-describedby={undefined}
                className="mc-dialog pointer-events-auto relative w-full max-w-[560px] max-h-[85vh] overflow-y-auto rounded-xl bg-panel border border-line shadow-lg p-6 outline-none"
              >
                <D.Title className="sr-only">Details</D.Title>
                <D.Close asChild>
                  <IconButton icon={X} label="Close" tooltip={false} className="absolute top-3 right-3 z-10" />
                </D.Close>
                {body}
              </D.Content>
            </div>
          ) : (
            <D.Content
              aria-describedby={undefined}
              className="mc-sheet-right fixed top-0 right-0 z-50 h-full w-[480px] max-w-full overflow-y-auto bg-panel border-l border-line shadow-lg p-6 outline-none"
            >
              <D.Title className="sr-only">Details</D.Title>
              <D.Close asChild>
                <IconButton icon={X} label="Close" tooltip={false} className="absolute top-3 right-3 z-10" />
              </D.Close>
              {body}
            </D.Content>
          )}
        </D.Portal>
      </D.Root>
    </OverlayContext.Provider>
  );
}
