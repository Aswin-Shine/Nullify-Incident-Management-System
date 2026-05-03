# ⚡ Incident Management System (IMS)

Mission-critical incident management for distributed stacks — built to handle 10,000 signals/sec with intelligent debouncing, state-machine-driven workflows, and mandatory RCA before closure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SIGNAL SOURCES                          │
│  APIs · MCP Hosts · Cache Clusters · Queues · RDBMS · NoSQL    │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTP POST /api/signals (rate-limited)
                        ▼
┌───────────────────────────────────────────────────────────────┐
│                    INGESTION LAYER (FastAPI)                    │
│  Rate Limiter (slowapi 1000/min) → asyncio.Queue (50k cap)    │
│                  4 async worker tasks                           │
│        Throughput metric printed every 5 seconds               │
└──────────┬──────────────────────┬─────────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────────┐
│  DATA LAKE       │   │  DEBOUNCE ENGINE                     │
│  (JSON / JSONL)  │   │  100 signals / component / 10s       │
│  Raw signal      │   │  → single Work Item                  │
│  audit log       │   │  Strategy Pattern → P0–P3 priority   │
│  per component   │   └──────────────┬───────────────────────┘
└──────────────────┘                  │
                                      ▼
                        ┌─────────────────────────────────┐
                        │  SOURCE OF TRUTH (SQLite WAL)   │
                        │  work_items · rca_records        │
                        │  timeseries_agg                  │
                        │  Transactional · Retry (3x)      │
                        └──────────────┬──────────────────┘
                                       │
                        ┌──────────────▼──────────────────┐
                        │  HOT-PATH CACHE (in-memory)     │
                        │  WI list + per-item cache        │
                        │  Invalidated on every update     │
                        └──────────────┬──────────────────┘
                                       │ WebSocket broadcast
                                       ▼
                        ┌─────────────────────────────────┐
                        │  REACT DASHBOARD (Vite :5173)   │
                        │  Live feed · Detail · RCA form   │
                        └─────────────────────────────────┘
```

---

## Design Patterns

| Pattern           | Where Used                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- |
| **Strategy**      | `AlertStrategy` — per-component priority (P0 RDBMS, P2 Cache, P1 Queue…)           |
| **State Machine** | `WorkItemState` — OPEN→INVESTIGATING→RESOLVED→CLOSED, invalid transitions rejected |

---

## Tech Stack

| Layer              | Choice                                | Why                                      |
| ------------------ | ------------------------------------- | ---------------------------------------- |
| Backend            | FastAPI + asyncio                     | Async-native, WebSocket support, fast    |
| Source of Truth    | PostgreSQL (asyncpg + SQLAlchemy)     | Transactional, production-grade, async   |
| Data Lake          | JSONL files per component             | Append-only, queryable, no DB overhead   |
| Hot Cache          | Redis (aioredis)                      | Fast key-value cache, TTL support        |
| Timeseries         | PostgreSQL aggregations table         | Simple bucket aggregations               |
| Queue/Backpressure | `asyncio.Queue(maxsize=50000)`        | Native, no external broker               |
| Rate Limiting      | slowapi                               | FastAPI-native, per-IP                   |
| Auth               | JWT + API keys (python-jose, passlib) | Stateless, role-based (admin/sre/viewer) |
| Observability      | Prometheus + OpenTelemetry            | Metrics + distributed tracing            |
| Frontend           | React + Vite                          | Fast HMR, component model                |

---

## Local Setup

### Prerequisites

- Python ≥ 3.11
- Node ≥ 18
- PostgreSQL ≥ 14 (running locally or via Docker)
- Redis ≥ 6 (running locally or via Docker)

### 1. Configure environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env — set DB_USER, DB_PASSWORD, DB_NAME, etc.
```

### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE ims;"
```

### 3. Quick start (one command)

```bash
chmod +x start.sh
./start.sh
```

Then open **http://localhost:5173**

### Manual start

**Backend:**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend (separate terminal):**

```bash
cd frontend
npm install
npm run dev
```

**API docs:** http://localhost:8000/docs

---

## Run Tests

```bash
cd backend
source .venv/bin/activate
pytest tests/ -v
```

15 tests — state machine transitions, RCA validation, alert strategy priorities.

---

## Simulate a Failure Event

```bash
# With backend running:
python mock_events.py
```

Simulates: RDBMS primary down → replica lag → MCP cascade → cache miss storm → API 5xx → queue backup.
Also runs a 110-signal burst to demonstrate debounce (produces 1 Work Item).

---

## Incident Workflow

```
OPEN → INVESTIGATING → RESOLVED → CLOSED
                                    ↑
                              Requires RCA
                         (rejected without it)
```

- **OPEN**: Work Item created automatically when signal threshold triggered
- **INVESTIGATING**: Assignee picks it up
- **RESOLVED**: Fix applied
- **CLOSED**: Blocked until RCA form is complete (root cause + fix + prevention steps)
- **MTTR**: Auto-calculated from `start_time` (first signal) to `end_time` (RCA submission)

---

## How Backpressure Is Handled

The ingestion API never blocks callers. All signals are placed on an `asyncio.Queue(maxsize=50_000)`:

1. **Producer** (`POST /api/signals`): calls `queue.put_nowait()`. If full → returns HTTP 429 immediately. The caller knows to retry.
2. **Workers** (4 async tasks): drain the queue independently. Slow DB writes don't stall ingestion — they just fall behind.
3. **Debounce lock**: a single `asyncio.Lock` serialises Work Item creation per component window. No duplicate WIs even under burst.
4. **Rate limiter** (slowapi, 1000 req/min per IP): sits upstream — prevents a single noisy client from flooding the queue.
5. **Throughput metric**: logged every 5 seconds to stdout — signals/sec + queue depth.

If the queue hits capacity, signals are dropped (logged as warnings) rather than crashing the process. The data lake (JSONL) can tolerate gaps; the Work Item already exists for investigation.

---

## API Reference

| Method | Endpoint                       | Description                |
| ------ | ------------------------------ | -------------------------- |
| POST   | `/api/signals`                 | Ingest single signal       |
| POST   | `/api/signals/batch`           | Ingest batch (max 500)     |
| GET    | `/api/work-items`              | List all work items        |
| GET    | `/api/work-items/{id}`         | Get work item detail       |
| GET    | `/api/work-items/{id}/signals` | Raw signals from data lake |
| PATCH  | `/api/work-items/{id}/status`  | Transition status          |
| POST   | `/api/work-items/{id}/rca`     | Submit RCA                 |
| GET    | `/api/work-items/{id}/rca`     | Get RCA record             |
| GET    | `/api/timeseries`              | Signal aggregations        |
| GET    | `/health`                      | Health + queue depth       |
| WS     | `/ws`                          | Live event stream          |

---

## Repository Structure

```
ims/
├── backend/
│   ├── app/
│   │   ├── core/
│   │   │   ├── config.py      # Pydantic settings (reads .env)
│   │   │   ├── deps.py        # FastAPI auth dependencies
│   │   │   ├── logging.py     # Structured JSON logging
│   │   │   └── security.py    # JWT + password hashing
│   │   ├── db/
│   │   │   ├── postgres.py    # SQLAlchemy ORM models + engine
│   │   │   ├── nosql.py       # Data lake (JSONL append-only)
│   │   │   └── cache.py       # Redis hot-path cache
│   │   ├── middleware/
│   │   │   └── observability.py  # Prometheus + OpenTelemetry
│   │   ├── models/
│   │   │   └── schemas.py     # Pydantic request/response schemas
│   │   ├── routers/
│   │   │   ├── auth.py        # Register, login, JWT refresh
│   │   │   ├── signals.py     # Ingestion API
│   │   │   ├── work_items.py  # Work item CRUD + comments + RCA
│   │   │   ├── health.py      # /health + /api/timeseries
│   │   │   └── ws.py          # WebSocket endpoint
│   │   ├── services/
│   │   │   ├── alert_strategy.py    # Strategy pattern (P0–P3 priority)
│   │   │   ├── state_machine.py     # State pattern (OPEN→…→CLOSED)
│   │   │   ├── ingestion.py         # Queue + debounce + workers
│   │   │   ├── work_item_service.py # CRUD + SLA + analytics
│   │   │   ├── webhooks.py          # Slack + PagerDuty notifications
│   │   │   └── ws_manager.py        # WebSocket broadcast
│   │   └── main.py
│   ├── alembic/               # DB migrations
│   ├── tests/
│   │   ├── test_core.py       # Unit tests (state machine, RCA, strategy)
│   │   └── test_integration.py # Integration tests (full lifecycle)
│   ├── .env.example           # Environment variable template
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── components/        # IncidentList, IncidentDetail, RCAForm, etc.
│       ├── context/           # AuthContext
│       ├── hooks/             # useWebSocket
│       ├── api/               # Axios client
│       └── App.jsx            # Main layout
├── mock_events.py             # Failure simulation script
├── start.sh                   # One-command local start
└── README.md
```

---

## Bonus Features

- **WebSocket live push** — dashboard updates in real-time without polling
- **Signal Injector UI** — inject custom signals or simulate full outage from the dashboard
- **Simulate Outage button** — one-click RDBMS→MCP cascade for demos
- **Debounce burst test** — `mock_events.py` sends 110 signals to verify single WI creation
- **Timeseries API** — `/api/timeseries` for signal volume by component+bucket
