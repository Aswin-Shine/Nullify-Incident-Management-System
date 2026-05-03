import { useState, useEffect } from 'react'
import { fetchMTTR, fetchSLA, fetchTimeseries } from '../api/client'

export function AnalyticsPanel() {
  const [mttr, setMTTR] = useState([])
  const [sla, setSLA] = useState(null)
  const [ts, setTS] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchMTTR(), fetchSLA(), fetchTimeseries()])
      .then(([m, s, t]) => { setMTTR(m); setSLA(s); setTS(t) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ padding: 32, color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>
      loading analytics...
    </div>
  )

  const fmtMTTR = (secs) => {
    if (!secs) return '—'
    if (secs < 60) return `${Math.round(secs)}s`
    if (secs < 3600) return `${Math.round(secs / 60)}m`
    return `${(secs / 3600).toFixed(1)}h`
  }

  // Top 5 components by signal volume
  const topComponents = Object.entries(
    ts.reduce((acc, r) => { acc[r.component] = (acc[r.component] || 0) + r.signal_count; return acc }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const maxSig = topComponents[0]?.[1] || 1

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 20 }}>
        ANALYTICS
      </div>

      {/* SLA summary */}
      {sla && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'TOTAL INCIDENTS', val: sla.total, color: 'var(--text-0)' },
            { label: 'SLA BREACHED', val: sla.breached, color: sla.breached > 0 ? 'var(--p0)' : 'var(--p3)' },
            { label: 'BREACH RATE', val: `${sla.breach_rate_pct}%`, color: sla.breach_rate_pct > 10 ? 'var(--p1)' : 'var(--p3)' },
          ].map(({ label, val, color }) => (
            <div key={label} style={{
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '14px 16px',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 6 }}>{label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* MTTR by component */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 12 }}>
          MTTR BY COMPONENT
        </div>
        {mttr.length === 0
          ? <div style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>No resolved incidents yet</div>
          : mttr.map(row => (
            <div key={row.component} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              marginBottom: 8, padding: '10px 14px',
              background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4,
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', minWidth: 160 }}>
                {row.component}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-0)', minWidth: 60 }}>
                avg {fmtMTTR(row.avg_mttr_seconds)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>
                min {fmtMTTR(row.min_mttr_seconds)} / max {fmtMTTR(row.max_mttr_seconds)}
              </span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>
                {row.incident_count} incidents
              </span>
            </div>
          ))
        }
      </div>

      {/* Signal volume bar chart */}
      <div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 12 }}>
          SIGNAL VOLUME (TOP COMPONENTS)
        </div>
        {topComponents.length === 0
          ? <div style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>No signals yet</div>
          : topComponents.map(([comp, count]) => (
            <div key={comp} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-1)' }}>{comp}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>{count}</span>
              </div>
              <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3 }}>
                <div style={{
                  height: '100%', borderRadius: 3,
                  width: `${(count / maxSig) * 100}%`,
                  background: 'var(--accent)',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          ))
        }
      </div>
    </div>
  )
}
