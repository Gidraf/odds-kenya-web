'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '../../lib/api';

interface ArbSelection {
  price:        number;
  bookmaker_id: number;
  stake_pct:    number;
}

interface ArbOpportunity {
  market:      string;
  margin:      number;
  profit_pct:  number;
  selections:  Record<string, ArbSelection>;
}

interface ArbMatch {
  match_id:     number;
  home_team:    string;
  away_team:    string;
  competition:  string;
  sport:        string;
  start_time:   string;
  opportunities: ArbOpportunity[];
}

export default function ArbitragePage() {
  const [data,       setData]       = useState<ArbMatch[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [scannedAt,  setScannedAt]  = useState('');
  const [stake,      setStake]      = useState(1000);
  const [expanded,   setExpanded]   = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchWithAuth('/odds/arbitrage');
    if (res.ok) {
      const d = await res.json();
      setData(d.opportunities || []);
      setScannedAt(d.scanned_at || '');
      setExpanded(new Set(d.opportunities?.map((m: ArbMatch) => m.match_id) || []));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const bestProfit = data.length > 0
    ? Math.max(...data.flatMap(m => m.opportunities.map(o => o.profit_pct)))
    : 0;

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>ARBITRAGE SCANNER</h1>
          <p style={s.subtitle}>
            CROSS-BOOKMAKER OPPORTUNITY DETECTOR · {data.length} MATCHES · SCANNED {scannedAt ? new Date(scannedAt).toLocaleTimeString('en-KE', { hour12:false }) : '—'}
          </p>
        </div>
        <button onClick={load} style={s.refreshBtn}>↻ RESCAN</button>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        {[
          { label:'ARB MATCHES',    val: data.length,                                               color:'var(--acid)' },
          { label:'TOTAL OPPS',     val: data.reduce((s,m)=>s+m.opportunities.length,0),            color:'var(--green)' },
          { label:'BEST PROFIT',    val: bestProfit > 0 ? `${bestProfit.toFixed(3)}%` : '—',        color:'var(--cyan)' },
          { label:'STAKE (KES)',     val: stake.toLocaleString(),                                     color:'var(--amber)', editable: true },
        ].map(st => (
          <div key={st.label} style={s.statCard}>
            <div style={s.statLabel}>{st.label}</div>
            {st.editable
              ? <input
                  type="number"
                  value={stake}
                  onChange={e => setStake(Number(e.target.value))}
                  style={{ ...s.statVal, color: st.color, background:'none', border:'none', outline:'none', width:'100%', fontFamily:'var(--font-display)', fontSize:24, fontWeight:800 }}
                />
              : <div style={{ ...s.statVal, color: st.color }}>{st.val}</div>
            }
          </div>
        ))}
      </div>

      {/* No arb message */}
      {!loading && data.length === 0 && (
        <div style={s.empty}>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:32, color:'var(--text-muted)' }}>⟁</div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:4, color:'var(--text-muted)', marginTop:12 }}>
            NO ARBITRAGE OPPORTUNITIES DETECTED
          </div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', marginTop:8 }}>
            Need at least 2 bookmakers with overlapping markets
          </div>
        </div>
      )}

      {loading && (
        <div style={s.empty}>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:24, color:'var(--acid)' }}>█</div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:4, color:'var(--text-muted)', marginTop:12 }}>
            SCANNING...
          </div>
        </div>
      )}

      {/* Arb cards */}
      {!loading && data.map(match => (
        <div key={match.match_id} style={s.matchCard}>
          {/* Match header */}
          <div style={s.matchHeader} onClick={() => toggle(match.match_id)}>
            <div style={s.matchLeft}>
              <span style={s.sportChip}>{match.sport}</span>
              <span style={s.teams}>{match.home_team} <span style={{ color:'var(--text-muted)', fontWeight:400 }}>vs</span> {match.away_team}</span>
              <span style={s.compChip}>{match.competition}</span>
            </div>
            <div style={s.matchRight}>
              <span style={s.oppCount}>{match.opportunities.length} MARKET{match.opportunities.length > 1 ? 'S' : ''}</span>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:14, color:'var(--text-muted)' }}>
                {expanded.has(match.match_id) ? '▲' : '▼'}
              </span>
            </div>
          </div>

          {/* Opportunities */}
          {expanded.has(match.match_id) && (
            <div style={s.oppsWrap}>
              {match.opportunities.map((opp, i) => {
                const profitKes = (stake * opp.profit_pct / 100).toFixed(2);
                return (
                  <div key={i} style={s.oppCard}>
                    {/* Opportunity header */}
                    <div style={s.oppHeader}>
                      <span style={s.marketName}>{opp.market}</span>
                      <div style={s.oppMeta}>
                        <span style={s.marginVal}>
                          MARGIN: <span style={{ color: opp.margin < 0.95 ? 'var(--green)' : 'var(--acid)' }}>
                            {(opp.margin * 100).toFixed(3)}%
                          </span>
                        </span>
                        <span style={s.profitVal}>
                          PROFIT: <span style={{ color:'var(--green)', fontWeight:700 }}>
                            {opp.profit_pct.toFixed(3)}% · KES {profitKes}
                          </span>
                        </span>
                      </div>
                    </div>

                    {/* Selection breakdown */}
                    <div style={s.selectionsGrid}>
                      {Object.entries(opp.selections).map(([sel, data]) => {
                        const stakeOnThis = (stake * data.stake_pct / 100).toFixed(2);
                        return (
                          <div key={sel} style={s.selCard}>
                            <div style={s.selName}>{sel}</div>
                            <div style={s.selPrice}>{data.price.toFixed(2)}</div>
                            <div style={s.selBook}>BK #{data.bookmaker_id}</div>
                            <div style={s.selStake}>
                              <span style={s.selStakeLabel}>STAKE</span>
                              <span style={s.selStakeVal}>KES {stakeOnThis}</span>
                            </div>
                            <div style={s.selStake}>
                              <span style={s.selStakeLabel}>RETURN</span>
                              <span style={{ ...s.selStakeVal, color:'var(--green)' }}>
                                KES {(parseFloat(stakeOnThis) * data.price).toFixed(2)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Summary bar */}
                    <div style={s.summaryBar}>
                      <span style={s.summaryItem}>
                        TOTAL STAKE: <strong style={{ color:'var(--acid)' }}>KES {stake.toLocaleString()}</strong>
                      </span>
                      <span style={s.summaryItem}>
                        GUARANTEED RETURN: <strong style={{ color:'var(--green)' }}>
                          KES {(stake * (1 + opp.profit_pct / 100)).toFixed(2)}
                        </strong>
                      </span>
                      <span style={s.summaryItem}>
                        NET PROFIT: <strong style={{ color:'var(--green)' }}>KES {profitKes}</strong>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:       { display:'flex', flexDirection:'column', gap:16 },
  header:     { display:'flex', justifyContent:'space-between', alignItems:'flex-start' },
  title:      { fontFamily:'var(--font-display)', fontSize:28, fontWeight:800, letterSpacing:3 },
  subtitle:   { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'var(--text-muted)', marginTop:2 },
  refreshBtn: { background:'none', border:'1px solid var(--border-base)', color:'var(--acid)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'6px 14px', cursor:'pointer' },

  statsRow:   { display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 },
  statCard:   { background:'var(--bg-surface)', border:'1px solid var(--border-dim)', padding:'14px 16px' },
  statLabel:  { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'var(--text-muted)', marginBottom:6 },
  statVal:    { fontFamily:'var(--font-display)', fontSize:24, fontWeight:800, lineHeight:1 },

  empty:      { display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'60px 0' },

  matchCard:  { background:'var(--bg-surface)', border:'1px solid rgba(198,241,53,0.2)', overflow:'hidden' },
  matchHeader:{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', cursor:'pointer' },
  matchLeft:  { display:'flex', alignItems:'center', gap:10, flex:1 },
  matchRight: { display:'flex', alignItems:'center', gap:12 },
  sportChip:  { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'var(--cyan)', background:'var(--bg-elevated)', padding:'2px 7px', flexShrink:0 },
  teams:      { fontFamily:'var(--font-display)', fontSize:16, fontWeight:700, color:'var(--text-primary)', letterSpacing:1 },
  compChip:   { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1 },
  oppCount:   { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, color:'var(--acid)', border:'1px solid rgba(198,241,53,0.3)', padding:'3px 10px' },

  oppsWrap:   { borderTop:'1px solid var(--border-dim)', padding:'12px', display:'flex', flexDirection:'column', gap:10 },

  oppCard:    { background:'var(--bg-base)', border:'1px solid rgba(0,230,118,0.2)', overflow:'hidden' },
  oppHeader:  { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 14px', background:'rgba(0,230,118,0.05)', borderBottom:'1px solid rgba(0,230,118,0.1)' },
  marketName: { fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:2, color:'var(--text-primary)', fontWeight:600 },
  oppMeta:    { display:'flex', gap:20 },
  marginVal:  { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:1, color:'var(--text-muted)' },
  profitVal:  { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:1, color:'var(--text-muted)' },

  selectionsGrid: { display:'flex', gap:8, padding:'10px 14px', flexWrap:'wrap' },
  selCard:    { background:'var(--bg-elevated)', border:'1px solid var(--border-dim)', padding:'10px 14px', flex:1, minWidth:140, display:'flex', flexDirection:'column', gap:4 },
  selName:    { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, color:'var(--text-muted)' },
  selPrice:   { fontFamily:'var(--font-display)', fontSize:22, fontWeight:800, color:'var(--acid)', lineHeight:1 },
  selBook:    { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--cyan)', letterSpacing:1 },
  selStake:   { display:'flex', justifyContent:'space-between', marginTop:2 },
  selStakeLabel: { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1 },
  selStakeVal:   { fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-secondary)', fontWeight:600 },

  summaryBar: { display:'flex', gap:24, padding:'8px 14px', borderTop:'1px solid var(--border-dim)', background:'rgba(0,230,118,0.04)', flexWrap:'wrap' },
  summaryItem:{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-muted)' },
};