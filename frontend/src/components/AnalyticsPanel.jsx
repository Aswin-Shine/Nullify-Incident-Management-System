import React, { useState, useEffect } from "react";
import {
  fetchMTTR,
  fetchSLA,
  fetchTimeseries,
  fetchWorkItems,
} from "../api/client";

function fmtMTTR(s) {
  if (!s) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function AnalyticsPanel() {
  const [mttr, setMttr] = useState([]);
  const [sla, setSla] = useState(null);
  const [ts, setTs] = useState([]);
  const [workItems, setWorkItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchMTTR(), fetchSLA(), fetchTimeseries(), fetchWorkItems()])
      .then(([m, s, t, wi]) => {
        setMttr(m);
        setSla(s);
        setTs(t);
        setWorkItems(wi);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const breachPct = sla
    ? Math.round((sla.breached / (sla.total || 1)) * 100)
    : 0;
  const breachCol =
    breachPct < 10
      ? "var(--success)"
      : breachPct < 30
        ? "var(--warning)"
        : "var(--error)";
  const maxMTTR = Math.max(...mttr.map((m) => m.avg_mttr_seconds || 0), 1);
  const maxTS = Math.max(...ts.map((t) => t.signal_count || 0), 1);
  const totalSigs = ts.reduce((a, t) => a + (t.signal_count || 0), 0);
  const topComps = [...mttr]
    .sort((a, b) => (b.avg_mttr_seconds || 0) - (a.avg_mttr_seconds || 0))
    .slice(0, 6);
  const openItems = workItems.filter(
    (i) => !["RESOLVED", "CLOSED"].includes(i.status),
  );
  const pCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  openItems.forEach((i) => {
    if (pCounts[i.priority] !== undefined) pCounts[i.priority]++;
  });
  const avgMTTR = mttr.length
    ? mttr.reduce((a, m) => a + (m.avg_mttr_seconds || 0), 0) / mttr.length
    : 0;

  const Card = ({ children, className = "", style = {} }) => (
    <div
      className={`glass ${className}`}
      style={{ borderRadius: 20, padding: 24, ...style }}
    >
      {children}
    </div>
  );

  if (loading)
    return (
      <div className="bento-grid" style={{ overflowY: "auto", flex: 1 }}>
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="shimmer"
            style={{ height: 120, borderRadius: 20 }}
          />
        ))}
      </div>
    );

  return (
    <div
      className="bento-grid"
      style={{ overflowY: "auto", flex: 1, alignContent: "start" }}
    >
      {/* MTTR by Component — tall + wide */}
      <Card className="bento-tall bento-wide">
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
          MTTR by Component
        </h3>
        {topComps.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 160,
              fontSize: 32,
              opacity: 0.2,
            }}
          >
            ∅
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {topComps.map((c) => (
              <div
                key={c.component_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr 60px",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.component_id}
                </span>
                <div
                  style={{
                    height: 8,
                    background: "var(--bg-raised)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${((c.avg_mttr_seconds || 0) / maxMTTR) * 100}%`,
                      height: "100%",
                      background: "var(--accent)",
                      opacity: 0.7,
                      borderRadius: 4,
                      transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtMTTR(c.avg_mttr_seconds)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* SLA Breach Rate */}
      <Card style={{ textAlign: "center" }}>
        <h3
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            fontWeight: 500,
            marginBottom: 12,
          }}
        >
          SLA Breach Rate
        </h3>
        <div
          style={{
            position: "relative",
            width: 80,
            height: 80,
            margin: "0 auto 16px",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              background: `conic-gradient(${breachCol} ${breachPct}%, var(--bg-raised) 0)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "12%",
              left: "12%",
              width: "76%",
              height: "76%",
              borderRadius: "50%",
              background: "var(--bg-surface)",
            }}
          />
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, color: breachCol }}>
          {breachPct}%
        </div>
        <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          of incidents breached SLA
        </p>
      </Card>

      {/* Total Incidents */}
      <Card>
        <h3
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            fontWeight: 500,
            marginBottom: 12,
          }}
        >
          Total Incidents
        </h3>
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            marginBottom: 16,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {sla?.total ?? "—"}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {Object.entries(pCounts).map(([p, n]) => {
            const cols = {
              P0: "var(--p0-color)",
              P1: "var(--p1-color)",
              P2: "var(--p2-color)",
              P3: "var(--p3-color)",
            };
            const bgs = {
              P0: "var(--p0-bg)",
              P1: "var(--p1-bg)",
              P2: "var(--p2-bg)",
              P3: "var(--p3-bg)",
            };
            return (
              <span
                key={p}
                style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  background: bgs[p],
                  color: cols[p],
                  borderRadius: 4,
                  fontWeight: 600,
                }}
              >
                {p}: {n}
              </span>
            );
          })}
        </div>
      </Card>

      {/* Signal Volume — full width */}
      <Card className="bento-full">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 24,
          }}
        >
          <h3 style={{ fontSize: 16, fontWeight: 700 }}>Signal Volume</h3>
          <span
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {totalSigs.toLocaleString()} total
          </span>
        </div>
        {ts.length === 0 ? (
          <div
            style={{
              height: 100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            No data
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 3,
                height: 100,
              }}
            >
              {ts.map((t, i) => (
                <div
                  key={i}
                  title={`${t.bucket}: ${t.signal_count}`}
                  style={{
                    flex: 1,
                    height: `${Math.max(4, ((t.signal_count || 0) / maxTS) * 100)}%`,
                    background: "var(--accent)",
                    opacity: 0.5,
                    borderRadius: "2px 2px 0 0",
                    transition: "opacity 0.2s",
                    cursor: "default",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.9")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
                />
              ))}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 8,
              }}
            >
              {[ts[0], ts[Math.floor(ts.length / 2)], ts[ts.length - 1]]
                .filter(Boolean)
                .map((t, i) => (
                  <span
                    key={i}
                    style={{ fontSize: 10, color: "var(--text-tertiary)" }}
                  >
                    {t.bucket}
                  </span>
                ))}
            </div>
          </>
        )}
      </Card>

      {/* Bottom stats row */}
      {[
        { label: "Avg MTTR", value: fmtMTTR(avgMTTR), color: "var(--info)" },
        {
          label: "Open P0s",
          value: pCounts.P0 ?? 0,
          color: pCounts.P0 > 0 ? "var(--error)" : "var(--success)",
        },
        {
          label: "Open P1s",
          value: pCounts.P1 ?? 0,
          color: pCounts.P1 > 0 ? "var(--warning)" : "var(--success)",
        },
        { label: "Breach Rate", value: `${breachPct}%`, color: breachCol },
      ].map((s) => (
        <Card key={s.label} style={{ padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: s.color,
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {s.label}
            </span>
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {s.value}
          </div>
        </Card>
      ))}
    </div>
  );
}
