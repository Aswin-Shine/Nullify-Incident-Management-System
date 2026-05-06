import React, { useState, useEffect } from "react";
import { fetchRCA, submitRCA } from "../api/client";

const CATEGORIES = [
  "Software Bug",
  "Infrastructure Failure",
  "Human Error",
  "External Provider",
  "Capacity Exhaustion",
  "Configuration Error",
  "Unknown",
];

// Move components outside to prevent re-creation on every render
const Field = ({ label, children }) => (
  <div>
    <label
      style={{
        fontSize: 12,
        color: "var(--text-secondary)",
        marginBottom: 6,
        display: "block",
      }}
    >
      {label}
    </label>
    {children}
  </div>
);

const ReadVal = ({ label, value }) => (
  <div>
    <label
      style={{
        fontSize: 11,
        color: "var(--text-tertiary)",
        marginBottom: 4,
        display: "block",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </label>
    <div
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: 13,
        color: "var(--text-secondary)",
        lineHeight: 1.5,
      }}
    >
      {value || "—"}
    </div>
  </div>
);

export function RCAForm({ workItem, onSuccess }) {
  const [existing, setExisting] = useState(null);
  const [formData, setFormData] = useState({
    incident_start: "",
    incident_end: "",
    root_cause_category: CATEGORIES[0],
    fix_applied: "",
    prevention_steps: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // FIX: fetchRCA → GET /api/work-items/:id/rca (not workItem.rca_id)
    fetchRCA(workItem.id)
      .then((r) => {
        if (r) setExisting(r);
      })
      .catch(() => {});
  }, [workItem.id]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    try {
      // FIX: submitRCA → POST /api/work-items/:id/rca
      await submitRCA(workItem.id, formData);
      const r = await fetchRCA(workItem.id);
      if (r) setExisting(r);
      onSuccess?.();
    } catch (e) {
      setError(e.response?.data?.detail || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const isSubmitted = !!existing;

  return (
    <div className="glass" style={{ borderRadius: 16, padding: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>◈</span>
          <h3 style={{ fontSize: 16, fontWeight: 700 }}>Root Cause Analysis</h3>
        </div>
        {isSubmitted && (
          <span
            style={{
              fontSize: 11,
              padding: "4px 10px",
              background: "var(--p3-bg)",
              color: "var(--success)",
              borderRadius: 20,
              fontWeight: 600,
              border: "1px solid rgba(52,211,153,0.25)",
            }}
          >
            ✓ Submitted
          </span>
        )}
      </div>

      {!isSubmitted && (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--p2-bg)",
            borderLeft: "3px solid var(--warning)",
            borderRadius: "0 4px 4px 0",
            marginBottom: 24,
          }}
        >
          <p style={{ fontSize: 12, color: "var(--warning)", lineHeight: 1.4 }}>
            Incident cannot be closed without an approved RCA.
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {isSubmitted ? (
          <>
            <ReadVal label="Impact Start" value={existing.incident_start} />
            <ReadVal label="Impact End" value={existing.incident_end} />
            <ReadVal label="Root Cause" value={existing.root_cause_category} />
            <ReadVal label="Fix Applied" value={existing.fix_applied} />
            <ReadVal
              label="Prevention Steps"
              value={existing.prevention_steps}
            />
          </>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
              }}
            >
              <Field label="Impact Start">
                <input
                  type="datetime-local"
                  value={formData.incident_start}
                  onChange={(e) =>
                    setFormData({ ...formData, incident_start: e.target.value })
                  }
                />
              </Field>
              <Field label="Impact End">
                <input
                  type="datetime-local"
                  value={formData.incident_end}
                  onChange={(e) =>
                    setFormData({ ...formData, incident_end: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Root Cause Category">
              <select
                value={formData.root_cause_category}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    root_cause_category: e.target.value,
                  })
                }
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fix Applied">
              <textarea
                value={formData.fix_applied}
                onChange={(e) =>
                  setFormData({ ...formData, fix_applied: e.target.value })
                }
                placeholder="Describe what fix was applied…"
                style={{ minHeight: 100 }}
              />
            </Field>
            <Field label="Prevention Steps">
              <textarea
                value={formData.prevention_steps}
                onChange={(e) =>
                  setFormData({ ...formData, prevention_steps: e.target.value })
                }
                placeholder="How will this be prevented…"
                style={{ minHeight: 100 }}
              />
            </Field>
            {error && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "var(--p0-bg)",
                  color: "var(--error)",
                  fontSize: 12,
                  animation: "slideDown 0.2s",
                  border: "1px solid rgba(248,113,113,0.2)",
                }}
              >
                {error}
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="btn btn-primary"
              style={{
                height: 40,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontWeight: 600,
              }}
            >
              {submitting ? <span className="spinner" /> : "Submit RCA"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
