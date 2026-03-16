/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
/**
 * MatchDetailView.tsx
 * ====================
 * Click any match → fetches GetGameZip for every bookmaker that has that match_id.
 * Auto-refreshes every 4 seconds. Detects arbitrage opportunities across bookmakers.
 *
 * Props:
 *   match       - merged match object from probe-all / odds feed
 *   bookmakers  - full bookmaker list (for domain + config lookup)
 *   onClose     - dismiss callback
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchWithAuth } from '../../lib/api';

const M = "'IBM Plex Mono','Fira Code',monospace";
const BK_COLORS = ['#C6F135','#38BDF8','#FB923C','#A78BFA','#F472B6','#34D399','#FBBF24','#60A5FA'];
const getBkColor = (i: number) => BK_COLORS[i % BK_COLORS.length];

// ─── Types ────────────────────────────────────────────────────────────────────

interface MergedMatch {
  home_team:   string;
  away_team:   string;
  sport:       string;
  competition: string;
  start_time:  string | null;
  status:      string;
  score_home:  number | null;
  score_away:  number | null;
  bookmakers:  Record<string, { match_id: string; markets: Record<string, Record<string, number>> }>;
  markets:     any;
}

interface GameZipResult {
  match_id:     string;
  home_team:    string;
  away_team:    string;
  competition:  string;
  win_probs?:   { P1: number; PX: number; P2: number } | null;
  markets:      Record<string, Record<string, number>>;
  market_count: number;
  fetched_at?:  number;
  error?:       string;
}

interface ArbitrageOpp {
  market:   string;
  bets: { bookmaker: string; outcome: string; odds: number; stake: number }[];
  profit_pct: number;
  total_return: number;
}

// ─── Arbitrage engine ─────────────────────────────────────────────────────────

/**
 * Detect arbitrage across bookmakers for all shared markets.
 * For each (market, outcome), find the best odds available from any bookmaker.
 * If sum(1/best_odds_per_outcome) < 1, there's an arb.
 */
function detectArbitrage(
  bkNames: string[],
  allMarkets: Record<string, Record<string, Record<string, number>>>,  // bk → mkt → outcome → odds
): ArbitrageOpp[] {
  const opps: ArbitrageOpp[] = [];

  // Collect all market keys present in any bookmaker
  const mkts = new Set<string>();
  Object.values(allMarkets).forEach(bkData => Object.keys(bkData).forEach(m => mkts.add(m)));

  for (const mkt of mkts) {
    // Collect all outcomes across all bookmakers for this market
    const outcomes = new Set<string>();
    bkNames.forEach(bk => {
      Object.keys(allMarkets[bk]?.[mkt] ?? {}).forEach(o => outcomes.add(o));
    });

    if (outcomes.size < 2) continue;

    // For each outcome, find the best odds and which bookmaker offers them
    const best: Record<string, { bk: string; odds: number }> = {};
    for (const outcome of outcomes) {
      let bestOdds = 0, bestBk = '';
      bkNames.forEach(bk => {
        const o = allMarkets[bk]?.[mkt]?.[outcome] ?? 0;
        if (o > bestOdds) { bestOdds = o; bestBk = bk; }
      });
      if (bestOdds > 1) best[outcome] = { bk: bestBk, odds: bestOdds };
    }

    const covered = Object.keys(best);
    if (covered.length < 2) continue;

    // Sum of implied probabilities
    const impliedSum = covered.reduce((s, o) => s + 1 / best[o].odds, 0);
    if (impliedSum >= 1.0) continue; // no arb

    // Calculate stakes for 100 unit profit
    const profitPct = ((1 - impliedSum) / impliedSum) * 100;
    const totalReturn = 100;
    const bets = covered.map(o => ({
      bookmaker: best[o].bk,
      outcome:   o,
      odds:      best[o].odds,
      stake:     Math.round((totalReturn / best[o].odds) * 100) / 100,
    }));

    opps.push({ market: mkt, bets, profit_pct: profitPct, total_return: totalReturn });
  }

  return opps.sort((a, b) => b.profit_pct - a.profit_pct);
}

// ─── Market group display order ───────────────────────────────────────────────

const MKT_ORDER = ['1X2','Double Chance','BTTS','GG/NG','Draw No Bet'];
const MKT_GROUP_LABELS: Record<string, string> = {
  '1X2':'Match Result', 'Double Chance':'Double Chance', 'BTTS':'Both Teams Score',
  'GG/NG':'GG / NG', 'Draw No Bet':'Draw No Bet', 'Handicap':'Asian Handicap',
  '1H Result':'Half Time Result', '2H Result':'2nd Half Result',
  '1H Double Chance':'HT Double Chance', 'Win to Nil':'Win to Nil',
  'Clean Sheet':'Clean Sheet',
};
const isLineMarket = (k: string) => k.includes('_') && !['1X2','Double Chance','BTTS','GG/NG','Draw No Bet','1H Result','2H Result','HT/FT','Clean Sheet','Win to Nil','Win Both Halves','Score Both Halves'].includes(k);
const marketBaseName = (k: string) => {
  if (!isLineMarket(k)) return k;
  return k.substring(0, k.lastIndexOf('_'));
};

function groupMarkets(keys: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const fixed = keys.filter(k => !isLineMarket(k));
  const lined  = keys.filter(k => isLineMarket(k));

  // Fixed markets: each gets its own group
  for (const k of fixed) { groups[k] = [k]; }

  // Line markets: group by base name (Total, Handicap, Corners, etc.)
  for (const k of lined) {
    const base = marketBaseName(k);
    if (!groups[base]) groups[base] = [];
    groups[base].push(k);
  }

  // Sort line keys within each group numerically by specifier
  for (const base of Object.keys(groups)) {
    groups[base].sort((a, b) => {
      const pA = parseFloat(a.split('_').pop()!);
      const pB = parseFloat(b.split('_').pop()!);
      return (isNaN(pA) ? 0 : pA) - (isNaN(pB) ? 0 : pB);
    });
  }

  return groups;
}

// ─── Single odds cell ─────────────────────────────────────────────────────────

function OddsCell({ v, best, arb }: { v?: number; best: boolean; arb: boolean }) {
  if (!v || v <= 1) return (
    <td style={{ padding:'5px 10px', textAlign:'center', color:'rgba(100,116,139,0.3)', fontFamily:M, fontSize:11 }}>—</td>
  );
  return (
    <td style={{
      padding:'5px 10px', textAlign:'center', fontFamily:M, fontWeight: best ? 800 : 400,
      fontSize: best ? 14 : 12,
      color: arb ? '#C6F135' : best ? 'var(--text-primary)' : 'rgba(200,210,220,0.7)',
      background: arb ? 'rgba(198,241,53,0.1)' : best ? 'rgba(255,255,255,0.04)' : 'transparent',
      position:'relative',
      borderRight:'1px solid rgba(255,255,255,0.05)',
      transition:'all .15s',
    }}>
      {arb && <span style={{ position:'absolute', top:2, left:3, fontSize:7, color:'#C6F135', fontFamily:M }}>ARB</span>}
      {best && !arb && <span style={{ position:'absolute', top:2, right:3, fontSize:6, color:'rgba(198,241,53,0.6)', fontFamily:M }}>▲</span>}
      {v.toFixed(2)}
    </td>
  );
}

// ─── Market group table ───────────────────────────────────────────────────────

function MarketGroupTable({
  groupName, keys, bkNames, bkData, arbMkts,
}: {
  groupName:  string;
  keys:       string[];
  bkNames:    string[];
  bkData:     Record<string, Record<string, Record<string, number>>>;
  arbMkts:    Set<string>;
}) {
  // Collect all outcomes in this group
  const allOutcomes = [...new Set(
    keys.flatMap(k => bkNames.flatMap(bk => Object.keys(bkData[bk]?.[k] ?? {})))
  )];

  if (!allOutcomes.length) return null;

  const isLine = keys.length > 1 && keys.every(k => isLineMarket(k));
  const label = MKT_GROUP_LABELS[groupName] ?? groupName;
  const hasArb = keys.some(k => arbMkts.has(k));

  return (
    <div style={{ marginBottom:1 }}>
      {/* Group header */}
      <div style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'5px 12px', background:'rgba(0,0,0,0.4)',
        borderLeft:`3px solid ${hasArb ? '#C6F135' : 'rgba(255,255,255,0.1)'}`,
      }}>
        <span style={{ fontFamily:M, fontSize:8, letterSpacing:1.5, color: hasArb ? '#C6F135' : 'rgba(100,116,139,0.8)' }}>
          {label.toUpperCase()}
        </span>
        {hasArb && <span style={{ fontFamily:M, fontSize:7, color:'#C6F135', background:'rgba(198,241,53,0.12)', padding:'1px 6px', border:'1px solid rgba(198,241,53,0.4)' }}>ARB ★</span>}
      </div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ borderCollapse:'collapse', width:'100%', minWidth:300 }}>
          <thead>
            <tr style={{ background:'rgba(0,0,0,0.25)' }}>
              {isLine && <th style={thS}>LINE</th>}
              <th style={{ ...thS, textAlign:'left', minWidth:70 }}>OUTCOME</th>
              {bkNames.map((bk, i) => (
                <th key={bk} style={{ ...thS, color: getBkColor(i), minWidth:62 }}>
                  {bk.length > 7 ? bk.substring(0,6)+'…' : bk}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLine
              ? /* Line market: rows = specifier, cols = outcomes + bookmakers */
                keys.map(k => {
                  const spec = k.split('_').pop()!;
                  const isArb = arbMkts.has(k);
                  return allOutcomes.map((outcome, oi) => {
                    const vals: Record<string, number> = {};
                    bkNames.forEach(bk => { const v = bkData[bk]?.[k]?.[outcome]; if (v) vals[bk] = v; });
                    const maxV = Math.max(...Object.values(vals), 0);
                    const isArbBk = (bk: string) => isArb; // mark all cells for arb markets
                    return (
                      <tr key={`${k}-${outcome}`} style={{
                        borderBottom:'1px solid rgba(255,255,255,0.03)',
                        background: oi === 0 ? 'rgba(255,255,255,0.015)' : 'transparent',
                      }}>
                        {oi === 0 && (
                          <td rowSpan={allOutcomes.length} style={{
                            padding:'5px 10px', fontFamily:M, fontSize:9, fontWeight:800,
                            color: isArb ? '#C6F135' : 'rgba(198,241,53,0.5)',
                            textAlign:'center', borderRight:'1px solid rgba(255,255,255,0.08)',
                            whiteSpace:'nowrap', verticalAlign:'middle',
                          }}>{spec}</td>
                        )}
                        <td style={{ padding:'5px 10px', fontFamily:M, fontSize:8, color:'rgba(150,160,175,0.9)', borderRight:'1px solid rgba(255,255,255,0.06)', whiteSpace:'nowrap' }}>
                          {outcome}
                        </td>
                        {bkNames.map(bk => (
                          <OddsCell key={bk} v={vals[bk]} best={!!vals[bk] && vals[bk] === maxV && Object.keys(vals).length > 1} arb={isArbBk(bk) && !!vals[bk] && vals[bk] === maxV} />
                        ))}
                      </tr>
                    );
                  });
                })
              : /* Fixed market: rows = outcomes */
                allOutcomes.map((outcome, oi) => {
                  const k = keys[0];
                  const isArb = arbMkts.has(k);
                  const vals: Record<string, number> = {};
                  bkNames.forEach(bk => { const v = bkData[bk]?.[k]?.[outcome]; if (v) vals[bk] = v; });
                  const maxV = Math.max(...Object.values(vals), 0);
                  return (
                    <tr key={outcome} style={{
                      borderBottom:'1px solid rgba(255,255,255,0.03)',
                      background: oi % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent',
                    }}>
                      <td style={{ padding:'5px 10px', fontFamily:M, fontSize:9, color:'rgba(150,160,175,0.9)', borderRight:'1px solid rgba(255,255,255,0.06)', whiteSpace:'nowrap' }}>
                        {outcome}
                      </td>
                      {bkNames.map(bk => (
                        <OddsCell key={bk} v={vals[bk]} best={!!vals[bk] && vals[bk] === maxV && Object.keys(vals).length > 1}
                          arb={isArb && !!vals[bk] && vals[bk] === maxV} />
                      ))}
                    </tr>
                  );
                })
            }
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thS: React.CSSProperties = {
  fontFamily:M, fontSize:7, letterSpacing:1.5, color:'rgba(100,116,139,0.7)',
  padding:'5px 10px', textAlign:'center', borderBottom:'1px solid rgba(255,255,255,0.08)',
  borderRight:'1px solid rgba(255,255,255,0.05)', whiteSpace:'nowrap',
};

// ─── Arbitrage panel ──────────────────────────────────────────────────────────

function ArbitragePanel({ opps, bkNames }: { opps: ArbitrageOpp[]; bkNames: string[] }) {
  if (!opps.length) return (
    <div style={{ padding:'12px 16px', background:'rgba(0,0,0,0.3)', border:'1px solid rgba(255,255,255,0.06)', fontFamily:M, fontSize:8, color:'rgba(100,116,139,0.6)', textAlign:'center' }}>
      No arbitrage opportunities detected — bookmakers are aligned on this match.
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {opps.map((opp, i) => (
        <div key={i} style={{
          border:'1px solid rgba(198,241,53,0.35)', background:'rgba(198,241,53,0.04)',
          padding:'12px 16px',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
            <span style={{ fontFamily:M, fontSize:9, fontWeight:800, letterSpacing:2, color:'#C6F135' }}>
              ★ ARB {i + 1}
            </span>
            <span style={{ fontFamily:M, fontSize:10, fontWeight:800, color:'#C6F135' }}>
              +{opp.profit_pct.toFixed(2)}%
            </span>
            <span style={{ fontFamily:M, fontSize:8, color:'rgba(198,241,53,0.6)' }}>
              on {opp.market}
            </span>
            <span style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.6)', marginLeft:'auto' }}>
              guaranteed profit per {opp.total_return} units wagered
            </span>
          </div>

          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {opp.bets.map((bet, j) => {
              const bkIdx = bkNames.indexOf(bet.bookmaker);
              const c = getBkColor(bkIdx);
              return (
                <div key={j} style={{ flex:1, minWidth:130, padding:'8px 12px', background:'rgba(0,0,0,0.4)', border:`1px solid ${c}40` }}>
                  <div style={{ fontFamily:M, fontSize:7, color:c, letterSpacing:1, marginBottom:4 }}>
                    {bet.bookmaker.toUpperCase()}
                  </div>
                  <div style={{ fontFamily:M, fontSize:9, color:'rgba(180,190,200,0.9)', marginBottom:4 }}>
                    {bet.outcome}
                  </div>
                  <div style={{ display:'flex', gap:10, alignItems:'baseline' }}>
                    <span style={{ fontFamily:M, fontSize:14, fontWeight:800, color:c }}>
                      {bet.odds.toFixed(2)}
                    </span>
                    <span style={{ fontFamily:M, fontSize:8, color:'rgba(100,116,139,0.7)' }}>
                      stake: <span style={{ color:'rgba(200,210,220,0.8)' }}>{bet.stake.toFixed(2)}</span>
                    </span>
                  </div>
                  <div style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.5)', marginTop:3 }}>
                    return: {(bet.stake * bet.odds).toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Implied sum */}
          <div style={{ marginTop:8, fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.5)' }}>
            Implied probability sum: {opp.bets.reduce((s, b) => s + 1/b.odds, 0).toFixed(4)} (below 1.0 = arb exists)
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MatchDetailView({
  match,
  bookmakers,
  onClose,
}: {
  match: MergedMatch;
  bookmakers: { id: number; name: string; domain: string; vendor_slug: string; harvest_config?: any }[];
  onClose: () => void;
}) {
  const [bkData,     setBkData]    = useState<Record<string, GameZipResult>>({});
  const [loading,    setLoading]   = useState(true);
  const [tab,        setTab]       = useState<'markets'|'arbitrage'>('markets');
  const [tick,       setTick]      = useState(0);
  const [lastUpdate, setLastUpdate]= useState<Date | null>(null);
  const [countdown,  setCountdown] = useState(4);
  const intervalRef  = useRef<any>(null);
  const countRef     = useRef<any>(null);

  // Bookmakers that have this match
  const activeBkNames = Object.keys(match.bookmakers);
  const bkList = bookmakers?.filter(b => activeBkNames.includes(b.name));

  const fetchAll = useCallback(async () => {
    setLoading(prev => tick === 0 ? true : prev);
    const results: Record<string, GameZipResult> = {};

    await Promise.all(bkList.map(async bk => {
      const bkInfo = match.bookmakers[bk.name];
      if (!bkInfo?.match_id) return;
      try {
        const res = await fetchWithAuth('/api/odds/admin/gamezi', {
          method: 'POST',
          body:   JSON.stringify({
            bookmaker_id: bk.id,
            match_id:     bkInfo.match_id,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        results[bk.name] = { ...data, fetched_at: Date.now() };
      } catch (e: any) {
        results[bk.name] = {
          match_id: bkInfo.match_id, home_team: match.home_team, away_team: match.away_team,
          competition: match.competition, markets: bkInfo.markets, market_count: Object.keys(bkInfo.markets).length,
          error: e.message, fetched_at: Date.now(),
        };
      }
    }));

    setBkData(results);
    setLastUpdate(new Date());
    setLoading(false);
    setTick(t => t + 1);
    setCountdown(4);
  }, [bkList, match, tick]);

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(fetchAll, 4000);
    countRef.current = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => {
      clearInterval(intervalRef.current);
      clearInterval(countRef.current);
    };
  }, []);  // eslint-disable-line

  // Build combined market data
  const allBkData: Record<string, Record<string, Record<string, number>>> = {};
  bkList.forEach(bk => {
    const d = bkData[bk.name];
    allBkData[bk.name] = d?.markets ?? match.bookmakers[bk.name]?.markets ?? {};
  });

  // All market keys union
  const allMktKeys = [...new Set(
    Object.values(allBkData).flatMap(bk => Object.keys(bk))
  )].filter(k => k && !k.startsWith('G'));

  // Sort: fixed markets first (MKT_ORDER), then line markets grouped by base
  const fixedKeys = allMktKeys.filter(k => !isLineMarket(k));
  const lineKeys  = allMktKeys.filter(k => isLineMarket(k));
  const sortedFixed = [
    ...MKT_ORDER.filter(k => fixedKeys.includes(k)),
    ...fixedKeys.filter(k => !MKT_ORDER.includes(k)).sort(),
  ];
  const groups = groupMarkets([...sortedFixed, ...lineKeys]);

  // Arbitrage detection
  const arbOpps  = detectArbitrage(bkList.map(b => b.name), allBkData);
  const arbMkts  = new Set(arbOpps.flatMap(o => [o.market]));

  const isLive = match.status === 'live';

  // Win probability (from first bookmaker that has it)
  const winProbs = Object.values(bkData).find(d => d.win_probs)?.win_probs;

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:9500,
      background:'rgba(0,0,0,0.9)',
      display:'flex', flexDirection:'column',
      overflow:'hidden',
    }}>
      {/* ── Header ── */}
      <div style={{
        flexShrink:0, padding:'14px 20px',
        background:'var(--bg-elevated)',
        borderBottom:'1px solid var(--border-dim)',
        display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
      }}>
        {/* Match identity */}
        <div style={{ flex:'0 0 auto' }}>
          {isLive && (
            <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:4 }}>
              <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--red)', boxShadow:'0 0 6px var(--red)', display:'inline-block' }}/>
              <span style={{ fontFamily:M, fontSize:7, color:'var(--red)', letterSpacing:2 }}>LIVE</span>
            </div>
          )}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontFamily:M, fontSize:16, fontWeight:800, color:'var(--text-primary)', letterSpacing:0.3 }}>
              {match.home_team}
            </span>
            {isLive && match.score_home != null && (
              <span style={{ fontFamily:M, fontSize:18, fontWeight:900, color:'var(--red)' }}>
                {match.score_home}–{match.score_away}
              </span>
            )}
            {!isLive && <span style={{ fontFamily:M, fontSize:11, color:'rgba(100,116,139,0.6)' }}>vs</span>}
            <span style={{ fontFamily:M, fontSize:16, fontWeight:800, color:'var(--text-primary)', letterSpacing:0.3 }}>
              {match.away_team}
            </span>
          </div>
          <div style={{ fontFamily:M, fontSize:8, color:'rgba(100,116,139,0.7)', marginTop:3 }}>
            {match.competition}
          </div>
        </div>

        {/* Win probability bar */}
        {winProbs && (
          <div style={{ flex:'0 0 auto', display:'flex', gap:8, alignItems:'center' }}>
            <WinProbBar probs={winProbs} />
          </div>
        )}

        {/* Refresh status */}
        <div style={{ marginLeft:'auto', display:'flex', gap:14, alignItems:'center' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2 }}>
            <span style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.5)', letterSpacing:1 }}>
              {lastUpdate ? `UPDATED ${lastUpdate.toLocaleTimeString()}` : 'LOADING…'}
            </span>
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ width:48, height:2, background:'rgba(255,255,255,0.1)' }}>
                <div style={{ height:'100%', background:'var(--acid)', transition:'width 1s linear', width:`${(countdown / 4) * 100}%` }}/>
              </div>
              <span style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.4)' }}>{countdown}s</span>
            </div>
          </div>
          <button onClick={fetchAll} style={{ fontFamily:M, fontSize:8, background:'transparent', border:'1px solid var(--border-dim)', color:'var(--text-muted)', padding:'4px 10px', cursor:'pointer' }}>
            ↻
          </button>
          {arbOpps.length > 0 && (
            <div style={{ padding:'4px 10px', background:'rgba(198,241,53,0.1)', border:'1px solid rgba(198,241,53,0.4)', fontFamily:M, fontSize:8, color:'#C6F135', cursor:'pointer' }}
              onClick={() => setTab('arbitrage')}>
              ★ {arbOpps.length} ARB
            </div>
          )}
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', fontSize:18, cursor:'pointer', padding:4 }}>✕</button>
        </div>
      </div>

      {/* ── Bookmaker legend ── */}
      <div style={{ flexShrink:0, display:'flex', gap:4, padding:'7px 20px', background:'rgba(0,0,0,0.3)', borderBottom:'1px solid var(--border-dim)', flexWrap:'wrap' }}>
        {bkList.map((bk, i) => {
          const d = bkData[bk.name];
          const c = getBkColor(i);
          return (
            <div key={bk.name} style={{ display:'flex', gap:6, alignItems:'center', padding:'3px 10px', background:`${c}10`, border:`1px solid ${c}35` }}>
              <div style={{ width:5, height:5, borderRadius:'50%', background: d?.error ? 'var(--red)' : c }}/>
              <span style={{ fontFamily:M, fontSize:8, color:c, fontWeight:700 }}>{bk.name}</span>
              {d && !d.error && (
                <span style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.6)' }}>
                  {d.market_count} mkts · #{d.match_id}
                </span>
              )}
              {d?.error && <span style={{ fontFamily:M, fontSize:7, color:'var(--red)' }} title={d.error}>⚠ {d.error.substring(0,25)}</span>}
              {!d && <span style={{ fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.4)' }}>loading…</span>}
            </div>
          );
        })}
      </div>

      {/* ── Tab nav ── */}
      <div style={{ flexShrink:0, display:'flex', borderBottom:'1px solid var(--border-dim)', background:'var(--bg-elevated)' }}>
        {(['markets','arbitrage'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            fontFamily:M, fontSize:8, letterSpacing:2, padding:'8px 18px',
            background:'transparent', border:'none', cursor:'pointer',
            borderBottom:`2px solid ${tab===t ? 'var(--acid)' : 'transparent'}`,
            color: tab===t ? 'var(--acid)' : 'var(--text-muted)',
            marginBottom:-1,
          }}>
            {t === 'markets' ? `📊 MARKETS (${allMktKeys.length})` : `★ ARBITRAGE${arbOpps.length > 0 ? ` (${arbOpps.length})` : ''}`}
          </button>
        ))}
        <div style={{ flex:1 }}/>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'0 16px', fontFamily:M, fontSize:7, color:'rgba(100,116,139,0.4)' }}>
          AUTO-REFRESH 4s
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex:1, overflowY:'auto' }}>

        {tab === 'markets' && (
          <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
            {loading && Object.keys(bkData).length === 0 && (
              <div style={{ padding:'48px', textAlign:'center', fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>
                Fetching full markets…
              </div>
            )}

            {Object.entries(groups).map(([groupName, keys]) => (
              <MarketGroupTable
                key={groupName}
                groupName={groupName}
                keys={keys}
                bkNames={bkList.map(b => b.name)}
                bkData={allBkData}
                arbMkts={arbMkts}
              />
            ))}
          </div>
        )}

        {tab === 'arbitrage' && (
          <div style={{ padding:'16px 20px' }}>
            <div style={{ fontFamily:M, fontSize:8, letterSpacing:2, color:'var(--text-muted)', marginBottom:14 }}>
              ARBITRAGE OPPORTUNITIES — comparing {bkList.length} bookmakers across {allMktKeys.length} markets
            </div>
            <ArbitragePanel opps={arbOpps} bkNames={bkList.map(b => b.name)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Win probability bar ──────────────────────────────────────────────────────

function WinProbBar({ probs }: { probs: { P1: number; PX: number; P2: number } }) {
  const p1  = Math.round((probs.P1 ?? 0) * 100);
  const px  = Math.round((probs.PX ?? 0) * 100);
  const p2  = Math.round((probs.P2 ?? 0) * 100);
  const seg = [
    { label:'HOME', pct:p1, c:'#38BDF8' },
    { label:'DRAW', pct:px, c:'rgba(100,116,139,0.6)' },
    { label:'AWAY', pct:p2, c:'#FB923C' },
  ];
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
      <div style={{ fontFamily:M, fontSize:6, letterSpacing:2, color:'rgba(100,116,139,0.5)', marginBottom:2 }}>WIN PROBABILITY</div>
      <div style={{ display:'flex', height:16, width:160, overflow:'hidden', borderRadius:2, gap:1 }}>
        {seg.filter(s => s.pct > 0).map(s => (
          <div key={s.label} style={{ width:`${s.pct}%`, background:s.c, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <span style={{ fontFamily:M, fontSize:7, fontWeight:800, color:'rgba(0,0,0,0.8)' }}>{s.pct > 10 ? `${s.pct}%` : ''}</span>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', gap:8 }}>
        {seg.map(s => (
          <div key={s.label} style={{ textAlign:'center' }}>
            <div style={{ fontFamily:M, fontSize:8, fontWeight:800, color:s.c }}>{s.pct}%</div>
            <div style={{ fontFamily:M, fontSize:6, color:'rgba(100,116,139,0.4)' }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}