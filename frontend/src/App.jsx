import { useState, useCallback } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth, canWrite } from './context/auth';
import { LoginPage } from './components/LoginPage';
import { IncidentList } from './components/IncidentList';
import { IncidentDetail } from './components/IncidentDetail';
import { HealthBar } from './components/HealthBar';
import { SignalInjector } from './components/SignalInjector';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useWebSocket } from './hooks/useWebSocket';
import { useCoalesced } from './hooks/useCoalesced';
import { avatarColor } from './format';

function Dashboard() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('incidents');
  const [selectedId, setSelectedId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [liveEvents, setLiveEvents] = useState([]);
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);
  // A burst of WebSocket events becomes one refetch per second instead of one per event.
  const refreshOnEvent = useCoalesced(refresh, 1000);

  useWebSocket((msg) => {
    refreshOnEvent();
    const label =
      msg.event === 'signal_ingested'   ? `signal → ${msg.component}` :
      msg.event === 'work_item_updated'  ? `status → ${msg.status}` :
      msg.event === 'rca_submitted'      ? 'RCA submitted' :
      msg.event === 'comment_added'      ? 'comment added' : msg.event;
    setLiveEvents(ev => [label, ...ev].slice(0, 5));
  });

  const tabs = ['incidents', 'analytics', ...(canWrite(user) ? ['inject'] : [])];

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
            <IncidentList onSelect={setSelectedId} selectedId={selectedId} refreshTick={refreshTick} />
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
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
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
