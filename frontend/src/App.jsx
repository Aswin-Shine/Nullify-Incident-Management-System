import { useState, useCallback } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./components/LoginPage";
import { IncidentList } from "./components/IncidentList";
import { IncidentDetail } from "./components/IncidentDetail";
import { HealthBar } from "./components/HealthBar";
import { SignalInjector } from "./components/SignalInjector";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { useWebSocket } from "./hooks/useWebSocket";

function Dashboard() {
  const { user, logout } = useAuth();
  const [selectedId, setSelectedId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [liveEvents, setLiveEvents] = useState([]);
  const [view, setView] = useState("incidents"); // incidents | analytics | inject

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useWebSocket((msg) => {
    refresh();
    const label =
      msg.event === "signal_ingested"
        ? `signal → ${msg.component}`
        : msg.event === "work_item_updated"
          ? `status → ${msg.status}`
          : msg.event === "rca_submitted"
            ? "RCA submitted"
            : msg.event === "comment_added"
              ? "comment added"
              : msg.event;
    setLiveEvents((ev) => [label, ...ev].slice(0, 5));
  });

  const canInject = user?.role === "sre" || user?.role === "admin";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          height: 48,
          background: "var(--bg-1)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              background: "var(--accent)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            ⚡
          </div>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "0.05em",
            }}
          >
            IMS
          </span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--text-2)",
              letterSpacing: "0.1em",
            }}
          >
            INCIDENT MANAGEMENT
          </span>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {[
            { id: "incidents", label: "INCIDENTS" },
            { id: "analytics", label: "ANALYTICS" },
            ...(canInject ? [{ id: "inject", label: "INJECT" }] : []),
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              style={{
                padding: "5px 12px",
                borderRadius: 3,
                fontSize: 10,
                fontFamily: "var(--mono)",
                background: view === id ? "var(--accent-bg)" : "transparent",
                color: view === id ? "var(--accent-hover)" : "var(--text-2)",
                border: `1px solid ${view === id ? "var(--accent)" : "var(--border)"}`,
              }}
            >
              {label}
            </button>
          ))}

          {/* User pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginLeft: 8,
              padding: "4px 10px",
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "var(--text-1)",
              }}
            >
              @{user?.username}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                color: "var(--accent)",
                background: "var(--accent-bg)",
                padding: "1px 5px",
                borderRadius: 2,
              }}
            >
              {user?.role}
            </span>
            <button
              onClick={logout}
              style={{
                background: "transparent",
                color: "var(--text-2)",
                fontSize: 10,
                fontFamily: "var(--mono)",
              }}
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <HealthBar liveEvents={liveEvents} />

      {view === "analytics" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <AnalyticsPanel />
        </div>
      )}

      {view === "inject" && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <div style={{ maxWidth: 480, padding: 8 }}>
            <SignalInjector onSent={refresh} />
          </div>
        </div>
      )}

      {view === "incidents" && (
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div
            style={{
              width: 320,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <IncidentList
              onSelect={(id) => setSelectedId(id)}
              selectedId={selectedId}
              refreshTick={refreshTick}
            />
          </div>
          <div
            style={{
              flex: 1,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <IncidentDetail id={selectedId} onRefresh={refresh} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

function AppInner() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg-0)",
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}
      >
        loading...
      </div>
    );
  return user ? <Dashboard /> : <LoginPage />;
}
