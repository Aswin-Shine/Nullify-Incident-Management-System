import { useState, useEffect } from "react";
import {
  fetchWorkItem,
  fetchSignals,
  updateStatus,
  assignWorkItem,
  listUsers,
} from "../api/client";
import { PriorityBadge, StatusBadge } from "./Badges";
import { RCAForm } from "./RCAForm";
import { CommentsSection } from "./CommentsSection";
import { formatDistanceToNow, formatDistance, isPast } from "date-fns";
import { useAuth } from "../context/AuthContext";

const TRANSITIONS = {
  OPEN: ["INVESTIGATING"],
  INVESTIGATING: ["RESOLVED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

function SLATimer({ deadline, status }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!deadline || ["RESOLVED", "CLOSED"].includes(status)) return null;
  const dl = new Date(deadline);
  const breached = isPast(dl);
  const dist = formatDistance(dl, now, { addSuffix: !breached });
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        color: breached ? "var(--p0)" : "var(--p2)",
        background: breached ? "var(--p0-bg)" : "rgba(245,197,24,0.08)",
        border: `1px solid ${breached ? "var(--p0)44" : "var(--p2)44"}`,
        padding: "2px 8px",
        borderRadius: 3,
        animation: breached ? "pulse 1.5s infinite" : "none",
      }}
    >
      {breached ? `⚠ SLA BREACHED ${dist}` : `⏱ SLA: ${dist}`}
    </span>
  );
}

export function IncidentDetail({ id, onRefresh }) {
  const { user } = useAuth();
  const [item, setItem] = useState(null);
  const [signals, setSignals] = useState([]);
  const [tab, setTab] = useState("overview");
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState("");
  const [users, setUsers] = useState([]);

  const canWrite = user?.role === "sre" || user?.role === "admin";

  const load = async () => {
    if (!id) return;
    const [wi, sigs] = await Promise.all([fetchWorkItem(id), fetchSignals(id)]);
    setItem(wi);
    setSignals(sigs);
  };

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    if (canWrite)
      listUsers()
        .then(setUsers)
        .catch(() => {});
  }, [canWrite]);

  const doTransition = async (newStatus) => {
    setError("");
    setTransitioning(true);
    try {
      await updateStatus(id, newStatus);
      await load();
      onRefresh?.();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed");
    } finally {
      setTransitioning(false);
    }
  };

  const doAssign = async (assigneeId) => {
    try {
      await assignWorkItem(id, assigneeId || null);
      await load();
      onRefresh?.();
    } catch (e) {
      setError(e.response?.data?.detail || "Assign failed");
    }
  };

  if (!id)
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}
      >
        ← select incident
      </div>
    );
  if (!item)
    return (
      <div
        style={{
          padding: 24,
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}
      >
        loading...
      </div>
    );

  const nextStates = TRANSITIONS[item.status] || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <PriorityBadge priority={item.priority} />
          <StatusBadge status={item.status} />
          <SLATimer deadline={item.sla_deadline} status={item.status} />
        </div>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>
          {item.title}
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-2)",
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{item.component}</span>
          <span>
            {formatDistanceToNow(new Date(item.created_at), {
              addSuffix: true,
            })}
          </span>
          {item.mttr_seconds && (
            <span style={{ color: "var(--p3)" }}>
              MTTR: {Math.round(item.mttr_seconds / 60)}m
            </span>
          )}
          {item.assignee_username ? (
            <span style={{ color: "var(--accent)" }}>
              👤 {item.assignee_username}
            </span>
          ) : (
            <span style={{ color: "var(--text-2)" }}>unassigned</span>
          )}
        </div>
        {item.description && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: "var(--text-1)",
              fontStyle: "italic",
            }}
          >
            {item.description}
          </div>
        )}

        {/* Actions */}
        {canWrite && (
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {nextStates.map((s) => (
              <button
                key={s}
                onClick={() => doTransition(s)}
                disabled={transitioning}
                style={{
                  padding: "6px 14px",
                  borderRadius: 3,
                  fontSize: 11,
                  background:
                    s === "CLOSED"
                      ? "rgba(92,98,117,0.15)"
                      : "var(--accent-bg)",
                  color: s === "CLOSED" ? "#5c6275" : "var(--accent-hover)",
                  border: `1px solid ${s === "CLOSED" ? "#5c6275" : "var(--accent)"}`,
                  opacity: transitioning ? 0.5 : 1,
                }}
              >
                → {s}
              </button>
            ))}
            {users.length > 0 && (
              <select
                value={item.assignee_id || ""}
                onChange={(e) => doAssign(e.target.value)}
                style={{ fontSize: 11, padding: "5px 10px", width: "auto" }}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {error && (
          <div
            style={{
              marginTop: 8,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--p0)",
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
        }}
      >
        {["overview", "signals", "comments", "rca"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "10px 16px",
              fontSize: 11,
              fontFamily: "var(--mono)",
              letterSpacing: "0.08em",
              background: "transparent",
              color: tab === t ? "var(--text-0)" : "var(--text-2)",
              borderBottom:
                tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              borderRadius: 0,
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "overview" && (
          <div style={{ padding: 16 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              {[
                ["ID", item.id.slice(0, 8) + "..."],
                ["Component", item.component],
                ["Assignee", item.assignee_username || "—"],
                ["Priority", item.priority],
                ["Start Time", new Date(item.start_time).toLocaleString()],
                [
                  "End Time",
                  item.end_time
                    ? new Date(item.end_time).toLocaleString()
                    : "—",
                ],
                [
                  "SLA Deadline",
                  item.sla_deadline
                    ? new Date(item.sla_deadline).toLocaleString()
                    : "—",
                ],
                [
                  "MTTR",
                  item.mttr_seconds
                    ? `${Math.round(item.mttr_seconds / 60)}m`
                    : "—",
                ],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      color: "var(--text-2)",
                      marginBottom: 4,
                    }}
                  >
                    {k}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--text-0)",
                      wordBreak: "break-all",
                    }}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "signals" && (
          <div style={{ padding: 12 }}>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "var(--text-2)",
                marginBottom: 8,
              }}
            >
              {signals.length} SIGNALS
            </div>
            {signals.length === 0 && (
              <div
                style={{
                  color: "var(--text-2)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}
              >
                no signals yet
              </div>
            )}
            {[...signals].reverse().map((s, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 8,
                  padding: "10px 12px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  borderLeft: "3px solid var(--p1)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      color: "var(--p1)",
                    }}
                  >
                    {s.signal_type}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      color: "var(--text-2)",
                    }}
                  >
                    {s.timestamp
                      ? new Date(s.timestamp).toLocaleTimeString()
                      : ""}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-1)" }}>
                  {s.message}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "comments" && <CommentsSection wiId={id} />}
        {tab === "rca" && (
          <RCAForm
            workItem={item}
            onSuccess={() => {
              load();
              onRefresh?.();
            }}
          />
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}
