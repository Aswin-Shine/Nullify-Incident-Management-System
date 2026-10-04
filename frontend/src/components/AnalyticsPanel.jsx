import { fetchMTTR, fetchSLA, fetchTimeseries, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { fmtMTTR, fillBuckets, weightedMTTR, plural } from '../format';
import { ErrorNote } from './ErrorNote';
import { Icon } from './Icon';

const orDash = (s) => fmtMTTR(s) ?? '-';
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const LOW_SAMPLE = 5;   // fewer incidents than this behind Avg MTTR: say so instead of showing a confident number
const THIN_ROW = 3;     // an MTTR row averaged over fewer incidents than this gets a faint bar
const W = 600, H = 120;  // chart coordinate space; the SVG stretches to the panel

// Buckets are UTC minutes; show them in the viewer's local time.
const tick = (bucket) => new Date(`${bucket}:00Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const Panel = ({ title, aside, className = '', children }) => (
  <section className={`panel card ${className}`}>
    <div className="card-head">
      <h2 className="card-title">{title}</h2>
      {aside && <span className="card-aside">{aside}</span>}
    </div>
    {children}
  </section>
);

// A tile with an `onClick` is a button (it goes somewhere); without one it is a plain figure. `lowSample` mutes the value.
const Kpi = ({ label, value, sub, level, onClick, actionLabel, lowSample, children }) => {
  const body = (
    <>
      <span className="micro kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
      {children}
    </>
  );
  return onClick
    ? <button type="button" className="panel kpi kpi-action" data-level={level} aria-label={actionLabel} onClick={onClick}>
        {body}
        <span className="kpi-chevron"><Icon name="chevron-right" size={14} /></span>
      </button>
    : <div className="panel kpi" data-level={level} data-low-sample={lowSample ? 'true' : undefined}>{body}</div>;
};

// Line over a faint area, hairline gridlines, a peak marker. No chart library: it is one path.
function SignalChart({ buckets, total }) {
  const max = Math.max(...buckets.map(b => b.signal_count));
  const n = buckets.length;
  const pts = buckets.map((b, i) => ({ x: n > 1 ? (i / (n - 1)) * W : 0, y: H - (max ? b.signal_count / max : 0) * (H - 8) - 2 }));
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
        {peak && <span className="peak-dot" style={{ left: `${(peak.x / W) * 100}%`, top: `${(peak.y / H) * 100}%` }} />}
      </div>
      <div className="bar-axis">
        {ticks.map((b, i) => <span key={i}>{tick(b.bucket)}</span>)}
      </div>
    </div>
  );
}

// `onShowIncidents(viewPatch)` opens the Incidents tab with that list view (the open tiles call it).
export function AnalyticsPanel({ refreshTick, onShowIncidents }) {
  const mttrQ = useQuery('mttr', fetchMTTR, refreshTick);
  const slaQ = useQuery('sla', fetchSLA, refreshTick);
  const tsQ = useQuery('ts', fetchTimeseries, refreshTick);
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
  const peakCount = Math.max(...buckets.map(b => b.signal_count), 0);
  const totalSigs = buckets.reduce((a, b) => a + b.signal_count, 0);
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, ...sla?.open_by_priority };
  const open = PRIORITIES.reduce((a, p) => a + counts[p], 0);
  const topComps = [...mttr].sort((a, b) => (b.avg_mttr_seconds || 0) - (a.avg_mttr_seconds || 0)).slice(0, 8);
  const mttrN = mttr.reduce((a, r) => a + (r.avg_mttr_seconds != null ? r.incident_count : 0), 0);  // the incidents behind Avg MTTR
  const lowSample = mttrN > 0 && mttrN < LOW_SAMPLE;
  const maxMTTR = Math.max(...topComps.map(m => m.avg_mttr_seconds || 0), 1);

  return (
    <div className="analytics">
      <h1 className="page-title span-12">Analytics</h1>
      {failure && <div className="span-12"><ErrorNote onRetry={() => { mttrQ.reload(); slaQ.reload(); tsQ.reload(); }}>{errorMessage(failure, 'Could not load analytics')}</ErrorNote></div>}

      <div className="kpi-strip">
        <Kpi label="Open incidents" value={open.toLocaleString()} sub="right now"
          onClick={open > 0 && onShowIncidents ? () => onShowIncidents({ status: 'ACTIVE' }) : undefined}
          actionLabel={`Show ${open.toLocaleString()} open ${plural(open, 'incident')}`}>
          <span className="stack" aria-hidden="true">
            {open > 0 && PRIORITIES.filter(p => counts[p] > 0).map(p => (
              <span key={p} className="stack-seg" data-level={p.toLowerCase()} style={{ width: `${(counts[p] / open) * 100}%` }} />
            ))}
          </span>
          <span className="tags">
            {PRIORITIES.map(p => <span key={p} className="tag" data-level={p.toLowerCase()}>{p}: {counts[p].toLocaleString()}</span>)}
          </span>
        </Kpi>
        <Kpi label="Open P0" value={counts.P0.toLocaleString()} level={counts.P0 > 0 ? 'p0' : undefined} sub="right now"
          onClick={counts.P0 > 0 && onShowIncidents ? () => onShowIncidents({ status: 'ACTIVE', priority: 'P0' }) : undefined}
          actionLabel={`Show ${counts.P0.toLocaleString()} open P0 ${plural(counts.P0, 'incident')}`} />
        <Kpi label="SLA breach rate" value={sla ? `${Math.round(sla.breach_rate_pct)}%` : '-'}
          sub={sla ? `${sla.breached.toLocaleString()} of ${sla.total.toLocaleString()}, all incidents` : undefined} />
        <Kpi label="Avg MTTR" value={orDash(weightedMTTR(mttr))} lowSample={lowSample}
          sub={lowSample ? `only ${mttrN} ${plural(mttrN, 'incident')}, too few to trust` : mttrN ? `across ${mttrN.toLocaleString()} ${plural(mttrN, 'incident')}` : undefined} />
      </div>

      <Panel title="Signal volume" aside={totalSigs ? `${totalSigs.toLocaleString()} total · peak ${peakCount.toLocaleString()}` : '0 total'} className="span-12">
        {buckets.length === 0 ? <div className="chart-none">No data</div>
          : totalSigs === 0 ? <div className="chart-none">No signals in the last hour</div>
          : <SignalChart buckets={buckets} total={totalSigs} />}
      </Panel>

      <Panel title="MTTR by component" className="span-12">
        {topComps.length === 0 ? (
          <div className="chart-none"><Icon name="null" size={24} /></div>
        ) : (
          <div className="mttr-rows">
            {topComps.map((c) => (
              <div key={c.component} className="mttr-row">
                <span className="mttr-name" title={c.component}>{c.component}</span>
                <div className="bar-track">
                  <div className="bar-fill" data-thin={c.incident_count < THIN_ROW ? 'true' : undefined} style={{ width: `${((c.avg_mttr_seconds || 0) / maxMTTR) * 100}%` }} />
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
