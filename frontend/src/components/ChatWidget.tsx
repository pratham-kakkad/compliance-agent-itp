import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Maximize2, MessageSquare, SquarePen, X } from "lucide-react";
import { useChat } from "../lib/ChatContext";
import { duration, ease } from "../lib/motion";
import { IconButton } from "./ui";
import { Composer, MessageList, Suggestions } from "./chat/Chat";

/** Material 3 FAB that opens a compact assistant panel (hidden on the full Assistant page). */
export function ChatFabAndPanel() {
  const [open, setOpen] = useState(false);
  const { history, clear, pending } = useChat();
  const navigate = useNavigate();
  const fab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        fab.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Assistant"
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: duration.base, ease: ease.decelerate } }}
            exit={{ opacity: 0, scale: 0.95, y: 8, transition: { duration: duration.fast, ease: ease.accelerate } }}
            style={{ transformOrigin: "bottom right" }}
            className="fixed z-40 inset-0 sm:inset-auto sm:bottom-24 sm:right-6 sm:w-[400px] sm:h-[580px] sm:max-h-[calc(100vh-120px)] bg-panel sm:border border-line sm:rounded-xl shadow-lg flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 h-12 px-3 border-b border-line flex-none">
              <span className="text-sm font-semibold text-ink pl-1 flex-1">Assistant</span>
              {history.length > 0 && <IconButton icon={SquarePen} label="New chat" size="sm" onClick={clear} disabled={pending} />}
              <IconButton
                icon={Maximize2}
                label="Open full view"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  navigate("/assistant");
                }}
              />
              <IconButton icon={X} label="Close" size="sm" onClick={() => setOpen(false)} />
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {history.length === 0 ? (
                <div>
                  <p className="text-sm text-ink2 mb-4">Ask about attendance, employees, departments — or your meetings.</p>
                  <Suggestions columns={1} />
                </div>
              ) : (
                <MessageList compact />
              )}
            </div>
            <div className="p-3 border-t border-line flex-none">
              <Composer autoFocus compact />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        ref={fab}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close assistant" : "Open assistant"}
        aria-expanded={open}
        whileTap={{ scale: 0.95 }}
        className={clsx(
          "fixed bottom-6 right-6 z-40 w-14 h-14 rounded-2xl btn-primary text-white items-center justify-center transition-colors",
          open ? "hidden sm:flex" : "flex"
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? "x" : "chat"}
            initial={{ rotate: -45, opacity: 0, scale: 0.8 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 45, opacity: 0, scale: 0.8 }}
            transition={{ duration: duration.fast, ease: ease.standard }}
            className="flex"
          >
            {open ? <X size={22} /> : <MessageSquare size={22} />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  );
}
