import { useState, useEffect, useId, useRef } from 'react';
import { fetchWorkItems } from '../api/client';
import { useAuth, tabsFor } from '../context/auth';
import { useQuery } from '../hooks/useQuery';
import { PriorityBadge, StatusBadge } from './Badges';
import { Icon } from './Icon';

const DEBOUNCE_MS = 200;
const THEMES = ['system', 'light', 'dark'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Ctrl/Cmd+K. Commands are filtered locally; a query of 2+ characters also searches incidents.
export function CommandPalette({ onClose, onGo, onTheme, onSelectIncident }) {
  const { user, logout } = useAuth();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [opener] = useState(() => document.activeElement);  // read during render, before the input takes focus
  const inputRef = useRef(null);
  const uid = useId();

  useEffect(() => { inputRef.current?.focus(); return () => opener?.focus?.(); }, [opener]);
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(() => setDebounced(q.length >= 2 ? q : ''), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // A failed search just shows no incidents; useQuery also drops a response that arrives after the query moved on.
  const found = useQuery(debounced || null, () => fetchWorkItems({ q: debounced, limit: 8 }));
  const incidents = found.data?.items ?? [];

  const match = (label) => label.toLowerCase().includes(query.trim().toLowerCase());
  const groups = [
    { name: 'Navigate', items: tabsFor(user).map(tab => ({ id: `go-${tab}`, label: `Go to ${cap(tab)}`, run: () => onGo(tab) })).filter(c => match(c.label)) },
    { name: 'Incidents', items: incidents.map(i => ({ id: `wi-${i.id}`, label: `Open ${i.component}`, incident: i, run: () => onSelectIncident(i.id) })) },
    { name: 'Preferences', items: [
      ...THEMES.map(t => ({ id: `theme-${t}`, label: `Theme: ${cap(t)}`, run: () => onTheme(t) })),
      { id: 'logout', label: 'Log out', run: logout },
    ].filter(c => match(c.label)) },
  ].filter(g => g.items.length);
  const options = groups.flatMap(g => g.items);
  const at = Math.min(active, options.length - 1);

  const choose = (opt) => { opt.run(); onClose(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
    else if (e.key === 'Enter' && options[at]) { e.preventDefault(); choose(options[at]); }
    else if (e.key === 'Tab') e.preventDefault();  // focus stays in the input
  };

  return (
    // The backdrop only catches clicks; the dialog inside it is the keyboard surface.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="palette-backdrop" data-testid="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" />
          <input ref={inputRef} name="palette-query" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list"
            aria-activedescendant={options[at] ? `${uid}-${options[at].id}` : undefined} aria-label="Search commands and incidents"
            placeholder="Type a command or search incidents" autoComplete="off" spellCheck={false}
            value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
          <kbd className="kbd" aria-hidden="true">Esc</kbd>
        </div>
        <ul className="palette-list" id={`${uid}-list`} role="listbox" aria-label="Results">
          {groups.map(g => (
            <li key={g.name} role="group" aria-label={g.name}>
              <div className="palette-group micro" aria-hidden="true">{g.name}</div>
              <ul role="presentation">
                {g.items.map(opt => (
                  // Keyboard use goes through the input (aria-activedescendant); the click is for the mouse.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li key={opt.id} id={`${uid}-${opt.id}`} role="option" aria-selected={options[at] === opt}
                    className="palette-option" data-active={options[at] === opt}
                    onMouseEnter={() => setActive(options.indexOf(opt))} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(opt)}>
                    <span className="palette-label">{opt.label}</span>
                    {opt.incident && (
                      <span className="palette-meta">
                        <PriorityBadge priority={opt.incident.priority} short />
                        <StatusBadge status={opt.incident.status} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {options.length === 0 && <li role="presentation" className="palette-empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
