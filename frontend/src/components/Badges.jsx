import { Icon } from './Icon';

const LABELS = { P0: 'P0 Critical', P1: 'P1 High', P2: 'P2 Medium', P3: 'P3 Low' };

// `short` shows just "P0" (dense list rows); the full label is for the detail header.
// `muted` renders it neutral, for incidents that are finished and no longer need attention.
export const PriorityBadge = ({ priority, short = false, muted = false }) => {
  const level = LABELS[priority] ? priority : 'P3';
  return <span className="chip" data-level={level.toLowerCase()} data-muted={muted || undefined}>{short ? level : LABELS[level]}</span>;
};

const STATUS_WORD = { OPEN: 'Open', INVESTIGATING: 'Investigating', RESOLVED: 'Resolved', CLOSED: 'Closed' };

// Status is neutral text plus a shape (ring, half dot, check, dot), never a hue: severity is the only chroma.
export const StatusBadge = ({ status }) => (
  <span className="status" data-status={status}>
    {status === 'RESOLVED' ? <Icon name="check" size={12} /> : <span className="status-shape" aria-hidden="true" />}
    <span className="status-word">{STATUS_WORD[status] ?? status}</span>
  </span>
);
