"""Central application config: env vars first, then the repo-root .env (the project's single env file).

The path is absolute so uvicorn, alembic, the CLI and tests read the same file from any working
directory. Docker Compose reads the same root .env automatically for ${VAR} substitution; inside the
image the file is absent and compose passes the values as env vars instead.
"""
from pathlib import Path
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache

DEFAULT_SECRET = "CHANGE_ME_IN_PRODUCTION_USE_LONG_RANDOM_STRING"
ENV_FILE = str(Path(__file__).resolve().parents[3] / ".env")  # <repo>/.env


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    # App
    app_env: str = "development"
    app_secret_key: str = DEFAULT_SECRET
    debug: bool = False

    # Browser-facing security
    allowed_origins: list[str] = [
        "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost", "http://127.0.0.1",
    ]
    cookie_secure: bool = True          # set false only for a plain-HTTP deploy (no TLS yet)
    ws_auth_timeout_seconds: float = 5.0

    @model_validator(mode="after")
    def _strong_secret_in_production(self) -> "Settings":
        if self.app_env == "production" and (self.app_secret_key == DEFAULT_SECRET or len(self.app_secret_key) < 32):
            raise ValueError("APP_SECRET_KEY must be a random string of at least 32 characters in production")
        return self

    # PostgreSQL
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "postgres"
    db_password: str = "postgres"
    db_name: str = "ims"

    @property
    def database_url(self) -> str:
        return f"postgresql+asyncpg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def database_url_sync(self) -> str:
        return f"postgresql://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    # Connections per process = pool + overflow. Every uvicorn worker has its own pool, so
    # workers x (pool + overflow) must stay under Postgres max_connections (default 100).
    db_pool_size: int = 5
    db_max_overflow: int = 5

    # Redis
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""
    redis_db: int = 0

    @property
    def redis_url(self) -> str:
        if self.redis_password:
            return f"redis://:{self.redis_password}@{self.redis_host}:{self.redis_port}/{self.redis_db}"
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_db}"

    # JWT
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 15
    jwt_refresh_token_expire_days: int = 7

    # Data lake (JSONL files)
    lake_dir: str = "data_lake"  # matches the /app/data_lake volume in docker-compose

    # Webhooks
    slack_webhook_url: str = ""
    pagerduty_routing_key: str = ""

    # Observability
    otlp_endpoint: str = ""          # e.g. http://localhost:4317
    log_level: str = "INFO"

    # Rate limiting (fixed windows in Redis, shared by every worker/replica)
    rate_limit_ingest_per_sec: int = 2000   # requests per principal; a batch counts as one request
    rate_limit_auth_per_min: int = 10       # login/register attempts per client IP

    # Ingestion
    queue_max_size: int = 50_000
    ingestion_workers: int = 4
    shutdown_drain_seconds: float = 20.0    # keep below docker-compose stop_grace_period

    # DB write retry (transient errors only)
    db_retry_attempts: int = 3
    db_retry_base_delay: float = 0.2


@lru_cache
def get_settings() -> Settings:
    return Settings()
