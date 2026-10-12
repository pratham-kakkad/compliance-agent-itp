import { SquarePen } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useChat } from "../lib/ChatContext";
import { useApi } from "../lib/useApi";
import type { ChatStatus } from "../types";
import { Banner, Button, PageHeader } from "../components/ui";
import { LogoMark } from "../components/shell/Logo";
import { Composer, MessageList, Suggestions } from "../components/chat/Chat";

function EnvVar({ children }: { children: React.ReactNode }) {
  return <code className="mono text-[12px] text-ink px-1 py-px rounded bg-panel border border-line">{children}</code>;
}

/**
 * Tells the user what's missing from .env before they hit an error mid-chat.
 * Renders nothing while loading or if /chat/status fails — it must never block the chat.
 */
function AssistantSetupBanner() {
  const { data: status } = useApi<ChatStatus>("/chat/status");
  if (!status) return null;

  if (!status.llm.configured) {
    return (
      <Banner tone="warn" title="The assistant isn't configured yet" className="mb-4">
        Add <EnvVar>GROQ_API_KEY</EnvVar> to <EnvVar>.env</EnvVar>, then restart the app. Until then the assistant can't answer questions.
      </Banner>
    );
  }

  if (!status.embeddings.configured) {
    return (
      <Banner tone="info" title="Semantic search is off" className="mb-4">
        {status.embeddings.mode === "local" ? (
          <>Local embeddings aren't available on this server{status.embeddings.error ? ` (${status.embeddings.error})` : ""}.</>
        ) : (
          <>
            It turns on once <EnvVar>HUGGINGFACEHUB_API_TOKEN</EnvVar> is added to <EnvVar>.env</EnvVar> (then restart the app).
          </>
        )}{" "}
        The assistant still answers using exact attendance lookups.
      </Banner>
    );
  }

  return null;
}

export function Assistant() {
  const { me } = useAuth();
  const { history, clear, pending } = useChat();
  const firstName = me?.name.split(" ")[0] ?? "there";
  const empty = history.length === 0;

  return (
    <div className="max-w-[760px] mx-auto -mb-20 min-h-[calc(100vh-56px-64px)] flex flex-col">
      <PageHeader
        title="Assistant"
        description="Ask about employee attendance, departments and punch records — or your meetings"
        actions={!empty && <Button size="sm" leadingIcon={SquarePen} onClick={clear} disabled={pending}>New chat</Button>}
      />

      <AssistantSetupBanner />

      <div className="flex-1">
        {empty ? (
          <div className="flex flex-col items-center text-center pt-6 sm:pt-12 pb-8">
            <LogoMark size={44} />
            <h2 className="mt-4 text-xl font-semibold text-ink">Hi {firstName}, how can I help?</h2>
            <p className="mt-1 text-sm text-ink2 max-w-md">
              I can look up who was in on a given day, attendance by employee or department, and first and last punch times — and your meetings too.
            </p>
            <div className="w-full mt-8">
              <Suggestions />
            </div>
          </div>
        ) : (
          <div className="pb-6">
            <MessageList />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 pt-2 pb-4 sm:pb-6">
        <Composer autoFocus />
      </div>
    </div>
  );
}
