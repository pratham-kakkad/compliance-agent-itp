from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = (
        "postgresql+psycopg2://meetingcompliance:meetingcompliance@127.0.0.1:5433/meeting_compliance"
    )

    auth_mode: str = "dev"  # "dev" | "microsoft"
    session_secret: str = "change-me-to-a-random-string"

    ms_client_id: str = ""
    ms_client_secret: str = ""
    ms_tenant_id: str = ""
    ms_redirect_uri: str = "http://localhost:8010/auth/callback"

    anthropic_api_key: str = ""


settings = Settings()
