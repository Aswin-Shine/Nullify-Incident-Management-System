import { useState, useCallback, useEffect, useRef } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth, tabsFor } from './context/auth';
import { LoginPage } from './components/LoginPage';
import { IncidentList } from './components/IncidentList';
import { IncidentDetail } from './components/IncidentDetail';
import { HealthBar } from './components/HealthBar';
import { AccountMenu } from './components/AccountMenu';
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
import { usePendingAction } from './hooks/usePendingAction';
import { updateStatus, assignWorkItem, errorMessage } from './api/client';
import { startedMessage, copyIncidentLink } from './format';
import { Icon } from './components/Icon';
import { useSplitWidth } from './hooks/useSplitWidth';
import { getThemePref, setThemePref } from './theme';
import { DEFAULT_VIEW } from './sort';

const TAB_ICON = { incidents: 'alert-triangle', analytics: 'bar-chart', inject: 'zap', account: 'user', users: 'users' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const RESOLVE_UNDO_MS = 5000;
const PHONE_BELOW = 900;  // same breakpoint as the CSS: under it the list and the detail take turns

function NavItem({ tab, activeTab, onOpen }) {
  return (
    <button type="button" className="nav-item" aria-current={activeTab === tab ? 'page' : undefined} onClick={() => onOpen(tab)}>
      <Icon name={TAB_ICON[tab]} />
      <span className="nav-label">{cap(tab)}</span>
    </button>
  );
}

function Dashboard() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('incidents');
  // The open incident lives in the URL (?incident=<id>), so reload, Back and a pasted link all work.
  const [selectedId, setSelectedId] = useUrlParam('incident');
  const [openInfo, setOpenInfo] = useState(null);  // { id, component, status, assignee_id } of the incident the detail pane loaded
  const [criticalIds, setCriticalIds] = useState([]);  // the list's active P0s, in the order its rows show them
  // The list's filters and sort live here: the list unmounts on a tab switch and must come back as it was left.
  const [view, setView] = useState(DEFAULT_VIEW);
  const toast = useToast();
  const [unseenP0, setUnseenP0] = useState(0);
  const [unopenedP0, setUnopenedP0] = useState([]);  // new P0s nobody has opened yet this page session, oldest first
  const baseTitle = useRef(document.title);
  const [refreshTick, setRefreshTick] = useState(0);
  const [liveEvents, setLiveEvents] = useState([]);
  const [feed, setFeed] = useState('connecting');  // the WebSocket's state, shown in the status strip
  const [theme, setTheme] = useState(getThemePref);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const split = useSplitWidth();
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);
  // A burst of WebSocket events becomes one refetch per second instead of one per event.
  const refreshOnEvent = useCoalesced(refresh, 1000);

  // The Analytics tiles count a view of the list; open it exactly as counted (no leftover search or Assigned to me).
  const goToIncidents = (viewPatch) => {
    setView(v => ({ ...v, priority: '', mine: false, search: '', ...viewPatch }));
    setActiveTab('incidents');
  };

  const select = useCallback((id, opts) => {
    setSelectedId(id, opts);
    setActiveTab('incidents');
    setUnopenedP0(ids => ids.includes(id) ? ids.filter(x => x !== id) : ids);
  }, [setSelectedId]);

  // Open the most urgent incident once per page load, unless the URL already names one. On a phone the list
  // stays up instead (opening an incident there would hide the list). Replace, so Back is not trapped on "nothing selected".
  const autoSelected = useRef(false);
  const onListLoaded = useCallback((ids) => {
    setCriticalIds(ids);
    if (autoSelected.current) return;
    autoSelected.current = true;
    if (!selectedId && ids.length && window.innerWidth >= PHONE_BELOW) select(ids[0], { replace: true });
  }, [selectedId, select]);

  // Back to the list (phone view), the card's deselect button, or Escape: the row that was open gets the focus again.
  const backTo = useRef(null);
  const goBack = useCallback(() => { backTo.current = selectedId; select(null); }, [selectedId, select]);
  useEffect(() => {
    if (selectedId != null || !backTo.current) return;
    document.querySelector(`[data-incident-id="${backTo.current}"]`)?.focus();
    backTo.current = null;
  }, [selectedId]);

  // Resolve waits 5 s so it can be undone. It lives here, not in the detail pane, so it survives switching incidents.
  const resolver = usePendingAction(RESOLVE_UNDO_MS);
  const resolve = ({ id, component }, note) => {
    toast(`Resolving ${component} in 5 s`, { ttl: RESOLVE_UNDO_MS, action: { label: 'Undo', onClick: () => resolver.cancel(id) } });
    resolver.start(id, async () => {
      try {
        await updateStatus(id, 'RESOLVED', note);
        toast('Moved to RESOLVED');
      } catch (e) {
        toast(errorMessage(e, 'Action failed'), { kind: 'error' });
      }
      refresh();
    });
  };
  // The palette cannot take the resolution note, so it asks the open pane to show its note form (a new object each time).
  const [askNote, setAskNote] = useState(null);
  const askResolve = ({ id }) => setAskNote({ id });

  // Palette actions on the open incident. Each ends in a refresh so the list and the pane show the new state.
  const startInvestigating = async (incident) => {
    try {
      const updated = await updateStatus(incident.id, 'INVESTIGATING');
      toast(startedMessage(incident, updated, user.id));
    } catch (e) {
      toast(errorMessage(e, 'Action failed'), { kind: 'error' });
    }
    refresh();
  };
  const assignMe = async (incident) => {
    try {
      await assignWorkItem(incident.id, user.id);
      toast('Assigned to you');
    } catch (e) {
      toast(errorMessage(e, 'Action failed'), { kind: 'error' });
    }
    refresh();
  };
  // The next critical incident after the open one, wrapping at the end (the first when the open one is not critical).
  const nextCriticalId = criticalIds.length ? criticalIds[(criticalIds.indexOf(selectedId) + 1) % criticalIds.length] : null;
  const onPaletteIncident = activeTab === 'incidents' && selectedId != null && openInfo?.id === selectedId ? openInfo : null;

  // A new P0 gets a toast, plus a title badge and a desktop notification while the tab is in the background.
  const alertP0 = (msg) => {
    const text = `New P0: ${msg.component}`;
    toast(text, { kind: 'alert', action: { label: 'Open', onClick: () => select(msg.id) } });
    setUnopenedP0(ids => ids.includes(msg.id) ? ids : [...ids, msg.id]);
    if (!document.hidden) return;
    setUnseenP0(n => n + 1);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(text, { body: 'Click to open the incident.', tag: msg.id });
        n.onclick = () => { window.focus(); select(msg.id); n.close?.(); };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  };

  // "(2) RDBMS_PRIMARY · Nullify": the unseen-P0 count first, then the open incident while the Incidents tab shows it.
  const openName = activeTab === 'incidents' && selectedId != null && openInfo?.id === selectedId ? openInfo.component : null;
  useEffect(() => {
    const base = baseTitle.current;
    const name = openName ? `${openName} · ${base}` : base;
    document.title = unseenP0 ? `(${unseenP0}) ${name}` : name;
    return () => { document.title = base; };
  }, [unseenP0, openName]);
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
  }, refresh, setFeed);  // events are lost while the socket is down, so refetch once it is back

  // Escape closes the open incident (the list stays), unless focus is in a field or an overlay (palette, menu,
  // popover) owns the key; inline confirms stop their own Escape before it gets here.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || activeTab !== 'incidents' || selectedId == null) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeTab, selectedId, goBack]);

  // Ctrl/Cmd+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key?.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const tabs = tabsFor(user);
  const devTools = tabs.includes('inject');  // SRE and admin only, kept apart from the pages people work in
  const pages = tabs.filter(tab => tab !== 'inject' && tab !== 'account');  // Account and Inject live in the account menu

  const chooseTheme = (pref) => { setThemePref(pref); setTheme(pref); };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <div className="brand-logo"><Icon name="null" /></div>
          <span className="brand-name">Nullify</span>
        </div>

        <div className="nav-items">
          {pages.map(tab => <NavItem key={tab} tab={tab} activeTab={activeTab} onOpen={setActiveTab} />)}
        </div>

        <div className="sidebar-foot">
          <button type="button" className="nav-item" aria-keyshortcuts="Control+K Meta+K" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
            <span className="nav-label">Search</span>
            <kbd className="kbd nav-kbd" aria-hidden="true">⌘K</kbd>
          </button>
          <HealthBar feed={feed} liveEvents={liveEvents} newP0={unopenedP0.length} onOpenNewP0={() => select(unopenedP0[0])} />
          <AccountMenu user={user} theme={theme} onTheme={chooseTheme} onOpen={setActiveTab} onLogout={logout} devTools={devTools} />
        </div>
      </nav>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onGo={setActiveTab} onTheme={chooseTheme} onSelectIncident={select}
          activeTab={activeTab} theme={theme} incident={onPaletteIncident}
          onStartInvestigating={startInvestigating} onAssignMe={assignMe} onResolve={askResolve} onCopyLink={({ id }) => copyIncidentLink(id, toast)}
          onNextCritical={nextCriticalId && nextCriticalId !== selectedId ? () => select(nextCriticalId) : undefined} />
      )}

      <div className="content">
        <main className="main">
          {activeTab === 'incidents' && (
            <div className="split" data-selected={selectedId != null} style={{ '--list-w': `${split.width}px` }}>
              <IncidentList view={view} setView={setView} onSelect={select} selectedId={selectedId}
                selectedInfo={openInfo} refreshTick={refreshTick} onLoaded={onListLoaded} />
              {/* A focusable separator is a widget in ARIA (window splitter); the lint rules only know the static kind. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              <div role="separator" className="split-handle" tabIndex={0} aria-orientation="vertical" aria-label="Resize incident list"
                aria-valuenow={split.width} aria-valuemin={split.min} aria-valuemax={split.max}
                onKeyDown={split.onKeyDown} onPointerDown={split.onPointerDown} onPointerMove={split.onPointerMove}
                onPointerUp={split.onPointerUp} onPointerCancel={split.onPointerUp} onDoubleClick={split.onDoubleClick} />
              <div className="pane">
                {selectedId != null && (
                  <button type="button" className="btn-link back-btn" onClick={goBack}>
                    <Icon name="chevron-left" size={14} />Back to incidents
                  </button>
                )}
                <ErrorBoundary resetKey={selectedId}>
                  <IncidentDetail id={selectedId} onRefresh={refresh} refreshTick={refreshTick} onOpened={setOpenInfo} onClose={goBack}
                    onResolve={resolve} resolving={!!resolver.pending[selectedId]} askNote={askNote} />
                </ErrorBoundary>
              </div>
            </div>
          )}
          {activeTab === 'analytics' && (
            <div className="pane pane-row">
              <ErrorBoundary>
                <AnalyticsPanel refreshTick={refreshTick} onShowIncidents={goToIncidents} />
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
