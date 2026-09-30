// Small display helpers shared by several components.
export function avatarColor(name = '') {
  const hash = [...name].reduce((acc, c) => c.charCodeAt(0) + ((acc << 5) - acc), 0);
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

export function fmtMTTR(s) {
  if (!s) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
