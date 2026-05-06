// App.jsx — Gemini UI + fixed: syntax error (z-index), correct useWebSocket, named imports
import React, { useState, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './components/LoginPage';
import { IncidentList } from './components/IncidentList';
import { IncidentDetail } from './components/IncidentDetail';
import { HealthBar } from './components/HealthBar';
import { SignalInjector } from './components/SignalInjector';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { useWebSocket } from './hooks/useWebSocket';

function getAvatarColor(name = '') {
  const hash = [...name].reduce((acc, c) => c.charCodeAt(0) + ((acc << 5) - acc), 0);
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

function Dashboard() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('incidents');
  const [selectedId, setSelectedId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [liveEvents, setLiveEvents] = useState([]);
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);

  // FIX: useWebSocket takes a callback, not returns liveEvents
  useWebSocket((msg) => {
    refresh();
    const label =
      msg.event === 'signal_ingested'   ? `signal → ${msg.component_id || msg.component}` :
      msg.event === 'work_item_updated'  ? `status → ${msg.status}` :
      msg.event === 'rca_submitted'      ? 'RCA submitted' :
      msg.event === 'comment_added'      ? 'comment added' : msg.event;
    setLiveEvents(ev => [label, ...ev].slice(0, 5));
  });

  const canInject = user?.role === 'sre' || user?.role === 'admin';
  const tabs = ['incidents', 'analytics', ...(canInject ? ['inject'] : [])];

  return (
    // FIX: z-index in JSX inline style must be camelCase zIndex (not z-index)
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative', zIndex: 1 }}>

      {/* Navbar */}
      <nav className="glass" style={{ height: 56, position: 'sticky', top: 0, zIndex: 100, display: 'flex', alignItems: 'center', padding: '0 24px', justifyContent: 'space-between', borderRadius: 0, borderBottom: '1px solid var(--glass-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 0 20px var(--accent-glow)', animation: 'glowPulse 3s ease-in-out infinite', flexShrink: 0 }}>∅</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 15 }}>NULLIFY</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Incidents, terminated.</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map(tab => (
            <div key={tab} role="button" tabIndex={0} onClick={() => setActiveTab(tab)}
              onKeyDown={e => e.key === 'Enter' && setActiveTab(tab)}
              style={{ padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: 'pointer', transition: 'all 0.18s', background: activeTab === tab ? 'var(--accent-dim)' : 'transparent', color: activeTab === tab ? 'var(--accent-light)' : 'var(--text-secondary)', borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent' }}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: 'var(--bg-raised)', borderRadius: 20, border: '1px solid var(--border-subtle)' }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: getAvatarColor(user?.username || ''), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
              {(user?.username || '?')[0].toUpperCase()}
            </div>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{user?.username}</span>
            <span style={{ fontSize: 10, background: 'var(--accent-dim)', color: 'var(--accent-light)', padding: '2px 6px', borderRadius: 4 }}>{user?.role}</span>
          </div>
          <div role="button" tabIndex={0} onClick={logout} style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 16, padding: 4 }}>⎋</div>
        </div>
      </nav>

      <HealthBar liveEvents={liveEvents} />

      {/* Main */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', position: 'relative' }}>
        {activeTab === 'incidents' && (
          <>
            <IncidentList onSelect={setSelectedId} selectedId={selectedId} refreshTick={refreshTick} />
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <IncidentDetail id={selectedId} onRefresh={refresh} />
            </div>
          </>
        )}
        {activeTab === 'analytics' && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex' }}>
            <AnalyticsPanel />
          </div>
        )}
        {activeTab === 'inject' && (
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-base)', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 28, color: 'var(--accent)', animation: 'glowPulse 2s ease-in-out infinite' }}>∅</div>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading…</span>
    </div>
  );
  return user ? <Dashboard /> : <LoginPage />;
}
