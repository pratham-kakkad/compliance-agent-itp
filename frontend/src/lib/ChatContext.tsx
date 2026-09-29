import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { ChatMessage } from "../types";

interface ChatState {
  history: ChatMessage[];
  pending: boolean;
  send: (text: string) => Promise<void>;
  /** Re-send the last user message after a failed reply. */
  retry: () => void;
  clear: () => void;
}

const ChatContext = createContext<ChatState | null>(null);

/** Assistant replies that failed are stored with this prefix so the UI can render them as errors. */
export const CHAT_ERROR_PREFIX = "⚠ ";

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  // Always read the latest history, so two quick sends don't race on a stale closure.
  const historyRef = useRef<ChatMessage[]>([]);

  const commit = useCallback((next: ChatMessage[]) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const ask = useCallback(
    async (text: string, prior: ChatMessage[]) => {
      commit([...prior, { role: "user", content: text }]);
      setPending(true);
      try {
        const res = await api.post<{ reply: string }>("/chat", {
          message: text,
          history: prior.filter((m) => !m.content.startsWith(CHAT_ERROR_PREFIX)),
        });
        commit([...historyRef.current, { role: "assistant", content: res.reply }]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only the missing-key case is rewritten; everything else (rate limits, model
        // unavailable, …) passes through with the server's own detail text.
        const friendly = msg.includes("GROQ_API_KEY")
          ? "The assistant isn't configured yet — add GROQ_API_KEY to .env and restart the app."
          : msg;
        commit([...historyRef.current, { role: "assistant", content: `${CHAT_ERROR_PREFIX}${friendly}` }]);
      } finally {
        setPending(false);
      }
    },
    [commit]
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;
      await ask(trimmed, historyRef.current);
    },
    [ask, pending]
  );

  const retry = useCallback(() => {
    const h = historyRef.current;
    const lastUser = [...h].reverse().findIndex((m) => m.role === "user");
    if (lastUser < 0 || pending) return;
    const idx = h.length - 1 - lastUser;
    void ask(h[idx].content, h.slice(0, idx));
  }, [ask, pending]);

  const clear = useCallback(() => commit([]), [commit]);

  const value = useMemo(() => ({ history, pending, send, retry, clear }), [history, pending, send, retry, clear]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatState {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
