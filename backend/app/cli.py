"""Admin CLI. Accounts are invite-only; use this to create the first admin.

    python -m app.cli create-user --username alice --email alice@example.com --role admin

The password is prompted for (or read from stdin with --password-stdin). Run from `backend/`
(or inside the backend container) with the same env as the app.
"""
from __future__ import annotations
import argparse
import asyncio
import getpass
import sys

from app.db.postgres import AsyncSessionLocal
from app.models.schemas import UserCreate
from app.services.user_service import create_account


async def create_user(username: str, email: str, password: str, role: str) -> str:
    data = UserCreate(username=username, email=email, password=password, role=role)  # API validation rules
    async with AsyncSessionLocal() as db:
        user = await create_account(db, data, created_by="cli")
    return user.id


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    cu = sub.add_parser("create-user", help="create an account")
    cu.add_argument("--username", required=True)
    cu.add_argument("--email", required=True)
    cu.add_argument("--role", choices=["admin", "sre", "viewer"], default="viewer")
    cu.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    args = parser.parse_args(argv)

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
