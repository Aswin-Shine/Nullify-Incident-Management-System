"""Structured JSON logging — production-grade log config."""
import logging
import sys
from pythonjsonlogger import jsonlogger
from app.core.config import get_settings


class IMSJsonFormatter(jsonlogger.JsonFormatter):
    def add_fields(self, log_record, record, message_dict):
        super().add_fields(log_record, record, message_dict)
        log_record["service"] = "ims-backend"
        log_record["env"] = get_settings().app_env
        log_record["logger"] = record.name
        log_record["level"] = record.levelname


def setup_logging():
    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(level)

    # Remove default handlers
    for h in root.handlers[:]:
        root.removeHandler(h)

    handler = logging.StreamHandler(sys.stdout)

    if settings.app_env == "development":
        # Human-readable in dev
        fmt = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s — %(message)s"
        )
        handler.setFormatter(fmt)
    else:
        # JSON in staging/prod
        handler.setFormatter(IMSJsonFormatter("%(asctime)s %(level)s %(name)s %(message)s"))

    root.addHandler(handler)

    # Silence noisy libs
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
