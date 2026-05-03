"""Pydantic schemas for IMS."""
from __future__ import annotations
from pydantic import BaseModel, field_validator, EmailStr
from typing import Optional, Literal
from datetime import datetime

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
    username: str
    email: str
    password: str
    role: Role = "viewer"

class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    role: str
    is_active: bool
    created_at: datetime
    api_key: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse

class RefreshRequest(BaseModel):
    refresh_token: str

# ── Signals ───────────────────────────────────────────────────────────────

class SignalPayload(BaseModel):
    component_id: str
    signal_type: str
    message: str
    severity: Optional[str] = "MEDIUM"
    metadata: Optional[dict] = {}
    timestamp: Optional[str] = None

    @field_validator("component_id")
    @classmethod
    def no_empty_component(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("component_id cannot be blank")
        return v.strip().upper()

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
    mttr_seconds: Optional[int]
    sla_deadline: Optional[datetime]
    sla_breached: bool = False
    created_at: datetime
    updated_at: datetime

class StatusTransition(BaseModel):
    new_status: Status

class AssignRequest(BaseModel):
    assignee_id: Optional[str] = None  # None = unassign

# ── RCA ───────────────────────────────────────────────────────────────────

class RCASubmit(BaseModel):
    incident_start: str
    incident_end: str
    root_cause_category: str
    fix_applied: str
    prevention_steps: str

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
        return v.strip()

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
        return v.strip()

class CommentResponse(BaseModel):
    id: str
    work_item_id: str
    author_id: str
    author_username: Optional[str] = None
    body: str
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