const LABELS = { P0: 'P0 Critical', P1: 'P1 High', P2: 'P2 Medium', P3: 'P3 Low' };

export const PriorityBadge = ({ priority }) => {
  const level = LABELS[priority] ? priority : 'P3';
  return <span className="chip" data-level={level.toLowerCase()}>{LABELS[level]}</span>;
};

export const StatusBadge = ({ status }) => (
  <span className="status" data-status={status}>{status}</span>
);
