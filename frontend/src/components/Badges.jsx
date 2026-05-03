export function PriorityBadge({ priority }) {
  const colors = {
    P0: { color: 'var(--p0)', bg: 'var(--p0-bg)', label: 'P0 CRITICAL' },
    P1: { color: 'var(--p1)', bg: 'var(--p1-bg)', label: 'P1 HIGH' },
    P2: { color: 'var(--p2)', bg: 'var(--p2-bg)', label: 'P2 MEDIUM' },
    P3: { color: 'var(--p3)', bg: 'var(--p3-bg)', label: 'P3 LOW' },
  };
  const c = colors[priority] || colors.P3;
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: '11px', fontWeight: 700,
      color: c.color, background: c.bg,
      border: `1px solid ${c.color}33`,
      padding: '2px 8px', borderRadius: '3px', letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
    }}>{c.label}</span>
  );
}

export function StatusBadge({ status }) {
  const colors = {
    OPEN: '#ff3b3b', INVESTIGATING: '#f5c518',
    RESOLVED: '#4ade80', CLOSED: '#5c6275',
  };
  const color = colors[status] || '#5c6275';
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: '11px', fontWeight: 700,
      color, background: `${color}15`,
      border: `1px solid ${color}44`,
      padding: '2px 8px', borderRadius: '3px',
    }}>{status}</span>
  );
}
