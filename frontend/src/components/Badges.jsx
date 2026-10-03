import { Icon } from './Icon';

const LABELS = { P0: 'P0 Critical', P1: 'P1 High', P2: 'P2 Medium', P3: 'P3 Low' };

// `short` shows just "P0" (dense list rows); the full label is for the detail header.
export const PriorityBadge = ({ priority, short = false }) => {
  const level = LABELS[priority] ? priority : 'P3';
  return <span className="chip" data-level={level.toLowerCase()}>{short ? level : LABELS[level]}</span>;
};

// RESOLVED carries a check so the emerald never reads as the lime accent.
export const StatusBadge = ({ status }) => (
  <span className="status" data-status={status}>
    {status === 'RESOLVED' && <Icon name="check" size={12} />}
    {status}
  </span>
);
