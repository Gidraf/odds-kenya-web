'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Odd {
  bookmaker_id:   number;
  bookmaker_name: string;
  selection_name: string;
  price:          number;
  last_updated:   string;
}

interface Market {
  market_name: string;
  odds:        Odd[];
}

interface Match {
  match_id:    number;
  home_team:   string;
  away_team:   string;
  competition: string;
  sport:       string;
  start_time:  string;
  status:      string;
  markets:     Market[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function priceDelta(odds: Odd[]): number {
  if (odds.length < 2) return 0;
  const prices = odds.map(o => o.price).sort((a, b) => b - a);
  return +(prices[0] - prices[1]).toFixed(3);
}

function impliedProb(price: number): string {
  return ((1 / price) * 100).toFixed(1) + '%';
}

function priceColor(price: number, odds: Odd[]): string {
  const max = Math.max(...odds.map(o => o.price));
  const min = Math.min(...odds.map(o => o.price));
  if (price === max) return 'var(--green)';
  if (price === min && odds.length > 1) return 'var(--red)';
  return 'var(--text-secondary)';
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function matchTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'var(--acid)' }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div style={st.statCard}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 3, color: 'var(--text-muted)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 4, letterSpacing: 1 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── MarketTable ──────────────────────────────────────────────────────────────

function MarketTable({ market }: { market: Market }) {
  const { odds } = market;
  if (!odds.length) return null;

  const selections = [...new Set(odds.map(o => o.selection_name))];

  return (
    <div style={st.marketBlock}>
      <div style={st.marketName}>{market.market_name}</div>
      <div style={st.oddsGrid}>
        {selections.map(sel => {
          const selOdds = odds.filter(o => o.selection_name === sel);
          return (
            <div key={sel} style={st.selectionRow}>
              <div style={st.selLabel}>{sel}</div>
              <div style={st.bookOdds}>
                {selOdds.map((o, i) => (
                  <div key={i} style={st.oddPill}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 8, letterSpacing: 1 }}>
                      {o.bookmaker_name || `BK${o.bookmaker_id}`}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: priceColor(o.price, selOdds) }}>
                      {o.price.toFixed(2)}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 8 }}>
                      {impliedProb(o.price)}
                    </span>
                  </div>
                ))}
              </div>
              {selOdds.length > 1 && (
                <div style={st.deltaCol}>
                  <span style={{ color: 'var(--acid)', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600 }}>
                    +{priceDelta(selOdds).toFixed(2)}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 8, letterSpacing: 1 }}>SPREAD</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MatchCard ────────────────────────────────────────────────────────────────

function MatchCard({ match, expanded, onToggle }: {
  match: Match; expanded: boolean; onToggle: () => void;
}) {
  const allOdds = match.markets.flatMap(m => m.odds);
  const bookIds = [...new Set(allOdds.map(o => o.bookmaker_id))];
  const isLive  = match.status === 'LIVE' || match.status === 'IN_PLAY';

  return (
    <div style={{ ...st.matchCard, borderColor: isLive ? 'rgba(0,230,118,0.3)' : 'var(--border-dim)' }}>
      <div style={st.matchHeader} onClick={onToggle}>
        <div style={st.matchLeft}>
          {isLive && <span style={st.liveBadge}>● LIVE</span>}
          <div style={st.teams}>
            <span style={st.teamName}>{match.home_team}</span>
            <span style={st.vs}>vs</span>
            <span style={st.teamName}>{match.away_team}</span>
          </div>
          <div style={st.matchMeta}>
            <span style={st.metaChip}>{match.sport}</span>
            <span style={st.metaChip}>{match.competition}</span>
            <span style={{ ...st.metaChip, color: 'var(--text-muted)' }}>
              {isLive ? 'LIVE NOW' : matchTime(match.start_time)}
            </span>
          </div>
        </div>

        <div style={st.matchRight}>
          <div style={st.matchStats}>
            <div style={st.matchStat}>
              <span style={st.matchStatVal}>{bookIds.length}</span>
              <span style={st.matchStatLabel}>BOOKS</span>
            </div>
            <div style={st.matchStat}>
              <span style={st.matchStatVal}>{match.markets.length}</span>
              <span style={st.matchStatLabel}>MKTS</span>
            </div>
            <div style={st.matchStat}>
              <span style={st.matchStatVal}>{allOdds.length}</span>
              <span style={st.matchStatLabel}>ODDS</span>
            </div>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-muted)', marginLeft: 12 }}>
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {expanded && (
        <div style={st.marketsWrap}>
          {match.markets.length === 0
            ? <div style={st.noMarkets}>No market data yet</div>
            : match.markets.map((mkt, i) => <MarketTable key={i} market={mkt} />)
          }
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OddsMatrix() {
  const [matches,     setMatches]     = useState<Match[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [lastUpdate,  setLastUpdate]  = useState('');
  const [expanded,    setExpanded]    = useState<Set<number>>(new Set());
  const [sportFilter, setSportFilter] = useState('ALL');
  const [search,      setSearch]      = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/odds/');
      if (res.ok) {
        const data = await res.json();
        // Handle both plain array and paginated { matches: [] } response shapes
        const list: Match[] = Array.isArray(data) ? data : (data.matches ?? []);
        setMatches(list);
        setLastUpdate(new Date().toISOString());
        setError('');
        // Auto-expand first 3 on initial load only
        setExpanded(prev => {
          if (prev.size > 0) return prev;
          return new Set(list.slice(0, 3).map(m => m.match_id));
        });
      } else {
        setError(`API error ${res.status}`);
      }
    } catch {
      setError('Could not reach backend');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const sports  = ['ALL', ...new Set(matches.map(m => m.sport))];
  const visible = matches.filter(m => {
    const sportOk  = sportFilter === 'ALL' || m.sport === sportFilter;
    const searchOk = !search || `${m.home_team} ${m.away_team} ${m.competition}`.toLowerCase().includes(search.toLowerCase());
    return sportOk && searchOk;
  });

  const liveCount  = matches.filter(m => m.status === 'LIVE' || m.status === 'IN_PLAY').length;
  const totalOdds  = matches.reduce((s, m) => s + m.markets.flatMap(mk => mk.odds).length, 0);
  const totalBooks = new Set(matches.flatMap(m => m.markets.flatMap(mk => mk.odds.map(o => o.bookmaker_id)))).size;

  return (
    <div style={st.root}>

      {/* Header */}
      <div style={st.header}>
        <div>
          <h1 style={st.title}>ODDS MATRIX</h1>
          <p style={st.subtitle}>
            LIVE COMPARISON ENGINE · {matches.length} MATCHES · {totalOdds} ODDS · {totalBooks} BOOKMAKERS
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={load} style={st.refreshBtn}>↻ REFRESH</button>
          <button
            onClick={() => setAutoRefresh(a => !a)}
            style={{ ...st.refreshBtn, color: autoRefresh ? 'var(--green)' : 'var(--text-muted)', borderColor: autoRefresh ? 'rgba(0,230,118,0.3)' : 'var(--border-base)' }}
          >
            {autoRefresh ? '● AUTO' : '○ AUTO'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={st.statsRow}>
        <StatCard label="MATCHES"     value={matches.length} sub="loaded" />
        <StatCard label="LIVE"        value={liveCount}      sub="in play"          color="var(--green)" />
        <StatCard label="TOTAL ODDS"  value={totalOdds}      sub="across all books" color="var(--cyan)" />
        <StatCard label="BOOKMAKERS"  value={totalBooks}     sub="active feeds"     color="var(--amber)" />
        <StatCard label="LAST UPDATE" value={lastUpdate ? timeAgo(lastUpdate) : '—'} sub="auto every 60s" color="var(--text-secondary)" />
      </div>

      {/* Filters */}
      <div style={st.filters}>
        <div style={st.sportTabs}>
          {sports.map(sp => (
            <button key={sp} onClick={() => setSportFilter(sp)} style={{
              ...st.sportTab,
              color:             sportFilter === sp ? 'var(--acid)' : 'var(--text-muted)',
              borderBottomColor: sportFilter === sp ? 'var(--acid)' : 'transparent',
            }}>
              {sp}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search team, competition..."
          style={st.search}
        />
        <button onClick={() => setExpanded(new Set(visible.map(m => m.match_id)))} style={st.ctrlBtn}>
          ↕ EXPAND ALL
        </button>
        <button onClick={() => setExpanded(new Set())} style={st.ctrlBtn}>
          ↕ COLLAPSE
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div style={st.center}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, color: 'var(--acid)' }}>█</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 4, color: 'var(--text-muted)', marginTop: 12 }}>
            LOADING ODDS MATRIX...
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div style={st.errorBox}>
          <span style={{ color: 'var(--red)' }}>✗</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{error}</span>
          <button onClick={load} style={{ ...st.ctrlBtn, marginLeft: 'auto' }}>RETRY</button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && visible.length === 0 && (
        <div style={st.center}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', letterSpacing: 3 }}>
            {matches.length === 0 ? 'NO MATCHES — ONBOARD A BOOKMAKER TO START' : 'NO MATCHES MATCH YOUR FILTER'}
          </div>
        </div>
      )}

      {/* Match list */}
      {!loading && visible.length > 0 && (
        <div style={st.matchList}>
          {visible.map(match => (
            <MatchCard
              key={match.match_id}
              match={match}
              expanded={expanded.has(match.match_id)}
              onToggle={() => toggle(match.match_id)}
            />
          ))}
        </div>
      )}

    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  root:       { display: 'flex', flexDirection: 'column', gap: 16 },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title:      { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: 3 },
  subtitle:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 3, color: 'var(--text-muted)', marginTop: 2 },

  statsRow:   { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 },
  statCard:   { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', padding: '14px 16px' },

  filters:    { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', padding: '8px 12px' },
  sportTabs:  { display: 'flex', gap: 0, borderRight: '1px solid var(--border-dim)', paddingRight: 12, marginRight: 4 },
  sportTab:   { background: 'none', border: 'none', borderBottom: '2px solid', marginBottom: -1, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '4px 10px', cursor: 'pointer' },
  search:     { flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none' },
  ctrlBtn:    { background: 'none', border: '1px solid var(--border-base)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  refreshBtn: { background: 'none', border: '1px solid var(--border-base)', color: 'var(--acid)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '6px 12px', cursor: 'pointer' },

  matchList:     { display: 'flex', flexDirection: 'column', gap: 8 },
  matchCard:     { background: 'var(--bg-surface)', border: '1px solid', overflow: 'hidden', transition: 'border-color 0.2s' },
  matchHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' },
  matchLeft:     { display: 'flex', flexDirection: 'column', gap: 6 },
  matchRight:    { display: 'flex', alignItems: 'center', flexShrink: 0 },
  liveBadge:     { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--green)', background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)', padding: '2px 8px', width: 'fit-content' },
  teams:         { display: 'flex', alignItems: 'center', gap: 10 },
  teamName:      { fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: 1 },
  vs:            { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2 },
  matchMeta:     { display: 'flex', gap: 6, alignItems: 'center' },
  metaChip:      { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1, color: 'var(--cyan)', background: 'var(--bg-elevated)', padding: '2px 6px' },
  matchStats:    { display: 'flex', gap: 16 },
  matchStat:     { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  matchStatVal:  { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--acid)', lineHeight: 1 },
  matchStatLabel:{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)' },

  marketsWrap: { borderTop: '1px solid var(--border-dim)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  noMarkets:   { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2, textAlign: 'center' as const, padding: 16 },
  marketBlock: { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '10px 14px' },
  marketName:  { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, color: 'var(--cyan)', marginBottom: 10 },
  oddsGrid:    { display: 'flex', flexDirection: 'column', gap: 6 },

  selectionRow: { display: 'flex', alignItems: 'center', gap: 12 },
  selLabel:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', width: 80, flexShrink: 0, letterSpacing: 1 },
  bookOdds:     { display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap' as const },
  oddPill:      { display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)', padding: '5px 10px', gap: 2, minWidth: 70 },
  deltaCol:     { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0, minWidth: 64 },

  center:   { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 12 },
  errorBox: { display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,61,90,0.07)', border: '1px solid rgba(255,61,90,0.3)', padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' },
};