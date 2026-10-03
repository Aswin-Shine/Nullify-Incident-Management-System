import { fetchMTTR, fetchSLA, fetchTimeseries, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { fmtMTTR, fillBuckets, weightedMTTR } from '../format';
import { ErrorNote } from './ErrorNote';
import { Icon } from './Icon';

const orDash = (s) => fmtMTTR(s) ?? '-';
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const W = 600, H = 120;  // chart coordinate space; the SVG stretches to the panel

// Buckets are UTC minutes; show them in the viewer's local time.
const tick = (bucket) => new Date(`${bucket}:00Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const Panel = ({ title, aside, className = '', children }) => (
  <section className={`panel card ${className}`}>
    <div className="card-head">
      <h3 className="card-title">{title}</h3>
      {aside && <span className="card-aside">{aside}</span>}
    </div>
    {children}
  </section>
);

const Kpi = ({ label, value, sub, level }) => (
  <div className="panel kpi" data-level={level}>
    <span className="micro kpi-label">{label}</span>
    <span className="kpi-value">{value}</span>
    {sub && <span className="kpi-sub">{sub}</span>}
  </div>
);

// Line over a faint area, hairline gridlines, a peak marker. No chart library: it is one path.
function SignalChart({ buckets, total }) {
  const max = Math.max(...buckets.map(b => b.signal_count), 1);
  const n = buckets.length;
  const pts = buckets.map((b, i) => ({ x: n > 1 ? (i / (n - 1)) * W : 0, y: H - (b.signal_count / max) * (H - 8) - 2 }));
  if (n === 1) pts.push({ x: W, y: pts[0].y });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const peakAt = buckets.findIndex(b => b.signal_count === max);
  const peak = pts[peakAt];
  const ticks = [buckets[0], buckets[Math.floor((n - 1) / 2)], buckets[n - 1]];
  return (
    <div>
      <div className="chart" role="img" aria-label={`Signal volume, last ${n} minutes, ${total} total`}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {[0.25, 0.5, 0.75].map(f => <line key={f} className="grid-line" x1="0" x2={W} y1={H * f} y2={H * f} />)}
          <path className="area" d={`${line} L${pts.at(-1).x} ${H} L${pts[0].x} ${H} Z`} />
          <path className="line" d={line} />
        </svg>
        <span className="peak-dot" style={{ left: `${(peak.x / W) * 100}%`, top: `${(peak.y / H) * 100}%` }} />
        <span className="peak-label">PEAK {max}</span>
      </div>
      <div className="bar-axis">
        {ticks.map((b, i) => <span key={i}>{tick(b.bucket)}</span>)}
      </div>
    </div>
  );
}

export function AnalyticsPanel() {
  const mttrQ = useQuery('mttr', fetchMTTR);
  const slaQ = useQuery('sla', fetchSLA);
  const tsQ = useQuery('ts', fetchTimeseries);
  const mttr = mttrQ.data ?? [];
  const sla = slaQ.data;
  const failure = mttrQ.error || slaQ.error || tsQ.error;

  if (mttrQ.loading || slaQ.loading || tsQ.loading) {
    return (
      <div className="analytics">
        {[...Array(6)].map((_, i) => <div key={i} className="shimmer card-skeleton" />)}
      </div>
    );
  }

  const buckets = fillBuckets(tsQ.data);
  const totalSigs = buckets.reduce((a, b) => a + b.signal_count, 0);
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, ...sla?.open_by_priority };
  const open = PRIORITIES.reduce((a, p) => a + counts[p], 0);
  const topComps = [...mttr].sort((a, b) => (b.avg_mttr_seconds || 0) - (a.avg_mttr_seconds || 0)).slice(0, 8);
  const maxMTTR = Math.max(...topComps.map(m => m.avg_mttr_seconds || 0), 1);

  return (
    <div className="analytics">
      {failure && <div className="span-12"><ErrorNote>{errorMessage(failure, 'Could not load analytics')}</ErrorNote></div>}

      <div className="kpi-strip">
        <Kpi label="Open incidents" value={open} />
        <Kpi label="Open P0" value={counts.P0} level={counts.P0 > 0 ? 'p0' : undefined} />
        <Kpi label="SLA breach rate" value={sla ? `${Math.round(sla.breach_rate_pct)}%` : '-'}
          sub={sla ? `${sla.breached} of ${sla.total} breached` : undefined} />
        <Kpi label="Avg MTTR" value={orDash(weightedMTTR(mttr))} />
      </div>

      <Panel title="Signal volume" aside={`${totalSigs.toLocaleString()} total`} className="span-8">
        {buckets.length === 0 ? <div className="chart-none">No data</div> : <SignalChart buckets={buckets} total={totalSigs} />}
      </Panel>

      <Panel title="Open by priority" className="span-4">
        <div className="stack" aria-hidden="true">
          {open > 0 && PRIORITIES.filter(p => counts[p] > 0).map(p => (
            <span key={p} className="stack-seg" data-level={p.toLowerCase()} style={{ width: `${(counts[p] / open) * 100}%` }} />
          ))}
        </div>
        <div className="tags">
          {PRIORITIES.map(p => <span key={p} className="tag" data-level={p.toLowerCase()}>{p}: {counts[p]}</span>)}
        </div>
      </Panel>

      <Panel title="MTTR by component" className="span-12">
        {topComps.length === 0 ? (
          <div className="chart-none"><Icon name="null" size={24} /></div>
        ) : (
          <div className="mttr-rows">
            {topComps.map((c) => (
              <div key={c.component} className="mttr-row">
                <span className="mttr-name">{c.component}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${((c.avg_mttr_seconds || 0) / maxMTTR) * 100}%` }} />
                </div>
                <span className="mttr-value">{orDash(c.avg_mttr_seconds)}<span className="mttr-n"> n={c.incident_count}</span></span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
