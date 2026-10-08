"""Admin CLI. Accounts are invite-only; use this to create the first admin.

    python -m app.cli create-user --username alice --email alice@example.com --role admin
    python -m app.cli replay-lake --since 2026-10-07 [--dry-run]

The password is prompted for (or read from stdin with --password-stdin). replay-lake stores the signals that
reached only the lake audit log (work_item_id null: a non-transient DB error, or a spill at shutdown). Run from
`backend/` (or inside the backend container) with the same env as the app.
"""
from __future__ import annotations
import argparse
import asyncio
import getpass
import sys
from collections import Counter
from datetime import datetime

from app.db.cache import close_redis, init_redis
from app.db.nosql import read_lake
from app.db.postgres import AsyncSessionLocal
from app.models.schemas import UserCreate
from app.services import ingestion, webhooks
from app.services.user_service import create_account


async def create_user(username: str, email: str, password: str, role: str) -> str:
    data = UserCreate(username=username, email=email, password=password, role=role)  # API validation rules
    async with AsyncSessionLocal() as db:
        user = await create_account(db, data, created_by="cli")
    return user.id


async def replay_lake(since: str, dry_run: bool = False) -> Counter:
    """Store the lake lines from `since` (YYYY-MM-DD) on that never reached Postgres, with their original times,
    through the normal ingest path (so an outage waits, a new incident pages). A line whose signal is already stored
    is skipped, so a rerun is safe. Open dashboards show the result on their next refresh: this process has no
    WebSocket listener."""
    counts = Counter(replayed=0, skipped=0, failed=0, to_replay=0)
    pending = [line for line in read_lake(since) if line.get("work_item_id") is None]  # before replay appends more
    for line in pending:
        if await ingestion.already_stored(line):
            counts["skipped"] += 1
        elif dry_run:
            counts["to_replay"] += 1
        else:
            signal = {k: v for k, v in line.items() if k != "work_item_id"}
            counts["replayed" if await ingestion.process_signal(signal) else "failed"] += 1
    await webhooks.drain(30)  # pages are background tasks: send them before the process exits
    return counts


async def _replay(since: str, dry_run: bool) -> Counter:
    await init_redis()  # cache invalidation for the dashboard
    try:
        return await replay_lake(since, dry_run)
    finally:
        await close_redis()


def _day(value: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    cu = sub.add_parser("create-user", help="create an account")
    cu.add_argument("--username", required=True)
    cu.add_argument("--email", required=True)
    cu.add_argument("--role", choices=["admin", "sre", "viewer"], default="viewer")
    cu.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    rl = sub.add_parser("replay-lake", help="store lake signals that never reached Postgres")
    rl.add_argument("--since", required=True, type=_day, help="first UTC day to scan, YYYY-MM-DD")
    rl.add_argument("--dry-run", action="store_true", help="count what would be replayed, change nothing")
    args = parser.parse_args(argv)

    if args.command == "replay-lake":
        counts = asyncio.run(_replay(args.since, args.dry_run))
        print(", ".join(f"{k} {v}" for k, v in counts.items()))
        return 1 if counts["failed"] else 0

    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("Password (min 12 chars): ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords do not match", file=sys.stderr)
            return 1
    try:
        user_id = asyncio.run(create_user(args.username, args.email, password, args.role))
    except ValueError as e:  # duplicate account or failed validation
        print(f"Error: {e}", file=sys.stderr)
        return 1
    print(f"Created {args.role} {args.username} ({user_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
