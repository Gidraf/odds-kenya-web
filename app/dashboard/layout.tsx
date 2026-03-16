'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAdminSocket } from '../lib/useSocket';

const NAV = [
  { path: '/dashboard',            icon: '◈', label: 'ODDS MATRIX' },
  { path: '/dashboard/arb',        icon: '⟁', label: 'ARBITRAGE' },
  { path: '/dashboard/bookmakers', icon: '◎', label: 'BOOKMAKERS' },
  { path: '/dashboard/research',   icon: '🔬', label: 'RESEARCH LAB' },
  { path: '/dashboard/onboard',    icon: '⊕', label: 'ONBOARD AGENT' },
  { path: '/dashboard/logs',       icon: '▸', label: 'LIVE TELEMETRY' },
  { path: '/dashboard/sports-data-manager',       icon: '▸', label: 'DATA MANAGER' },
  { path: '/dashboard/bookmarker-mapping',       icon: '▸', label: 'MAPPING WIZARD' },
  { path: '/dashboard/mapping-manager',       icon: '▸', label: 'MAPPING MANGER' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { connected } = useAdminSocket();

  return (
    <div style={styles.shell}>
      {/* ── Sidebar ── */}
      <aside style={styles.sidebar}>
        {/* Logo */}
        <div style={styles.logoWrap}>
          <span style={styles.logoMark}>[OT]</span>
          <div>
            <div style={styles.logoName}>ODDS TERMINAL</div>
            <div style={styles.logoVersion}>v2.0 · KENYA</div>
          </div>
        </div>

        {/* Status bar */}
        <div style={styles.statusBar}>
          <span style={{ ...styles.statusDot, background: connected ? 'var(--green)' : 'var(--red)', animation: connected ? 'pulse-dot 2s infinite' : 'none' }} />
          <span style={styles.statusText}>{connected ? 'AGENT ONLINE' : 'DISCONNECTED'}</span>
        </div>

        {/* Nav */}
        <nav style={styles.nav}>
          {NAV.map(item => {
            const active = pathname === item.path;
            return (
              <Link key={item.path} href={item.path} style={{ textDecoration: 'none' }}>
                <div style={{
                  ...styles.navItem,
                  ...(active ? styles.navItemActive : {}),
                }}>
                  <span style={{ ...styles.navIcon, color: active ? 'var(--acid)' : 'var(--text-muted)' }}>
                    {item.icon}
                  </span>
                  <span style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {item.label}
                  </span>
                  {active && <div style={styles.navActiveBar} />}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div style={styles.sidebarBottom}>
          <div style={styles.sysInfo}>
            <div style={styles.sysRow}><span style={styles.sysKey}>HARVEST</span><span style={styles.sysVal}>60s</span></div>
            <div style={styles.sysRow}><span style={styles.sysKey}>MODE</span><span style={styles.sysVal}>LIVE</span></div>
          </div>
          <button onClick={() => { localStorage.removeItem('token'); router.push('/login'); }} style={styles.logoutBtn}>
            ⏻ LOGOUT
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={styles.main}>
        {/* Top bar */}
        <div style={styles.topbar}>
          <div style={styles.breadcrumb}>
            {pathname.replace('/dashboard', '').split('/').filter(Boolean).map((seg, i) => (
              <span key={i} style={styles.breadcrumbSeg}>{seg.toUpperCase()}</span>
            ))}
            {pathname === '/dashboard' && <span style={styles.breadcrumbSeg}>ODDS MATRIX</span>}
          </div>
          <div style={styles.clock}>
            <ClockDisplay />
          </div>
        </div>

        <div style={styles.content}>{children}</div>
      </main>
    </div>
  );
}

function ClockDisplay() {
  const [time, setTime] = require('react').useState(new Date());
  require('react').useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', letterSpacing: 2 }}>
      {time.toISOString().replace('T', ' ').slice(0, 19)} UTC
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { display: 'flex', height: '100vh', background: 'var(--bg-void)', overflow: 'hidden' },

  sidebar: {
    width: 220, flexShrink: 0,
    background: 'var(--bg-surface)',
    borderRight: '1px solid var(--border-dim)',
    display: 'flex', flexDirection: 'column',
    padding: '24px 0',
  },
  logoWrap: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '0 20px 20px',
    borderBottom: '1px solid var(--border-dim)',
    marginBottom: 16,
  },
  logoMark: {
    fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600,
    color: 'var(--acid)', letterSpacing: 2,
  },
  logoName: { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, letterSpacing: 3, color: 'var(--text-primary)' },
  logoVersion: { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 2, marginTop: 1 },

  statusBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 20px', marginBottom: 16,
    background: 'var(--bg-base)',
    borderTop: '1px solid var(--border-dim)',
    borderBottom: '1px solid var(--border-dim)',
  },
  statusDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  statusText: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' },

  nav: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px' },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 12px',
    cursor: 'pointer', position: 'relative',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2,
    transition: 'background 0.15s',
    borderRadius: 2,
  },
  navItemActive: { background: 'var(--bg-elevated)' },
  navIcon: { fontSize: 14, width: 16, textAlign: 'center', flexShrink: 0 },
  navActiveBar: {
    position: 'absolute', left: 0, top: '20%', bottom: '20%',
    width: 2, background: 'var(--acid)',
    borderRadius: 1,
  },

  sidebarBottom: { padding: '16px 20px', borderTop: '1px solid var(--border-dim)', marginTop: 8 },
  sysInfo: { marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 },
  sysRow: { display: 'flex', justifyContent: 'space-between' },
  sysKey: { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 2 },
  sysVal: { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)', letterSpacing: 1 },
  logoutBtn: {
    width: '100%', padding: '8px',
    background: 'transparent',
    border: '1px solid var(--border-base)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },

  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topbar: {
    height: 44,
    borderBottom: '1px solid var(--border-dim)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 24px', flexShrink: 0,
    background: 'var(--bg-base)',
  },
  breadcrumb: { display: 'flex', gap: 8, alignItems: 'center' },
  breadcrumbSeg: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 3,
    color: 'var(--acid)',
  },
  clock: {},
  content: { flex: 1, overflow: 'auto', padding: '24px' },
};