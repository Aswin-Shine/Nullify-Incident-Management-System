#!/bin/bash
# start.sh — launches backend + frontend for local dev (no Docker needed)

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "================================================"
echo "  IMS — Incident Management System"
echo "================================================"

# ── Backend ──────────────────────────────────────────
echo ""
echo "[1/2] Starting backend (FastAPI on :8000)..."
cd "$ROOT/backend"

if [ ! -d ".venv" ]; then
  echo "  Creating virtualenv..."
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt -q
else
  source .venv/bin/activate
fi

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
echo "  Backend PID: $BACKEND_PID"

# wait for backend
sleep 2

# ── Frontend ─────────────────────────────────────────
echo ""
echo "[2/2] Starting frontend (Vite on :5173)..."
cd "$ROOT/frontend"
npm install -q
npm run dev &
FRONTEND_PID=$!
echo "  Frontend PID: $FRONTEND_PID"

echo ""
echo "================================================"
echo "  Dashboard: http://localhost:5173"
echo "  API docs:  http://localhost:8000/docs"
echo "  Health:    http://localhost:8000/health"
echo ""
echo "  To inject mock failure events:"
echo "  python mock_events.py"
echo ""
echo "  Press Ctrl+C to stop both servers"
echo "================================================"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
