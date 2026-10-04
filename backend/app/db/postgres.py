"""PostgreSQL — async SQLAlchemy engine + ORM models."""
from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy import (
    BigInteger, String, Integer, Text, DateTime, ForeignKey,
    CheckConstraint, Index, UniqueConstraint, text
)
from sqlalchemy.dialects.postgresql import JSONB
from app.core.config import get_settings
import uuid

settings = get_settings()

engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
    echo=settings.debug,
)

AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


ACTIVE_WHERE = "status IN ('OPEN','INVESTIGATING')"


class WorkItem(Base):
    __tablename__ = "work_items"
    __table_args__ = (
        CheckConstraint("priority IN ('P0','P1','P2','P3')", name="ck_priority"),
        CheckConstraint("status IN ('OPEN','INVESTIGATING','RESOLVED','CLOSED')", name="ck_status"),
        Index("ix_work_items_status", "status"),
        Index("ix_work_items_priority", "priority"),
        Index("ix_work_items_component", "component"),
        # Debounce: at most one active incident per component, enforced across all processes.
        Index("ux_wi_active_component", "component", unique=True,
              postgresql_where=text(ACTIVE_WHERE)),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    component: Mapped[str] = mapped_column(String(128), nullable=False)
    priority: Mapped[str] = mapped_column(String(2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    assignee_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # RCA submission
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mttr_seconds: Mapped[int | None] = mapped_column(Integer)
    sla_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    signal_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_signal_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    rca: Mapped[RCARecord | None] = relationship("RCARecord", back_populates="work_item", uselist=False)
    comments: Mapped[list[Comment]] = relationship("Comment", back_populates="work_item", cascade="all, delete-orphan")
    assignee: Mapped[User | None] = relationship("User", back_populates="assigned_incidents", foreign_keys=[assignee_id])


class RCARecord(Base):
    __tablename__ = "rca_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    work_item_id: Mapped[str] = mapped_column(String(36), ForeignKey("work_items.id", ondelete="CASCADE"), unique=True)
    incident_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    incident_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    root_cause_category: Mapped[str] = mapped_column(String(64))
    fix_applied: Mapped[str] = mapped_column(Text)
    prevention_steps: Mapped[str] = mapped_column(Text)
    submitted_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"))
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    work_item: Mapped[WorkItem] = relationship("WorkItem", back_populates="rca")


class TimeseriesAgg(Base):
    __tablename__ = "timeseries_agg"
    __table_args__ = (
        UniqueConstraint("bucket", "component", name="uq_ts_bucket_component"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bucket: Mapped[str] = mapped_column(String(20), nullable=False)
    component: Mapped[str] = mapped_column(String(128), nullable=False)
    signal_count: Mapped[int] = mapped_column(Integer, default=0)


class Signal(Base):
    """Raw signal linked to the Work Item it was debounced into (queryable per incident)."""
    __tablename__ = "signals"
    __table_args__ = (
        Index("ix_signals_work_item_occurred", "work_item_id", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    work_item_id: Mapped[str] = mapped_column(String(36), ForeignKey("work_items.id", ondelete="CASCADE"))
    component: Mapped[str] = mapped_column(String(128))
    signal_type: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str | None] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONB)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_email", "email", unique=True),
        Index("ix_users_username", "username", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(256), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="viewer")  # admin | sre | viewer
    api_key_hash: Mapped[str | None] = mapped_column(String(64), unique=True)  # sha256; the key is shown once
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # bump to revoke tokens
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # set when an admin deletes the account

    assigned_incidents: Mapped[list[WorkItem]] = relationship(
        "WorkItem", back_populates="assignee", foreign_keys="WorkItem.assignee_id"
    )


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (
        Index("ix_comments_work_item_id", "work_item_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    work_item_id: Mapped[str] = mapped_column(String(36), ForeignKey("work_items.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    work_item: Mapped[WorkItem] = relationship("WorkItem", back_populates="comments")
    author: Mapped[User] = relationship("User")


class WorkItemEvent(Base):
    """History of a Work Item: written in the same transaction as the change it records."""
    __tablename__ = "work_item_events"
    __table_args__ = (
        Index("ix_wi_events_work_item_created", "work_item_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    work_item_id: Mapped[str] = mapped_column(String(36), ForeignKey("work_items.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20))  # created | status | assigned | rca_submitted
    actor_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"))  # null = system
    from_value: Mapped[str | None] = mapped_column(String(64))
    to_value: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    actor: Mapped[User | None] = relationship("User")


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
