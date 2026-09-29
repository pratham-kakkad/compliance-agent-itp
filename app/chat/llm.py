"""The chat model. This is the only module that knows the LLM is Groq:
everything else in app/chat/ talks to a LangChain BaseChatModel, so a
different provider is a change here and nowhere else.
"""
import logging
from collections.abc import Sequence

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.runnables import Runnable

from app.config import settings

logger = logging.getLogger("app.chat")

PROVIDER = "groq"


class ChatNotConfigured(RuntimeError):
    """No LLM key configured — surfaced as a 503 by POST /chat."""


class ChatUpstreamError(RuntimeError):
    """The LLM provider failed in a way the user should hear about, with the
    HTTP status POST /chat should answer with."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class MalformedToolCall(ChatUpstreamError):
    """Groq rejected the model's tool call (tool_use_failed) twice in a row."""

    def __init__(self) -> None:
        super().__init__(502, "The model produced a malformed tool call — try rephrasing the question.")


TOO_LARGE = (
    "That question needed more data than Groq's token limit allows — start a new chat or ask something "
    "narrower (one date or one department)."
)


def llm_status() -> dict:
    return {
        "configured": bool(settings.groq_api_key.strip()),
        "provider": PROVIDER,
        "model": settings.groq_model,
    }


def build_chat_model() -> BaseChatModel:
    key = settings.groq_api_key.strip()
    if not key:
        # Checked up front: ChatGroq raises its own GroqError for an empty key.
        raise ChatNotConfigured("GROQ_API_KEY is not set — add it to .env and restart the app")

    from langchain_groq import ChatGroq  # imported lazily; only needed once a key exists

    extra = {}
    effort = settings.groq_reasoning_effort.strip().lower()
    if effort and "gpt-oss" in settings.groq_model:
        # Only gpt-oss accepts low/medium/high; other Groq models reject it.
        extra["reasoning_effort"] = effort

    return ChatGroq(
        model=settings.groq_model,
        api_key=key,
        temperature=0,
        **extra,
        max_retries=2,  # the groq client already backs off on 429/5xx/connection errors
        timeout=60,
        # Replies are short plain text (the original agent capped them at 1024
        # too), and a small cap keeps each request inside Groq's free-tier
        # tokens-per-minute budget.
        max_tokens=1024,
    )


def model_name_of(chat_model: BaseChatModel) -> str:
    return getattr(chat_model, "model_name", None) or settings.groq_model


_RETRY = object()


def _error_details(exc: Exception) -> dict:
    """The "error" object of a Groq error response ({"error": {"message",
    "type", "code", ...}}), or {} when there isn't one. Classification uses
    its structured fields only: free text (the message, or failed_generation,
    which is the model's own output) can say anything."""
    body = getattr(exc, "body", None)
    err = body.get("error") if isinstance(body, dict) else None
    return err if isinstance(err, dict) else {}


def _translate_error(exc: Exception, model_name: str):
    """Maps a Groq SDK exception (LangChain passes them through unwrapped) to
    a ChatUpstreamError, _RETRY for a transient malformed tool call, or None
    for anything that isn't a Groq error."""
    try:
        import groq
    except ImportError:  # pragma: no cover - groq ships with langchain-groq
        return None
    if not isinstance(exc, groq.GroqError):
        return None

    code = _error_details(exc).get("code")
    status = getattr(exc, "status_code", None)

    if isinstance(exc, groq.AuthenticationError):
        return ChatUpstreamError(503, "Groq rejected GROQ_API_KEY — check the key in .env")
    if isinstance(exc, groq.BadRequestError) and code == "tool_use_failed":
        return _RETRY
    if isinstance(exc, groq.RateLimitError):
        return ChatUpstreamError(429, "Groq rate limit reached — wait a moment and try again")
    # "Request too large ... tokens per minute" is an HTTP 413 (code
    # rate_limit_exceeded), which the SDK raises as a bare APIStatusError;
    # an over-long context is a 400 context_length_exceeded.
    if status == 413 or code in ("rate_limit_exceeded", "context_length_exceeded"):
        return ChatUpstreamError(413, TOO_LARGE)
    if isinstance(exc, groq.NotFoundError) or code in ("model_decommissioned", "model_not_found"):
        return ChatUpstreamError(
            503, f"Groq model '{model_name}' is unavailable — set GROQ_MODEL in .env to a current model"
        )
    if isinstance(exc, groq.APIConnectionError):  # includes APITimeoutError
        return ChatUpstreamError(503, "Couldn't reach Groq — check the network and try again")
    if isinstance(exc, groq.APIStatusError):
        return ChatUpstreamError(502, f"Groq returned an error: {exc.status_code}")
    return None


def _retry_hint(exc: Exception) -> HumanMessage:
    reason = str(_error_details(exc).get("message") or "").strip() or "invalid tool call"
    return HumanMessage(
        content=f"Your previous tool call was rejected by the API: {reason[:300]}. Call a tool again with JSON "
        "arguments that exactly match its schema, or answer without tools."
    )


def invoke_chat_model(
    runnable: Runnable, messages: Sequence[BaseMessage], *, model_name: str | None = None
) -> AIMessage:
    """runnable.invoke(messages), with Groq failures turned into
    ChatUpstreamError. A malformed tool call ("tool_use_failed" — Groq
    validates the model's tool-call JSON server-side) is retried once, with
    the rejection reason appended so the retry isn't the identical,
    near-greedy request again. The hint is only added to that retry, never
    to the caller's message list."""
    model_name = model_name or settings.groq_model
    attempt = list(messages)
    retried = False
    while True:
        try:
            return runnable.invoke(attempt)
        except Exception as exc:
            mapped = _translate_error(exc, model_name)
            if mapped is None:
                raise
            if mapped is not _RETRY:
                # Keep Groq's own wording in the log: the mapped message is
                # friendlier but hides details (e.g. which model or limit).
                from app.chat.embeddings import redact_secrets

                detail = _error_details(exc).get("message") or str(exc)
                logger.warning(
                    "Groq request failed (%s, model %s): %s",
                    getattr(exc, "status_code", type(exc).__name__),
                    model_name,
                    redact_secrets(str(detail))[:500],
                )
            if mapped is _RETRY:
                if not retried:
                    retried = True
                    logger.warning("Groq rejected a malformed tool call; retrying once")
                    attempt = [*messages, _retry_hint(exc)]
                    continue
                raise MalformedToolCall() from exc
            raise mapped from exc
