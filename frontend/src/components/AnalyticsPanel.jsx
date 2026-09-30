import { fetchMTTR, fetchSLA, fetchTimeseries, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { fmtMTTR } from '../format';
import { ErrorNote } from './ErrorNote';

const Card = ({ children, className = '' }) => (
  <div className={`glass card ${className}`}>{children}</div>
);

const orDash = (s) => fmtMTTR(s) ?? '-';

export function AnalyticsPanel() {
  const mttrQ = useQuery('mttr', fetchMTTR);
  const slaQ = useQuery('sla', fetchSLA);
  const tsQ = useQuery('ts', fetchTimeseries);
  const mttr = mttrQ.data ?? [];
  const sla = slaQ.data;
  const ts = tsQ.data ?? [];
  const failure = mttrQ.error || slaQ.error || tsQ.error;

  if (mttrQ.loading || slaQ.loading || tsQ.loading) {
    return (
      <div className="bento-grid">
        {[...Array(8)].map((_, i) => <div key={i} className="shimmer card-skeleton" />)}
      </div>
    );
  }

  const breachPct = sla ? Math.round((sla.breached / (sla.total || 1)) * 100) : 0;
  const breachTone = breachPct < 10 ? 'success' : breachPct < 30 ? 'warning' : 'error';
  const maxMTTR = Math.max(...mttr.map((m) => m.avg_mttr_seconds || 0), 1);
  const maxTS = Math.max(...ts.map((t) => t.signal_count || 0), 1);
  const totalSigs = ts.reduce((a, t) => a + (t.signal_count || 0), 0);
  const topComps = [...mttr]
    .sort((a, b) => (b.avg_mttr_seconds || 0) - (a.avg_mttr_seconds || 0))
    .slice(0, 6);
  const pCounts = { P0: 0, P1: 0, P2: 0, P3: 0, ...sla?.open_by_priority };
  const avgMTTR = mttr.length
    ? mttr.reduce((a, m) => a + (m.avg_mttr_seconds || 0), 0) / mttr.length
    : 0;

  return (
    <div className="bento-grid">
      {failure && <div className="bento-full"><ErrorNote>{errorMessage(failure, 'Could not load analytics')}</ErrorNote></div>}

      <Card className="bento-tall bento-wide">
        <h3 className="card-title">MTTR by Component</h3>
        {topComps.length === 0 ? (
          <div className="chart-empty">∅</div>
        ) : (
          <div className="mttr-rows">
            {topComps.map((c) => (
              <div key={c.component} className="mttr-row">
                <span className="mttr-name">{c.component}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${((c.avg_mttr_seconds || 0) / maxMTTR) * 100}%` }} />
                </div>
                <span className="mttr-value">{orDash(c.avg_mttr_seconds)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="card-center">
        <h3 className="card-label">SLA Breach Rate</h3>
        <div className="donut" data-tone={breachTone} style={{ '--pct': `${breachPct}%` }} />
        <div className="big-number" data-tone={breachTone}>{breachPct}%</div>
        <p className="muted-sm">of incidents breached SLA</p>
      </Card>

      <Card>
        <h3 className="card-label">Total Incidents</h3>
        <div className="big-number plain">{sla?.total ?? '-'}</div>
        <div className="tags">
          {Object.entries(pCounts).map(([p, n]) => (
            <span key={p} className="tag" data-level={p.toLowerCase()}>{p}: {n}</span>
          ))}
        </div>
      </Card>

      <Card className="bento-full">
        <div className="card-head">
          <h3 className="card-title">Signal Volume</h3>
          <span className="card-aside">{totalSigs.toLocaleString()} total</span>
        </div>
        {ts.length === 0 ? (
          <div className="chart-none">No data</div>
        ) : (
          <>
            <div className="bars">
              {ts.map((t, i) => (
                <div key={i} className="bar" title={`${t.bucket}: ${t.signal_count}`}
                  style={{ height: `${Math.max(4, ((t.signal_count || 0) / maxTS) * 100)}%` }} />
              ))}
            </div>
            <div className="bar-axis">
              {[ts[0], ts[Math.floor(ts.length / 2)], ts[ts.length - 1]].filter(Boolean).map((t, i) => (
                <span key={i}>{t.bucket}</span>
              ))}
            </div>
          </>
        )}
      </Card>

      {[
        { label: 'Avg MTTR', value: orDash(avgMTTR), tone: 'info' },
        { label: 'Open P0s', value: pCounts.P0, tone: pCounts.P0 > 0 ? 'error' : 'success' },
        { label: 'Open P1s', value: pCounts.P1, tone: pCounts.P1 > 0 ? 'warning' : 'success' },
        { label: 'Breach Rate', value: `${breachPct}%`, tone: breachTone },
      ].map((s) => (
        <Card key={s.label} className="card-sm">
          <div className="stat-head" data-tone={s.tone}>
            <div className="stat-dot" />
            <span>{s.label}</span>
          </div>
          <div className="stat-value">{s.value}</div>
        </Card>
      ))}
    </div>
  );
}
