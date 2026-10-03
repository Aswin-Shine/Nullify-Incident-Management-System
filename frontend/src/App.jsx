import { useState, useCallback, useEffect, useRef } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth, canWrite } from './context/auth';
import { LoginPage } from './components/LoginPage';
import { IncidentList } from './components/IncidentList';
import { IncidentDetail } from './components/IncidentDetail';
import { HealthBar } from './components/HealthBar';
import { SignalInjector } from './components/SignalInjector';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { AccountPanel } from './components/AccountPanel';
import { UsersPanel } from './components/UsersPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toaster';
import { useToast } from './context/toast';
import { useWebSocket } from './hooks/useWebSocket';
import { useCoalesced } from './hooks/useCoalesced';
import { useUrlParam } from './hooks/useUrlParam';
import { avatarColor } from './format';

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

  const tabs = ['incidents', 'analytics', ...(canWrite(user) ? ['inject'] : []), 'account', ...(user?.role === 'admin' ? ['users'] : [])];

  return (
    <div className="app">
      <nav className="glass nav">
        <div className="brand">
          <div className="brand-logo">∅</div>
          <div className="brand-text">
            <span className="brand-name">NULLIFY</span>
            <span className="brand-tag">Incidents, terminated.</span>
          </div>
        </div>

        <div className="nav-tabs">
          {tabs.map(tab => (
            <button type="button" key={tab} className="nav-tab" aria-current={activeTab === tab ? 'page' : undefined}
              onClick={() => setActiveTab(tab)}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="nav-right">
          <div className="user-chip">
            <div className="avatar" style={{ background: avatarColor(user?.username || '') }}>
              {(user?.username || '?')[0].toUpperCase()}
            </div>
            <span className="user-name">{user?.username}</span>
            <span className="role-tag">{user?.role}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Log out" onClick={logout}>⎋</button>
        </div>
      </nav>

      <HealthBar liveEvents={liveEvents} />

      <main className="main">
        {activeTab === 'incidents' && (
          <>
            <IncidentList onSelect={select} selectedId={selectedId} refreshTick={refreshTick} />
            <div className="pane">
              <ErrorBoundary resetKey={selectedId}>
                <IncidentDetail id={selectedId} onRefresh={refresh} refreshTick={refreshTick} />
              </ErrorBoundary>
            </div>
          </>
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
      <div className="boot-mark">∅</div>
      <span className="boot-text">Loading…</span>
    </div>
  );
  return user ? <Dashboard /> : <LoginPage />;
}
