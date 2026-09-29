from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # populate_by_name lets code/tests pass fields by their Python name even
    # where an env alias is declared (huggingfacehub_api_token below).
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    database_url: str = (
        "postgresql+psycopg2://meetingcompliance:meetingcompliance@127.0.0.1:5433/meeting_compliance"
    )

    # Demo login and real "Sign in with Microsoft" are independent and can
    # both be live at once: whoever picks a demo account always gets the
    # static seeded dataset, whoever signs in with Microsoft always gets
    # their own Graph-synced calendar. See app/teams_sync.py and
    # app/api/auth.py. Set to False to hide demo login in a real deployment.
    enable_demo_login: bool = True
    session_secret: str = "change-me-to-a-random-string"

    ms_client_id: str = ""
    ms_client_secret: str = ""
    ms_tenant_id: str = ""
    ms_redirect_uri: str = "http://localhost:8010/auth/callback"

    # Real Teams attendance sync (GraphTeamsProvider) for real (non-demo)
    # users — only runs once an Azure AD app registration is configured;
    # needs the application permissions from HELPDESK_EMAIL_DRAFT.md granted
    # and admin-consented.
    teams_sync_interval_minutes: int = 15
    teams_sync_window_days: int = 30

    # --- Chat assistant (LangChain tool-calling agent, see app/chat/) ---
    # Groq API key (https://console.groq.com/keys). Empty -> POST /chat returns
    # a clear 503 instead of failing obscurely.
    groq_api_key: str = ""
    # Any Groq model that supports tool calling; change it if Groq retires this one.
    groq_model: str = "openai/gpt-oss-120b"
    # Reasoning effort for Groq's gpt-oss models ("low" | "medium" | "high").
    # Reasoning tokens count against the free tier's tokens-per-minute limit,
    # and "low" is plenty for picking tools. Ignored for other models.
    groq_reasoning_effort: str = "low"
    # How attendance records get embedded for semantic search: "api" = the
    # HuggingFace Inference API (needs the token below), "local" =
    # sentence-transformers on this machine (pip install '.[local-embeddings]').
    embeddings_mode: str = "api"
    # HuggingFace token for "api" embeddings, read from HUGGINGFACEHUB_API_TOKEN
    # or HF_TOKEN. Empty -> the chatbot still works, semantic search is off.
    huggingfacehub_api_token: str = Field(
        default="", validation_alias=AliasChoices("HUGGINGFACEHUB_API_TOKEN", "HF_TOKEN")
    )
    # Embedding model (a HuggingFace repo id) used in both modes. Changing it
    # starts a fresh embedding-cache namespace; nothing needs clearing.
    hf_embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    # Optional HuggingFace inference provider (e.g. "hf-inference"); empty = HF's default.
    hf_inference_provider: str = ""
    # How many days back per-day attendance records are embedded for search.
    # Older days are still reachable through the exact SQL-backed tools.
    assistant_index_days: int = 120
    # Build the attendance search index in the background at startup, so the
    # first chat question doesn't wait on embedding every record. Tests turn
    # this off (tests/conftest.py).
    assistant_warm_index: bool = True


settings = Settings()
