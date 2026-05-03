"""Observability setup — Prometheus metrics + OpenTelemetry tracing."""
from __future__ import annotations
import logging
from fastapi import FastAPI
from app.core.config import get_settings

logger = logging.getLogger("ims.observability")


def setup_prometheus(app: FastAPI):
    """Attach Prometheus instrumentator — exposes /metrics."""
    try:
        from prometheus_fastapi_instrumentator import Instrumentator
        Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            excluded_handlers=["/health", "/metrics"],
        ).instrument(app).expose(app, endpoint="/metrics")
        logger.info("Prometheus metrics exposed at /metrics")
    except Exception as e:
        logger.warning("Prometheus setup failed: %s", e)


def setup_otel(app: FastAPI):
    """Setup OpenTelemetry tracing — only if OTLP_ENDPOINT configured."""
    settings = get_settings()
    if not settings.otlp_endpoint:
        logger.info("OTel disabled (OTLP_ENDPOINT not set)")
        return
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource

        resource = Resource.create({"service.name": "ims-backend", "deployment.environment": settings.app_env})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=settings.otlp_endpoint, insecure=True)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
        logger.info("OTel tracing configured → %s", settings.otlp_endpoint)
    except Exception as e:
        logger.warning("OTel setup failed: %s", e)
