"""Deployment config the code relies on: container memory vs the ingest queue, Redis eviction, nginx in front of a
backend that can be recreated or scaled (architecture review M1, M4, Low)."""
import ipaddress
import re
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.models.schemas import MAX_METADATA_BYTES

ROOT = Path(__file__).resolve().parents[2]
COMPOSE, NGINX, DOCKERFILE = ROOT / "docker-compose.yml", ROOT / "frontend" / "nginx.conf", ROOT / "backend" / "Dockerfile"
pytestmark = pytest.mark.skipif(not (COMPOSE.exists() and NGINX.exists()), reason="deploy files not in this checkout")


def service(name: str) -> str:
    """The text of one service block in docker-compose.yml."""
    return re.search(rf"^  {name}:\n(.*?)(?=^  \S|\Z)", COMPOSE.read_text(), re.M | re.S).group(1)


def test_full_ingest_queues_fit_in_the_backend_memory_limit():
    """M1: 50k queued signals per worker, at up to 12 KB raw (about 3x that as Python dicts), would OOM the container."""
    mem_mb = int(re.search(r"mem_limit:\s*(\d+)m", service("backend")).group(1))
    workers = int(re.search(r'"--workers",\s*"(\d+)"', DOCKERFILE.read_text()).group(1))
    worst_signal_kb = 3 * (4096 + MAX_METADATA_BYTES) / 1024  # message + metadata, as dicts
    idle_mb = 400

    assert get_settings().queue_max_size * workers * worst_signal_kb / 1024 + idle_mb < mem_mb


def test_the_backend_can_be_scaled_and_recreated():
    """M4: a fixed container_name stops `--scale`."""
    assert not re.search(r"^\s*container_name:", service("backend"), re.M)


def test_redis_evicts_only_keys_with_a_ttl():
    """Rate-limit counters and caches have TTLs; generation counters do not and must never be evicted."""
    command = service("redis")
    assert "--maxmemory " in command and "--maxmemory-policy volatile-lru" in command


def test_nginx_re_resolves_the_backend_after_it_is_recreated():
    """M4: `proxy_pass http://backend:8000` resolves once at startup, so a recreated backend got 502s (seen live)."""
    conf = NGINX.read_text()
    assert re.search(r"^\s*resolver 127\.0\.0\.11 valid=\d+s\b[^;]*;", conf, re.M)
    assert "proxy_pass http://backend" not in conf
    assert re.findall(r"proxy_pass\s+(\S+);", conf) == ["$backend"] * 3


def test_nginx_never_caches_index_html():
    """A cached index.html keeps pointing at the old bundle after a deploy. `expires`, not add_header, so the
    server-level security headers still apply."""
    spa = re.search(r"location / \{(.*?)\}", NGINX.read_text(), re.S).group(1)
    assert re.search(r"^\s*expires -1;", spa, re.M)
    assert "add_header" not in spa


def test_nginx_trusts_forwarded_for_only_from_caddy():
    """Behind Caddy every request reaches nginx from Caddy's IP, so without real_ip the login limit would count one
    IP for all users. nginx trusts the header from Caddy's pinned address only; anything else that reaches nginx
    (the loopback port, another container) arrives from a different address and its header is ignored."""
    compose, conf = COMPOSE.read_text(), NGINX.read_text()
    caddy = service("caddy")
    assert re.search(r'profiles:\s*\["tls"\]', caddy)  # local `docker compose up` stays plain HTTP
    caddy_ip = re.search(r"ipv4_address:\s*([\d.]+)", caddy).group(1)
    assert re.findall(r"^\s*set_real_ip_from\s+(\S+);", conf, re.M) == [caddy_ip]
    assert re.search(r"^\s*real_ip_header\s+X-Forwarded-For;", conf, re.M)
    # The frontend joins `edge` first; a dynamic address could take Caddy's, and Caddy then fails to start (seen live).
    subnet, pool = (ipaddress.ip_network(re.search(rf"{k}:\s*([\d./]+)", compose).group(1)) for k in ("subnet", "ip_range"))
    assert ipaddress.ip_address(caddy_ip) in subnet and ipaddress.ip_address(caddy_ip) not in pool


def test_deploy_fetches_every_monitoring_file_compose_mounts():
    """deploy.sh downloads monitoring/ file by file; a new dashboard or rule file left off its list never reaches
    the box, and Prometheus or Grafana starts without it."""
    deploy = (ROOT / "infra" / "deploy.sh").read_text()
    wanted = {str(p.relative_to(ROOT)) for p in (ROOT / "monitoring").rglob("*")
              if p.is_file() and not p.name.endswith(".test.yml")}
    assert wanted and all(f in deploy for f in wanted), sorted(f for f in wanted if f not in deploy)
