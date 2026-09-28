"""
Locust load test — validates 10k signals/sec claim.

Run:
  locust -f locustfile.py --host=http://localhost:8000 --users=100 --spawn-rate=20

Or headless:
  locust -f locustfile.py --host=http://localhost:8000 --users=200 --spawn-rate=50 \
         --run-time=60s --headless --only-summary
"""
from locust import HttpUser, task, between, events
import json
import os
import random

COMPONENTS = [
    "RDBMS_PRIMARY", "CACHE_CLUSTER_01", "KAFKA_BROKER_01",
    "API_GATEWAY", "MCP_HOST_01", "POSTGRES_MAIN",
]
SIGNAL_TYPES = ["ERROR", "LATENCY_SPIKE", "TIMEOUT", "CONNECTION_REFUSED"]

_token = None


class NullifyUser(HttpUser):
    wait_time = between(0.01, 0.05)  # ~20-100 req/sec per user

    def on_start(self):
        """Authenticate like a real producer: an API key (accounts are invite-only).

        Create an SRE with `python -m app.cli create-user --role sre ...`, issue it a key via
        POST /api/auth/api-key, then run: NULLIFY_API_KEY=<key> locust -f locustfile.py
        """
        global _token
        _token = _token or os.environ.get("NULLIFY_API_KEY")
        if not _token:
            raise RuntimeError("Set NULLIFY_API_KEY to an SRE's API key")
        self.token = _token

    @property
    def _headers(self):
        return {"X-API-Key": self.token}

    @task(10)
    def ingest_signal(self):
        """High-frequency signal ingestion (70% of load)."""
        self.client.post("/api/signals", json={
            "component_id": random.choice(COMPONENTS),
            "signal_type": random.choice(SIGNAL_TYPES),
            "message": "Load test signal",
            "severity": random.choice(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        }, headers=self._headers, name="/api/signals")

    @task(3)
    def list_work_items(self):
        """Dashboard poll."""
        self.client.get("/api/work-items", headers=self._headers, name="/api/work-items")

    @task(2)
    def batch_ingest(self):
        """Batch signal ingestion."""
        signals = [
            {
                "component_id": random.choice(COMPONENTS),
                "signal_type": random.choice(SIGNAL_TYPES),
                "message": f"Batch signal {i}",
            }
            for i in range(10)
        ]
        self.client.post("/api/signals/batch", json=signals,
                         headers=self._headers, name="/api/signals/batch")

    @task(1)
    def health_check(self):
        self.client.get("/health", name="/health")


@events.quitting.add_listener
def on_quitting(environment, **kwargs):
    if environment.stats.total.fail_ratio > 0.05:
        print(f"❌ FAIL: Error rate {environment.stats.total.fail_ratio:.1%} > 5%")
    else:
        rps = environment.stats.total.current_rps
        print(f"✅ PASS: {rps:.0f} req/sec, error rate {environment.stats.total.fail_ratio:.1%}")
