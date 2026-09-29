import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { AlertTriangle, ArrowUp, BarChart3, CalendarSearch, Fingerprint, UserCheck } from "lucide-react";
import { CHAT_ERROR_PREFIX, useChat } from "../../lib/ChatContext";
import { duration, ease } from "../../lib/motion";
import { useAuth } from "../../auth/AuthContext";
import { Avatar, Button } from "../ui";
import { LogoMark } from "../shell/Logo";

/** Attendance-first starter prompts, plus one meeting prompt. */
export const SUGGESTIONS = [
  { icon: BarChart3, text: "Give me an attendance overview for this week" },
  { icon: UserCheck, text: "Who was in on the most recent working day?" },
  { icon: Fingerprint, text: "Which employees had only a single punch on a day recently?" },
  { icon: CalendarSearch, text: "Which meetings need my attention right now?" },
];

function AssistantAvatar() {
  return <LogoMark size={28} />;
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3" role="status" aria-label="Assistant is typing">
      <AssistantAvatar />
      <div className="flex items-center gap-1 h-7 px-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-ink3" style={{ animation: `typing 1.2s ${i * 0.15}s infinite ease-in-out` }} />
        ))}
      </div>
    </div>
  );
}

export function MessageList({ compact }: { compact?: boolean }) {
  const { history, pending, retry } = useChat();
  const { me } = useAuth();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, pending]);

  return (
    <div className={clsx("flex flex-col", compact ? "gap-4" : "gap-6")} aria-live="polite">
      {history.map((m, i) => {
        const isError = m.role === "assistant" && m.content.startsWith(CHAT_ERROR_PREFIX);
        const isLast = i === history.length - 1;
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: duration.base, ease: ease.decelerate }}
            className={clsx("flex items-start gap-3", m.role === "user" && "flex-row-reverse")}
          >
            {m.role === "user" ? (me ? <Avatar name={me.name} size={28} /> : null) : <AssistantAvatar />}
            {isError ? (
              <div className="flex-1 min-w-0 rounded-lg border px-3 py-2.5 bg-crit-bg text-[13px] text-ink flex items-start gap-2" style={{ borderColor: "color-mix(in srgb, var(--crit) 35%, transparent)" }}>
                <AlertTriangle size={15} className="text-crit mt-0.5 flex-none" aria-hidden />
                <span className="flex-1">{m.content.slice(CHAT_ERROR_PREFIX.length)}</span>
                {isLast && !pending && <Button size="sm" onClick={retry}>Retry</Button>}
              </div>
            ) : m.role === "user" ? (
              <div className="max-w-[80%] rounded-xl rounded-tr-sm bg-panel2 border border-line px-3.5 py-2 text-sm text-ink whitespace-pre-wrap break-words">{m.content}</div>
            ) : (
              <div className="flex-1 min-w-0 pt-1 text-sm leading-6 text-ink whitespace-pre-wrap break-words">{m.content}</div>
            )}
          </motion.div>
        );
      })}
      {pending && <TypingIndicator />}
      <div ref={end} />
    </div>
  );
}

export function Composer({ autoFocus, compact }: { autoFocus?: boolean; compact?: boolean }) {
  const { send, pending } = useChat();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 16)}px`;
  }, [value]);

  const submit = () => {
    if (!value.trim() || pending) return;
    void send(value);
    setValue("");
  };

  return (
    <div>
      <div className="relative flex items-end gap-2 rounded-xl border border-line bg-panel shadow-xs px-3 py-2 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_28%,transparent)]">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about attendance, employees or meetings…"
          aria-label="Message the assistant"
          className="flex-1 resize-none bg-transparent outline-none text-sm leading-[22px] text-ink placeholder:text-ink3 py-1 max-h-[148px] focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim() || pending}
          aria-label="Send message"
          className="w-8 h-8 flex-none rounded-lg flex items-center justify-center bg-accent-emphasis text-white hover:bg-accent-emphasis-hover disabled:bg-neutral-bg disabled:text-ink3 transition-colors"
        >
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      </div>
      {!compact && <p className="text-xs text-ink3 text-center mt-2">The assistant can make mistakes — verify important numbers. Enter to send, Shift+Enter for a new line.</p>}
    </div>
  );
}

export function Suggestions({ columns = 2 }: { columns?: 1 | 2 }) {
  const { send, pending } = useChat();
  return (
    <div className={clsx("grid gap-2", columns === 2 && "sm:grid-cols-2")}>
      {SUGGESTIONS.map(({ icon: Icon, text }) => (
        <button
          key={text}
          type="button"
          disabled={pending}
          onClick={() => send(text)}
          className="flex items-start gap-3 text-left rounded-lg border border-line bg-panel px-3.5 py-3 text-[13px] text-ink hover:bg-panel2 hover:border-line-strong transition-colors disabled:opacity-60"
        >
          <Icon size={16} className="text-accent mt-0.5 flex-none" aria-hidden />
          {text}
        </button>
      ))}
    </div>
  );
}
