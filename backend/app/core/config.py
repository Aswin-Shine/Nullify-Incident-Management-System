"""Central application config — reads from env vars / .env file."""
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_env: str = "development"
    app_secret_key: str = "CHANGE_ME_IN_PRODUCTION_USE_LONG_RANDOM_STRING"
    debug: bool = False

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
    jwt_access_token_expire_minutes: int = 60
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
