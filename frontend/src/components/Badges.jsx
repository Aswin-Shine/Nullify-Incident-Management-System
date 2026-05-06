import React from 'react';
export const PriorityBadge = ({ priority }) => {
  const colors = {
    P0: { text: 'var(--p0-color)', bg: 'var(--p0-bg)', border: 'rgba(248,113,113,0.3)', label: 'P0 Critical' },
    P1: { text: 'var(--p1-color)', bg: 'var(--p1-bg)', border: 'rgba(251,146,60,0.3)',  label: 'P1 High' },
    P2: { text: 'var(--p2-color)', bg: 'var(--p2-bg)', border: 'rgba(251,191,36,0.3)',  label: 'P2 Medium' },
    P3: { text: 'var(--p3-color)', bg: 'var(--p3-bg)', border: 'rgba(52,211,153,0.3)',  label: 'P3 Low' },
  };
  const c = colors[priority] || colors.P3;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center',
    }}>
      {c.label}
    </span>
  );
};

export const StatusBadge = ({ status }) => {
  const colors = {
    OPEN:          'var(--status-open)',
    INVESTIGATING: 'var(--status-investigating)',
    RESOLVED:      'var(--status-resolved)',
    CLOSED:        'var(--status-closed)',
  };
  const col = colors[status] || colors.CLOSED;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color: col,
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: col,
        display: 'inline-block', flexShrink: 0,
        animation: status === 'INVESTIGATING' ? 'pulseDot 1.8s ease-in-out infinite' : 'none',
      }} />
      {status}
    </span>
  );
};
