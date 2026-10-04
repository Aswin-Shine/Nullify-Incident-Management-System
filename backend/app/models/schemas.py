"""Pydantic schemas for Nullify."""
from __future__ import annotations
import json
import re
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from typing import Optional, Literal
from datetime import datetime, timezone

Priority = Literal["P0", "P1", "P2", "P3"]
Status = Literal["OPEN", "INVESTIGATING", "RESOLVED", "CLOSED"]
Role = Literal["admin", "sre", "viewer"]

ROOT_CAUSE_CATEGORIES = [
    "Infrastructure Failure", "Code Defect", "Configuration Error",
    "Dependency Outage", "Capacity Exhaustion", "Security Incident",
    "Human Error", "Unknown",
]

# ── Auth ──────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    """Admin-only (accounts are invite-only)."""
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{3,64}$")
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    role: Role = "viewer"

class UserUpdate(BaseModel):
    role: Optional[Role] = None
    is_active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=12, max_length=128)  # admin reset

class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=128)

class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    role: str
    is_active: bool
    created_at: datetime
    has_api_key: bool = False  # never the key or its hash

class UserPublic(BaseModel):
    """What SREs need to pick an assignee: never keys, hashes or emails."""
    id: str
    username: str
    role: str

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    """The refresh token travels only in the httpOnly cookie, never in a body."""
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

class ApiKeyResponse(BaseModel):
    api_key: str  # shown once; only its sha256 is stored

# ── Signals ───────────────────────────────────────────────────────────────

MAX_METADATA_BYTES = 8192
_COMPONENT_ID = re.compile(r"[A-Z0-9][A-Z0-9_.-]{0,63}")

ComponentType = Literal["RDBMS", "CACHE", "QUEUE", "API", "MCP"]

class SignalPayload(BaseModel):
    component_id: str
    component_type: Optional[ComponentType] = None  # picks priority and channels; else inferred from the name
    signal_type: str = Field(max_length=64)
    message: str = Field(max_length=4096)
    severity: Optional[str] = Field("MEDIUM", max_length=32)
    metadata: Optional[dict] = {}
    timestamp: Optional[datetime] = None  # producer event time; ingestion clamps future values

    @field_validator("component_id")
    @classmethod
    def valid_component(cls, v: str) -> str:
        v = v.strip().upper()
        if not _COMPONENT_ID.fullmatch(v):  # also becomes a lake file name
            raise ValueError("component_id must be 1-64 chars of A-Z, 0-9, '_', '.', '-'")
        return v

    @field_validator("metadata")
    @classmethod
    def bounded_metadata(cls, v: Optional[dict]) -> Optional[dict]:
        if v and len(json.dumps(v, default=str)) > MAX_METADATA_BYTES:
            raise ValueError(f"metadata must serialize to at most {MAX_METADATA_BYTES} bytes")
        return v

# ── Work Items ────────────────────────────────────────────────────────────

class WorkItemCreate(BaseModel):
    component: str
    priority: Priority
    title: str
    description: Optional[str] = None

class WorkItemResponse(BaseModel):
    id: str
    component: str
    priority: Priority
    status: Status
    title: str
    description: Optional[str]
    assignee_id: Optional[str]
    assignee_username: Optional[str] = None
    start_time: datetime
    end_time: Optional[datetime]
    resolved_at: Optional[datetime] = None
    mttr_seconds: Optional[int]
    sla_deadline: Optional[datetime]
    sla_breached: bool = False
    signal_count: int = 0
    last_signal_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

class StatusTransition(BaseModel):
    new_status: Status

class AssignRequest(BaseModel):
    assignee_id: Optional[str] = None  # None = unassign

# ── RCA ───────────────────────────────────────────────────────────────────

class RCASubmit(BaseModel):
    incident_start: datetime
    incident_end: datetime
    root_cause_category: str
    fix_applied: str
    prevention_steps: str

    @field_validator("incident_start", "incident_end")
    @classmethod
    def assume_utc(cls, v: datetime) -> datetime:
        # The UI's datetime-local input has no offset (F-06); treat naive values as UTC.
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)

    @model_validator(mode="after")
    def end_not_before_start(self) -> "RCASubmit":
        if self.incident_end < self.incident_start:
            raise ValueError("incident_end must not be before incident_start")
        return self

    @field_validator("root_cause_category")
    @classmethod
    def valid_category(cls, v: str) -> str:
        if v not in ROOT_CAUSE_CATEGORIES:
            raise ValueError(f"Invalid category. Choose from: {ROOT_CAUSE_CATEGORIES}")
        return v

    @field_validator("fix_applied", "prevention_steps")
    @classmethod
    def non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field cannot be blank")
        v = v.strip()
        if len(v) > 8000:
            raise ValueError("Field must be at most 8000 characters")
        return v

class RCAResponse(BaseModel):
    id: str
    work_item_id: str
    incident_start: datetime
    incident_end: datetime
    root_cause_category: str
    fix_applied: str
    prevention_steps: str
    submitted_by: Optional[str]
    submitted_at: datetime

# ── Comments ──────────────────────────────────────────────────────────────

class CommentCreate(BaseModel):
    body: str

    @field_validator("body")
    @classmethod
    def non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Comment cannot be blank")
        v = v.strip()
        if len(v) > 4000:
            raise ValueError("Comment must be at most 4000 characters")
        return v

class CommentResponse(BaseModel):
    id: str
    work_item_id: str
    author_id: str
    author_username: Optional[str] = None
    body: str
    created_at: datetime

class WorkItemEventResponse(BaseModel):
    id: str
    kind: str
    from_value: Optional[str]
    to_value: Optional[str]
    actor_username: Optional[str]  # None = the system
    created_at: datetime

# ── Analytics ─────────────────────────────────────────────────────────────

class MTTRStats(BaseModel):
    component: Optional[str]
    avg_mttr_seconds: Optional[float]
    min_mttr_seconds: Optional[int]
    max_mttr_seconds: Optional[int]
    incident_count: int

class SLAStats(BaseModel):
    total: int
    breached: int
    breach_rate_pct: float
    open_by_priority: dict[str, int] = {}