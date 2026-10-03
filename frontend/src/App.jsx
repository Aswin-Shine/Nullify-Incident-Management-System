import { useState, useCallback, useEffect, useRef } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth, tabsFor } from './context/auth';
import { LoginPage } from './components/LoginPage';
import { IncidentList } from './components/IncidentList';
import { IncidentDetail } from './components/IncidentDetail';
import { HealthBar } from './components/HealthBar';
import { SignalInjector } from './components/SignalInjector';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { CommandPalette } from './components/CommandPalette';
import { AccountPanel } from './components/AccountPanel';
import { UsersPanel } from './components/UsersPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toaster';
import { useToast } from './context/toast';
import { useWebSocket } from './hooks/useWebSocket';
import { useCoalesced } from './hooks/useCoalesced';
import { useUrlParam } from './hooks/useUrlParam';
import { Icon } from './components/Icon';
import { useSplitWidth } from './hooks/useSplitWidth';
import { getThemePref, setThemePref, nextTheme } from './theme';

const TAB_ICON = { incidents: 'alert-triangle', analytics: 'bar-chart', inject: 'zap', account: 'user', users: 'users' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function Dashboard() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('incidents');
  // The open incident lives in the URL (?incident=<id>), so reload, Back and a pasted link all work.
  const [selectedId, setSelectedId] = useUrlParam('incident');
  const toast = useToast();
  const [unseenP0, setUnseenP0] = useState(0);
  const baseTitle = useRef(document.title);
  const [refreshTick, setRefreshTick] = useState(0);
  const [liveEvents, setLiveEvents] = useState([]);
  const [theme, setTheme] = useState(getThemePref);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const split = useSplitWidth();
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);
  // A burst of WebSocket events becomes one refetch per second instead of one per event.
  const refreshOnEvent = useCoalesced(refresh, 1000);

  const select = useCallback((id) => { setSelectedId(id); setActiveTab('incidents'); }, [setSelectedId]);

  // A new P0 gets a toast, plus a title badge and a desktop notification while the tab is in the background.
  const alertP0 = (msg) => {
    const text = `New P0: ${msg.component}`;
    toast(text, { kind: 'alert', action: { label: 'Open', onClick: () => select(msg.id) } });
    if (!document.hidden) return;
    setUnseenP0(n => n + 1);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(text, { body: 'Click to open the incident.', tag: msg.id });
        n.onclick = () => { window.focus(); select(msg.id); n.close?.(); };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  };

  useEffect(() => {
    const base = baseTitle.current;
    document.title = unseenP0 ? `(${unseenP0}) ${base}` : base;
    return () => { document.title = base; };
  }, [unseenP0]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setUnseenP0(0); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useWebSocket((msg) => {
    refreshOnEvent();
    if (msg.event === 'work_item_created' && msg.priority === 'P0') alertP0(msg);
    const label =
      msg.event === 'signal_ingested'   ? `signal → ${msg.component}` :
      msg.event === 'work_item_updated'  ? `status → ${msg.status}` :
      msg.event === 'rca_submitted'      ? 'RCA submitted' :
      msg.event === 'comment_added'      ? 'comment added' :
      msg.event === 'work_item_assigned' ? 'assignment changed' :
      msg.event === 'work_item_created'  ? `new ${msg.priority} ${msg.component}` : msg.event;
    setLiveEvents(ev => [label, ...ev].slice(0, 5));
  });

  // Ctrl/Cmd+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const tabs = tabsFor(user);

  const chooseTheme = (pref) => { setThemePref(pref); setTheme(pref); };
  const cycleTheme = () => chooseTheme(nextTheme(theme));

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <div className="brand-logo"><Icon name="null" /></div>
          <span className="brand-name">Nullify</span>
        </div>

        <div className="nav-items">
          {tabs.map(tab => (
            <button type="button" key={tab} className="nav-item" aria-current={activeTab === tab ? 'page' : undefined}
              onClick={() => setActiveTab(tab)}>
              <Icon name={TAB_ICON[tab]} />
              <span className="nav-label">{cap(tab)}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <button type="button" className="nav-item" aria-keyshortcuts="Control+K Meta+K" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
            <span className="nav-label">Search</span>
            <kbd className="kbd nav-kbd" aria-hidden="true">⌘K</kbd>
          </button>
          <button type="button" className="nav-item" aria-label={`Theme: ${cap(theme)}`} onClick={cycleTheme}>
            <Icon name={THEME_ICON[theme]} />
            <span className="nav-label">Theme: {cap(theme)}</span>
          </button>
          <div className="user-block">
            <div className="avatar">{(user?.username || '?')[0].toUpperCase()}</div>
            <div className="user-meta">
              <span className="user-name">{user?.username}</span>
              <span className="micro">{user?.role}</span>
            </div>
            <button type="button" className="icon-btn" aria-label="Log out" onClick={logout}><Icon name="log-out" /></button>
          </div>
        </div>
      </nav>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onGo={setActiveTab} onTheme={chooseTheme} onSelectIncident={select} />
      )}

      <div className="content">
        <HealthBar liveEvents={liveEvents} />

        <main className="main">
          {activeTab === 'incidents' && (
            <div className="split" style={{ '--list-w': `${split.width}px` }}>
              <IncidentList onSelect={select} selectedId={selectedId} refreshTick={refreshTick} />
              {/* A focusable separator is a widget in ARIA (window splitter); the lint rules only know the static kind. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              <div role="separator" className="split-handle" tabIndex={0} aria-orientation="vertical" aria-label="Resize incident list"
                aria-valuenow={split.width} aria-valuemin={split.min} aria-valuemax={split.max}
                onKeyDown={split.onKeyDown} onPointerDown={split.onPointerDown} onPointerMove={split.onPointerMove}
                onPointerUp={split.onPointerUp} onPointerCancel={split.onPointerUp} onDoubleClick={split.onDoubleClick} />
              <div className="pane">
                <ErrorBoundary resetKey={selectedId}>
                  <IncidentDetail id={selectedId} onRefresh={refresh} refreshTick={refreshTick} />
                </ErrorBoundary>
              </div>
            </div>
          )}
          {activeTab === 'analytics' && (
            <div className="pane pane-row">
              <ErrorBoundary>
                <AnalyticsPanel />
              </ErrorBoundary>
            </div>
          )}
          {activeTab === 'inject' && (
            <div className="center-pane">
              <SignalInjector onSent={refresh} />
            </div>
          )}
          {activeTab === 'account' && (
            <div className="pane">
              <ErrorBoundary>
                <AccountPanel />
              </ErrorBoundary>
            </div>
          )}
          {activeTab === 'users' && (
            <div className="pane">
              <ErrorBoundary>
                <UsersPanel />
              </ErrorBoundary>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </AuthProvider>
  );
}

function AppInner() {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="boot">
      <div className="boot-mark"><Icon name="null" size={28} /></div>
      <span className="boot-text">Loading…</span>
    </div>
  );
  return user ? <Dashboard /> : <LoginPage />;
}
