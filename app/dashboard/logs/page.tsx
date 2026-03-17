/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
/**
 * AdminOddsMonitor.tsx
 * =====================
 * Admin panel with three tabs:
 *   1. MONITOR   — worker health, beat status, per-task table with live updates
 *   2. PROBE     — test any bookmaker × sport in real-time (calls /odds/admin/probe)
 *   3. ODDS VIEW — browse cached unified odds, compare across bookmakers
 *
 * Customer-facing pages use the pre-cached data served from /odds/sport/<name>.
 * This admin page calls /probe which fires a live fetch so you can see
 * what a bookmaker returns right now without waiting for the beat cycle.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';
import MatchDetailView from './match-details';
import SboTab from './SboTab';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Bookmaker { id: number; name: string; domain: string; vendor_slug: string; is_active: boolean; harvest_config?: any; brand_color?: string }
interface TaskStatus {
  _key:       string;
  bookmaker?: string;
  sport?:     string;
  mode?:      string;
  state:      'ok' | 'error' | 'running';
  count?:     number;
  latency_ms?: number;
  error?:     string;
  updated_at: string;
}
interface MonitorData {
  worker_alive:     boolean;
  cached_upcoming:  number;
  cached_live:      number;
  total_matches:    number;
  upcoming_matches: number;
  live_matches:     number;
  tasks:            TaskStatus[];
  beat_upcoming:    any;
  beat_live:        any;
  heartbeat:        any;
}
interface ProbeResult {
  ok:         boolean;
  bookmaker?: string;
  sport?:     string;
  mode?:      string;
  count?:     number;
  latency_ms?: number;
  matches?:   Match[];
  error?:     string;
}
interface Market { odds: number; bookmaker: string }
interface Match {
  home_team:   string;
  away_team:   string;
  sport:       string;
  competition: string;
  start_time:  string | null;
  status:      string;
  score_home:  number | null;
  score_away:  number | null;
  markets:     Record<string, Record<string, Market>>;
  bookmakers:  Record<string, { match_id: string; markets: Record<string, Record<string, number>> }>;
}
interface CacheKey {
  key: string; ttl: number; bookmaker: string;
  sport: string; mode: string; match_count: number; harvested_at: string;
}

const M = "'IBM Plex Mono','Fira Code',monospace";
const SPORTS = ['Football','Basketball','Ice Hockey','Tennis','Volleyball','Cricket','Rugby'];
const MODES  = ['upcoming','live'];

// SBO tab accent colour
const SBO_GOLD = '#F5C842';

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  btn:   { background:'var(--acid)', color:'#0a0a0a', border:'none', fontFamily:M, fontSize:9, fontWeight:700, letterSpacing:2, padding:'8px 16px', cursor:'pointer', whiteSpace:'nowrap' },
  ghost: { background:'transparent', border:'1px solid var(--border-dim)', color:'var(--text-muted)', fontFamily:M, fontSize:9, padding:'7px 14px', cursor:'pointer', whiteSpace:'nowrap' },
  cyan:  { background:'rgba(6,182,212,.1)', border:'1px solid rgba(6,182,212,.4)', color:'var(--cyan)', fontFamily:M, fontSize:9, padding:'7px 14px', cursor:'pointer', whiteSpace:'nowrap' },
  mini:  { background:'var(--bg-base)', border:'1px solid var(--border-dim)', color:'var(--text-primary)', padding:'5px 8px', fontFamily:M, fontSize:10, outline:'none', width:'100%', boxSizing:'border-box' as const },
  lbl:   { fontFamily:M, fontSize:8, letterSpacing:2, color:'var(--text-muted)', marginBottom:4, display:'block' } as React.CSSProperties,
  th:    { fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', padding:'6px 10px', textAlign:'left' as const, borderBottom:'1px solid var(--border-dim)', whiteSpace:'nowrap' as const },
  td:    { fontFamily:M, fontSize:8, color:'var(--text-primary)', padding:'5px 10px', borderBottom:'1px solid rgba(255,255,255,.04)', verticalAlign:'top' as const },
};

const pill = (c: string) => ({
  fontFamily:M, fontSize:7, padding:'1px 6px', letterSpacing:1,
  color:c, background:`${c}14`, border:`1px solid ${c}44`,
});
const stateColor = (st: string) =>
  st === 'ok' ? 'var(--acid)' : st === 'error' ? 'var(--red)' : 'rgba(251,146,60,.9)';

// ─── Stat card ────────────────────────────────────────────────────────────────
function Stat({ label, value, color = 'var(--acid)', sub }: { label:string; value:any; color?:string; sub?:string }) {
  return (
    <div style={{ padding:'14px 16px', background:'var(--bg-surface)', border:'1px solid var(--border-dim)', display:'flex', flexDirection:'column', gap:4 }}>
      <div style={{ fontFamily:M, fontSize:22, fontWeight:800, color, letterSpacing:-1 }}>{value}</div>
      <div style={{ fontFamily:M, fontSize:7, letterSpacing:3, color:'var(--text-muted)' }}>{label}</div>
      {sub && <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', opacity:.6 }}>{sub}</div>}
    </div>
  );
}

// ─── Odds table — handles both raw (float) and merged ({odds,bookmaker}) formats ──

function RawOddsTable({ markets, accent = 'var(--acid)' }: { markets: Record<string, Record<string, any>>; accent?: string }) {
  if (!Object.keys(markets).length) return (
    <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', padding:'8px 0' }}>No markets in this response</div>
  );
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      {Object.entries(markets).map(([mkt, outcomes]) => (
        <div key={mkt} style={{ background:'rgba(255,255,255,.02)', border:`1px solid ${accent}22` }}>
          <div style={{ padding:'4px 10px', borderBottom:`1px solid ${accent}22`, fontFamily:M, fontSize:7, letterSpacing:2, color:accent, background:`${accent}08` }}>
            {mkt}
          </div>
          <div style={{ display:'flex', gap:0 }}>
            {Object.entries(outcomes).map(([outcome, val]) => {
              const odds = typeof val === 'object' ? val?.odds : Number(val);
              const bk   = typeof val === 'object' ? val?.bookmaker : null;
              return (
                <div key={outcome} style={{ flex:1, padding:'8px 10px', borderRight:`1px solid ${accent}18`, textAlign:'center' as const }}>
                  <div style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', letterSpacing:1, marginBottom:4 }}>{outcome}</div>
                  <div style={{ fontFamily:M, fontSize:14, fontWeight:800, color: odds > 3 ? accent : odds > 1 ? 'var(--text-primary)' : 'var(--red)' }}>
                    {odds > 0 ? odds.toFixed(2) : '—'}
                  </div>
                  {bk && <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)', marginTop:2 }}>{bk}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Merged odds table — bookmakers side by side ──────────────────────────────

function OddsTable({ match }: { match: Match }) {
  const bks     = Object.keys(match.bookmakers || {});
  const markets = Object.keys(match.markets || {});
  if (!markets.length) return <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)' }}>No markets</div>;

  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ borderCollapse:'collapse', width:'100%', minWidth:500 }}>
        <thead>
          <tr style={{ background:'rgba(0,0,0,.3)' }}>
            <th style={{ ...s.th, width:120 }}>MARKET</th>
            <th style={{ ...s.th, width:80 }}>OUTCOME</th>
            {bks.map(bk => <th key={bk} style={{ ...s.th, textAlign:'center' as const }}>{bk}</th>)}
            <th style={{ ...s.th, textAlign:'center' as const, color:'var(--acid)' }}>BEST</th>
          </tr>
        </thead>
        <tbody>
          {markets.map(mkt => {
            const outcomes = match.markets[mkt];
            return Object.entries(outcomes).map(([outcome, best], oi) => {
              const allOdds: Record<string, number> = {};
              bks.forEach(bk => {
                const v = (match.bookmakers[bk]?.markets?.[mkt] as any)?.[outcome];
                if (v) allOdds[bk] = Number(v);
              });
              const maxOdds = Math.max(...Object.values(allOdds), 0);
              const bestOdds = typeof best === 'object' ? best?.odds : best;
              const bestBk   = typeof best === 'object' ? best?.bookmaker : null;
              return (
                <tr key={`${mkt}-${outcome}`}>
                  {oi === 0 && (
                    <td style={{ ...s.td, fontWeight:700, color:'var(--text-secondary)', verticalAlign:'middle', background:'rgba(255,255,255,.02)' }}
                      rowSpan={Object.keys(outcomes).length}>
                      {mkt}
                    </td>
                  )}
                  <td style={{ ...s.td, color:'var(--text-muted)' }}>{outcome}</td>
                  {bks.map(bk => {
                    const v = allOdds[bk];
                    const isBest = v && v === maxOdds;
                    return (
                      <td key={bk} style={{ ...s.td, textAlign:'center', fontWeight:isBest?800:400, color:isBest?'var(--acid)':v?'var(--text-primary)':'var(--text-muted)' }}>
                        {v ? v.toFixed(2) : '—'}
                      </td>
                    );
                  })}
                  <td style={{ ...s.td, textAlign:'center', fontWeight:800, color:'var(--acid)' }}>
                    {bestOdds > 0 ? Number(bestOdds).toFixed(2) : '—'}
                    {bestBk && <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)', fontWeight:400 }}>{bestBk}</div>}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Monitor Tab ──────────────────────────────────────────────────────────────
function MonitorTab({ bookmakers }: { bookmakers: Bookmaker[] }) {
  const [data,         setData]        = useState<MonitorData | null>(null);
  const [cacheKeys,    setCacheKeys]   = useState<CacheKey[]>([]);
  const [loading,      setLoading]     = useState(true);
  const [triggering,   setTriggering]  = useState(false);
  const [taskFilter,   setTaskFilter]  = useState('');
  const [showCache,    setShowCache]   = useState(false);
  const intervalRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const [monRes, cacheRes] = await Promise.all([
        fetchWithAuth('/odds/admin/monitor').then((r: Response) => r.json()),
        fetchWithAuth('/odds/admin/cache-keys').then((r: Response) => r.json()),
      ]);
      if (monRes) setData(monRes);
      if (cacheRes?.keys) setCacheKeys(cacheRes.keys);
    } catch { /* keep existing */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); intervalRef.current = setInterval(load, 4000); return () => clearInterval(intervalRef.current); }, [load]);

  const trigger = async (mode: string) => {
    setTriggering(true);
    await fetchWithAuth('/odds/admin/trigger-harvest', { method:'POST', body:JSON.stringify({ mode }) });
    setTimeout(load, 2000);
    setTriggering(false);
  };

  const filteredTasks = (data?.tasks || []).filter(t =>
    !taskFilter || `${t.bookmaker} ${t.sport} ${t._key}`.toLowerCase().includes(taskFilter.toLowerCase())
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Worker health */}
      <div style={{ display:'flex', gap:10, alignItems:'center', padding:'10px 14px', background:data?.worker_alive?'rgba(198,241,53,.04)':'rgba(255,61,90,.04)', border:`1px solid ${data?.worker_alive?'rgba(198,241,53,.25)':'rgba(255,61,90,.25)'}` }}>
        <div style={{ width:10, height:10, borderRadius:'50%', background:data?.worker_alive?'var(--acid)':'var(--red)', boxShadow:data?.worker_alive?'0 0 8px var(--acid)':'none', flexShrink:0 }}/>
        <span style={{ fontFamily:M, fontSize:10, color:data?.worker_alive?'var(--acid)':'var(--red)', fontWeight:700, letterSpacing:1 }}>
          {data?.worker_alive ? 'CELERY WORKER ONLINE' : 'WORKER OFFLINE'}
        </span>
        <span style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', marginLeft:8 }}>auto-refresh 4s</span>
        <div style={{ flex:1 }} />
        <div style={{ display:'flex', gap:6 }}>
          <button onClick={() => trigger('upcoming')} disabled={triggering} style={{ ...s.cyan, fontSize:8 }}>
            {triggering ? '⟳ TRIGGERING…' : '▶ TRIGGER UPCOMING'}
          </button>
          <button onClick={() => trigger('live')} disabled={triggering} style={{ ...s.ghost, fontSize:8 }}>
            ▶ TRIGGER LIVE
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8 }}>
        <Stat label="UPCOMING MATCHES" value={data?.upcoming_matches ?? '…'} />
        <Stat label="LIVE MATCHES"     value={data?.live_matches    ?? '…'} color="var(--cyan)" />
        <Stat label="CACHED UPCOMING"  value={data?.cached_upcoming ?? '…'} color="var(--text-muted)" sub="keys" />
        <Stat label="CACHED LIVE"      value={data?.cached_live     ?? '…'} color="var(--text-muted)" sub="keys" />
        <Stat label="BOOKMAKERS"       value={bookmakers.filter(b=>b.is_active).length} color="#fb923c" />
      </div>

      {/* Beat status */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {[
          { label:'UPCOMING BEAT (5 min)', d: data?.beat_upcoming },
          { label:'LIVE BEAT (60 s)',      d: data?.beat_live },
        ].map(({ label, d: bd }) => (
          <div key={label} style={{ padding:'10px 14px', background:'var(--bg-surface)', border:'1px solid var(--border-dim)' }}>
            <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', marginBottom:6 }}>{label}</div>
            <div style={{ fontFamily:M, fontSize:9, color:bd?.state==='ok'?'var(--acid)':bd?'var(--red)':'var(--text-muted)' }}>
              {bd?.state === 'ok' ? `✓ ${bd.dispatched} tasks dispatched` : bd ? `✗ ${bd.error||'no data'}` : '—'}
            </div>
            {bd?.updated_at && <div style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', marginTop:3 }}>{new Date(bd.updated_at).toLocaleTimeString()}</div>}
          </div>
        ))}
      </div>

      {/* Task table */}
      <div>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
          <span style={{ fontFamily:M, fontSize:8, letterSpacing:2, color:'var(--text-muted)' }}>HARVEST TASKS ({filteredTasks.length})</span>
          <input value={taskFilter} onChange={e=>setTaskFilter(e.target.value)} placeholder="filter…" style={{ ...s.mini, width:180 }} />
          <button onClick={()=>setShowCache(v=>!v)} style={{ ...s.ghost, fontSize:7, marginLeft:'auto' }}>{showCache?'HIDE':'SHOW'} CACHE KEYS</button>
        </div>

        <div style={{ overflowX:'auto', maxHeight:360, overflowY:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', minWidth:700 }}>
            <thead style={{ position:'sticky', top:0, zIndex:1 }}>
              <tr style={{ background:'var(--bg-elevated)' }}>
                {['BOOKMAKER','SPORT','MODE','STATE','MATCHES','LATENCY','UPDATED'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && !filteredTasks.length && (
                <tr><td colSpan={7} style={{ ...s.td, textAlign:'center', padding:'24px', color:'var(--text-muted)' }}>Loading…</td></tr>
              )}
              {!loading && !filteredTasks.length && (
                <tr><td colSpan={7} style={{ ...s.td, textAlign:'center', padding:'24px', color:'var(--text-muted)' }}>
                  No task data — worker may be offline or no harvest has run yet
                </td></tr>
              )}
              {filteredTasks.map(t => (
                <tr key={t._key} style={{ background:t.state==='error'?'rgba(255,61,90,.03)':'transparent' }}>
                  <td style={s.td}>{t.bookmaker || '—'}</td>
                  <td style={s.td}>{t.sport || '—'}</td>
                  <td style={s.td}><span style={pill(t.mode==='live'?'var(--cyan)':'var(--acid)')}>{t.mode||'—'}</span></td>
                  <td style={s.td}><span style={{ fontFamily:M, fontSize:8, color:stateColor(t.state) }}>{t.state}</span></td>
                  <td style={{ ...s.td, color:t.count?'var(--acid)':'var(--text-muted)' }}>{t.count ?? '—'}</td>
                  <td style={{ ...s.td, color:'var(--text-muted)' }}>{t.latency_ms != null ? `${t.latency_ms}ms` : '—'}</td>
                  <td style={{ ...s.td, color:'var(--text-muted)', fontSize:7 }}>
                    {t.updated_at ? new Date(t.updated_at).toLocaleTimeString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cache keys */}
      {showCache && (
        <div>
          <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', marginBottom:6 }}>CACHE KEYS ({cacheKeys.length})</div>
          <div style={{ overflowX:'auto', maxHeight:300, overflowY:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead style={{ position:'sticky', top:0 }}>
                <tr style={{ background:'var(--bg-elevated)' }}>
                  {['KEY','BK','SPORT','MODE','MATCHES','TTL','HARVESTED'].map(h=><th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {cacheKeys.map(ck => (
                  <tr key={ck.key}>
                    <td style={{ ...s.td, fontSize:7, color:'var(--text-muted)', maxWidth:260, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ck.key}</td>
                    <td style={s.td}>{ck.bookmaker}</td>
                    <td style={s.td}>{ck.sport}</td>
                    <td style={s.td}><span style={pill(ck.mode==='live'?'var(--cyan)':'var(--acid)')}>{ck.mode}</span></td>
                    <td style={{ ...s.td, color:'var(--acid)' }}>{ck.match_count}</td>
                    <td style={{ ...s.td, color:ck.ttl<60?'var(--red)':'var(--text-muted)' }}>{ck.ttl}s</td>
                    <td style={{ ...s.td, fontSize:7, color:'var(--text-muted)' }}>{ck.harvested_at ? new Date(ck.harvested_at).toLocaleTimeString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Probe-all comparison helpers ────────────────────────────────────────────

const PROBE_BK_COLORS = ['#C6F135','#38BDF8','#FB923C','#A78BFA','#F472B6','#34D399','#FBBF24','#60A5FA'];
const PROBE_MARKET_ORDER = ['1X2','Double Chance','BTTS'];
const PROBE_MARKET_LABEL: Record<string,string> = {
  '1X2':'1X2', 'Double Chance':'Double Chance', 'BTTS':'BTTS',
};
const PROBE_OUTCOME_ORDER: Record<string,string[]> = {
  '1X2':          ['Home','Draw','Away'],
  'Double Chance':['1X','12','2X'],
  'BTTS':         ['Yes','No'],
};

function getBkColor(idx: number) {
  return PROBE_BK_COLORS[idx % PROBE_BK_COLORS.length];
}

function ProbeMarketTable({ match, bkNames }: {
  match: { bookmakers: Record<string,{match_id:string;markets:Record<string,Record<string,number>>}> };
  bkNames: string[];
}) {
  const allMkts = new Set<string>();
  Object.values(match.bookmakers).forEach(bk => Object.keys(bk.markets||{}).forEach(m => allMkts.add(m)));
  const sorted = [
    ...PROBE_MARKET_ORDER.filter(m => allMkts.has(m)),
    ...[...allMkts].filter(m => !PROBE_MARKET_ORDER.includes(m) && m.startsWith('Total_')).sort(),
    ...[...allMkts].filter(m => !PROBE_MARKET_ORDER.includes(m) && !m.startsWith('Total_')).sort(),
  ];
  if (!sorted.length) return (
    <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', padding:'6px 10px' }}>No markets</div>
  );
  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ borderCollapse:'collapse' as const, width:'100%', minWidth:300 }}>
        <thead>
          <tr style={{ background:'rgba(0,0,0,.35)' }}>
            <th style={{ fontFamily:M, fontSize:7, letterSpacing:1.5, color:'var(--text-muted)', padding:'5px 8px', textAlign:'left' as const, borderBottom:'1px solid rgba(255,255,255,.08)', whiteSpace:'nowrap' as const, minWidth:90 }}>MARKET</th>
            <th style={{ fontFamily:M, fontSize:7, letterSpacing:1.5, color:'var(--text-muted)', padding:'5px 8px', textAlign:'left' as const, borderBottom:'1px solid rgba(255,255,255,.08)', whiteSpace:'nowrap' as const, minWidth:60, borderRight:'1px solid rgba(255,255,255,.1)' }}>OUTCOME</th>
            {bkNames.map((name, i) => (
              <th key={name} style={{ fontFamily:M, fontSize:7, letterSpacing:1, color:getBkColor(i), padding:'5px 8px', textAlign:'center' as const, borderBottom:'1px solid rgba(255,255,255,.08)', whiteSpace:'nowrap' as const, minWidth:56 }}>
                {name.length > 7 ? name.substring(0,6)+'…' : name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.flatMap(mktKey => {
            const outcomes = PROBE_OUTCOME_ORDER[mktKey]
              ?? [...new Set(bkNames.flatMap(n => Object.keys(match.bookmakers[n]?.markets?.[mktKey] ?? {})))];
            if (!outcomes.length) return [];
            const mktLabel = mktKey.startsWith('Total_')
              ? `O/U ${mktKey.replace('Total_', '')}`
              : (PROBE_MARKET_LABEL[mktKey] ?? mktKey);
            return outcomes.map((outcome, oIdx) => {
              const vals: Record<string,number> = {};
              bkNames.forEach(name => {
                const v = match.bookmakers[name]?.markets?.[mktKey]?.[outcome];
                if (v && Number(v) > 1) vals[name] = Number(v);
              });
              const maxV = Math.max(...Object.values(vals), 0);
              const showMktLabel = oIdx === 0;
              return (
                <tr key={mktKey + outcome} style={{ borderBottom:'1px solid rgba(255,255,255,.03)', background: showMktLabel ? 'rgba(255,255,255,.015)' : 'transparent' }}>
                  <td style={{ fontFamily:M, fontSize:7, letterSpacing:1.5, padding:'5px 8px', color: showMktLabel ? 'rgba(198,241,53,.7)' : 'transparent', whiteSpace:'nowrap' as const }}>
                    {showMktLabel ? mktLabel : ''}
                  </td>
                  <td style={{ fontFamily:M, fontSize:8, padding:'5px 8px', color:'var(--text-muted)', borderRight:'1px solid rgba(255,255,255,.1)', whiteSpace:'nowrap' as const }}>{outcome}</td>
                  {bkNames.map(name => {
                    const v    = vals[name];
                    const best = !!v && v === maxV && Object.keys(vals).length > 1;
                    return (
                      <td key={name} style={{ padding:'5px 8px', textAlign:'center' as const, fontFamily:M, fontWeight: best ? 800 : 400,
                        fontSize: best ? 13 : 12,
                        color: !v ? 'rgba(100,116,139,.3)' : best ? '#C6F135' : 'var(--text-primary)',
                        background: best ? 'rgba(198,241,53,.07)' : 'transparent',
                        borderRight:'1px solid rgba(255,255,255,.04)',
                        position:'relative' as const,
                      }}>
                        {best && <span style={{ position:'absolute', top:1, right:2, fontSize:5, color:'#C6F135', fontFamily:M }}>▲</span>}
                        {v ? v.toFixed(2) : '—'}
                      </td>
                    );
                  })}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ProbeMatchData {
  home_team: string; away_team: string; sport: string; competition: string;
  start_time: string | null; status: string; score_home: number|null; score_away: number|null;
  bookmakers: Record<string, { match_id: string; markets: Record<string, Record<string,number>> }>;
  markets: any;
}

function ProbeMatchCard({ match, bkNames, defaultOpen = false }: {
  match: ProbeMatchData; bkNames: string[]; defaultOpen?: boolean;
}) {
  const [open, setOpen] = (useState as any)(defaultOpen);
  const isLive    = match.status === 'live';
  const activeBks = bkNames.filter(n => match.bookmakers[n]);
  const mktCount  = new Set(Object.values(match.bookmakers).flatMap(bk => Object.keys(bk.markets||{}))).size;

  // Quick 1X2 preview per bookmaker
  const preview = bkNames.map((name, i) => {
    const odds = match.bookmakers[name]?.markets?.['1X2'] ?? {};
    return { name, odds, color: getBkColor(i) };
  }).filter(b => Object.keys(b.odds).length > 0);

  return (
    <div style={{ border:'1px solid var(--border-dim)', background:'var(--bg-surface)', borderLeft:`3px solid ${isLive?'var(--red)':'rgba(198,241,53,.3)'}`, overflow:'hidden' }}>
      {/* Header */}
      <div onClick={() => setOpen((o: boolean) => !o)} style={{ display:'flex', alignItems:'center', gap:12, padding:'9px 14px', cursor:'pointer', flexWrap:'wrap' as const }}>
        {isLive && (
          <span style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--red)', flexShrink:0 }}>
            <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', background:'var(--red)', boxShadow:'0 0 5px var(--red)', marginRight:4 }}/>LIVE
          </span>
        )}
        <div style={{ flex:'0 0 auto', minWidth:180 }}>
          <div style={{ fontFamily:M, fontSize:12, fontWeight:800, color:'var(--text-primary)', letterSpacing:0.3 }}>
            {match.home_team}
            {isLive && match.score_home != null && <span style={{ color:'var(--red)', marginLeft:6 }}>{match.score_home}</span>}
            <span style={{ color:'var(--text-muted)', fontWeight:400, margin:'0 5px', fontSize:9 }}>v</span>
            {isLive && match.score_away != null && <span style={{ color:'var(--red)', marginRight:6 }}>{match.score_away}</span>}
            {match.away_team}
          </div>
          <div style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', marginTop:2, letterSpacing:0.5 }}>
            {match.competition} · {match.sport}
          </div>
        </div>

        {/* Quick 1X2 pills — hidden when expanded */}
        {!open && preview.length > 0 && (
          <div style={{ display:'flex', gap:6, flex:1, flexWrap:'wrap' as const, overflow:'hidden' }}>
            {preview.map(bk => (
              <div key={bk.name} style={{ display:'flex', gap:0, alignItems:'stretch', flexShrink:0 }}>
                <div style={{ padding:'2px 6px', background:`${bk.color}15`, border:`1px solid ${bk.color}40`, borderRight:'none', display:'flex', alignItems:'center' }}>
                  <span style={{ fontFamily:M, fontSize:6, color:bk.color, letterSpacing:1 }}>{bk.name.substring(0,4).toUpperCase()}</span>
                </div>
                {['Home','Draw','Away'].map(o => {
                  const v = bk.odds[o]; const num = v && Number(v) > 1 ? Number(v) : null;
                  return (
                    <div key={o} style={{ padding:'2px 7px', background:'rgba(0,0,0,.3)', border:`1px solid ${bk.color}25`, textAlign:'center' as const, minWidth:44 }}>
                      <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)' }}>{o[0]}</div>
                      <div style={{ fontFamily:M, fontSize:11, fontWeight:800, color: num ? 'var(--text-primary)' : 'rgba(100,116,139,.4)' }}>
                        {num ? num.toFixed(2) : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
          <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>
            {activeBks.length} bk · {mktCount} mkts
          </span>
          <span style={{ fontFamily:M, fontSize:10, color:'var(--acid)', transition:'transform .15s', display:'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>›</span>
        </div>
      </div>

      {/* Expanded: full per-bookmaker market table */}
      {open && (
        <div style={{ borderTop:'1px solid var(--border-dim)' }}>
          {/* Bookmaker legend */}
          <div style={{ display:'flex', gap:4, padding:'5px 14px', background:'rgba(0,0,0,.2)', flexWrap:'wrap' as const, borderBottom:'1px solid var(--border-dim)' }}>
            {bkNames.map((name, i) => {
              const has = !!match.bookmakers[name];
              const c   = getBkColor(i);
              return (
                <div key={name} style={{ display:'flex', gap:4, alignItems:'center', padding:'2px 8px',
                  background: has ? `${c}12` : 'rgba(100,116,139,.05)',
                  border:`1px solid ${has ? `${c}35` : 'rgba(100,116,139,.15)'}`,
                  opacity: has ? 1 : 0.35 }}>
                  <div style={{ width:5, height:5, borderRadius:'50%', background: has ? c : 'var(--text-muted)' }}/>
                  <span style={{ fontFamily:M, fontSize:7, color: has ? c : 'var(--text-muted)', letterSpacing:0.8 }}>{name}</span>
                  {has && <span style={{ fontFamily:M, fontSize:6, color:'rgba(100,116,139,.5)' }}>#{match.bookmakers[name].match_id}</span>}
                </div>
              );
            })}
          </div>
          <ProbeMarketTable match={match} bkNames={bkNames} />
        </div>
      )}
    </div>
  );
}


// ─── Debug Probe Panel ────────────────────────────────────────────────────────
// Calls /api/odds/admin/debug-probe and shows raw diagnostic breakdown

function DebugProbePanel({ bookmakers }: { bookmakers: Bookmaker[] }) {
  const [bkId,    setBkId]   = useState<number|null>(null);
  const [sport,   setSport]  = useState('Football');
  const [mode,    setMode]   = useState('upcoming');
  const [loading, setLoad]   = useState(false);
  const [result,  setResult] = useState<any>(null);

  const run = async () => {
    if (!bkId) return;
    setLoad(true); setResult(null);
    try {
      const res = await fetchWithAuth('/api/odds/admin/debug-probe', {
        method:'POST', body: JSON.stringify({ bookmaker_id: bkId, sport, mode }),
      }).then(r => r.json());
      setResult(res);
    } catch(e:any) { setResult({ ok:false, error: e.message }); }
    setLoad(false);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'14px 16px',
      background:'var(--bg-surface)', border:'1px solid var(--border-dim)' }}>
      <div style={{ fontFamily:M, fontSize:8, letterSpacing:2, color:'var(--amber)' }}>
        🔬 DEBUG PROBE — raw API diagnostic
      </div>

      <div style={{ display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap' as const }}>
        <div style={{ flex:'0 0 200px' }}>
          <label style={s.lbl}>BOOKMAKER</label>
          <select value={bkId??''} onChange={e=>setBkId(Number(e.target.value)||null)} style={s.mini}>
            <option value="">— select —</option>
            {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div style={{ flex:'0 0 140px' }}>
          <label style={s.lbl}>SPORT</label>
          <select value={sport} onChange={e=>setSport(e.target.value)} style={s.mini}>
            {SPORTS.map(sp=><option key={sp}>{sp}</option>)}
          </select>
        </div>
        <div style={{ flex:'0 0 120px' }}>
          <label style={s.lbl}>MODE</label>
          <select value={mode} onChange={e=>setMode(e.target.value)} style={s.mini}>
            <option value="live">live</option>
            <option value="upcoming">upcoming</option>
          </select>
        </div>
        <button onClick={run} disabled={!bkId || loading} style={{ ...s.btn, background:'var(--amber)', opacity:(!bkId||loading)?.4:1 }}>
          {loading ? '⟳ RUNNING…' : '🔬 RUN DEBUG'}
        </button>
      </div>

      {result && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {/* Status */}
          <div style={{ padding:'8px 12px', fontFamily:M, fontSize:9, fontWeight:800,
            color: result.ok ? 'var(--acid)' : 'var(--red)',
            background: result.ok ? 'rgba(198,241,53,.04)' : 'rgba(255,61,90,.04)',
            border:`1px solid ${result.ok?'rgba(198,241,53,.3)':'rgba(255,61,90,.3)'}` }}>
            {result.ok ? `✓ ${result.domain} responded` : `✗ ${result.error}`}
            {result.latency_ms != null && <span style={{ fontWeight:400, marginLeft:12, color:'var(--text-muted)' }}>{result.latency_ms}ms</span>}
          </div>

          {result.summary && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6 }}>
              {Object.entries(result.summary).map(([k, v]) => (
                <div key={k} style={{ padding:'8px 10px', background:'var(--bg-base)', border:'1px solid var(--border-dim)' }}>
                  <div style={{ fontFamily:M, fontSize:14, fontWeight:800, color:'var(--acid)' }}>{String(v)}</div>
                  <div style={{ fontFamily:M, fontSize:7, letterSpacing:1.5, color:'var(--text-muted)', marginTop:2 }}>
                    {k.replace(/_/g,' ').toUpperCase()}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Sport breakdown */}
          {result.sport_breakdown && (
            <div>
              <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', marginBottom:6 }}>
                SPORT BREAKDOWN (all items in Value[])
              </div>
              <div style={{ display:'flex', flexWrap:'wrap' as const, gap:4 }}>
                {Object.entries(result.sport_breakdown as Record<string,number>)
                  .sort(([,a],[,b]) => b - a)
                  .map(([sp, n]) => (
                    <div key={sp} style={{ padding:'4px 10px',
                      background: sp === sport ? 'rgba(198,241,53,.1)' : 'rgba(255,255,255,.03)',
                      border:`1px solid ${sp === sport ? 'rgba(198,241,53,.4)' : 'rgba(255,255,255,.08)'}` }}>
                      <span style={{ fontFamily:M, fontSize:9, fontWeight: sp===sport ? 800 : 400,
                        color: sp===sport ? 'var(--acid)' : 'var(--text-muted)' }}>{sp}</span>
                      <span style={{ fontFamily:M, fontSize:9, color:'var(--acid)', marginLeft:6 }}>{n}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Good matches sample */}
          {result.good_matches_sample?.length > 0 && (
            <div>
              <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--acid)', marginBottom:6 }}>
                ✓ {sport} MATCHES WITH ODDS (first {result.good_matches_sample.length})
              </div>
              {result.good_matches_sample.map((m: any, i: number) => (
                <div key={i} style={{ fontFamily:M, fontSize:8, padding:'5px 10px',
                  borderBottom:'1px solid var(--border-dim)', color:'var(--text-primary)' }}>
                  <span style={{ color:'var(--acid)' }}>{m.match}</span>
                  <span style={{ color:'var(--text-muted)', marginLeft:10 }}>{m.comp}</span>
                  <span style={{ color:'rgba(56,189,248,.8)', marginLeft:10 }}>
                    markets: {m.markets?.slice(0,6).join(', ')}
                    {m.markets?.length > 6 ? ` +${m.markets.length-6}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* No-odds samples */}
          {result.no_odds_matches_sample?.length > 0 && (
            <div>
              <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--amber)', marginBottom:6 }}>
                ⚠ NO-ODDS MATCHES (E:[] empty — odds not yet opened or suspended)
              </div>
              {result.no_odds_matches_sample.map((m: any, i: number) => (
                <div key={i} style={{ fontFamily:M, fontSize:8, padding:'5px 10px',
                  borderBottom:'1px solid var(--border-dim)', color:'var(--text-muted)',
                  display:'flex', gap:10 }}>
                  <span style={{ color:'var(--text-primary)' }}>{m.match}</span>
                  <span style={{ color:'var(--cyan)' }}>{m.sport}</span>
                  <span>{m.comp}</span>
                  <span style={{ color:'var(--amber)' }}>E={m.E_count} AE={m.AE_count}</span>
                  {m.start && <span style={{ fontSize:7 }}>{new Date(m.start).toLocaleString()}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Parse errors */}
          {result.parse_errors?.length > 0 && (
            <div>
              <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--red)', marginBottom:6 }}>
                ✗ PARSE ERRORS
              </div>
              {result.parse_errors.map((e: string, i: number) => (
                <div key={i} style={{ fontFamily:M, fontSize:8, color:'var(--red)', padding:'2px 0' }}>{e}</div>
              ))}
            </div>
          )}

          {/* First item preview */}
          {result.first_item_preview && Object.keys(result.first_item_preview).length > 0 && (
            <div>
              <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', marginBottom:6 }}>
                FIRST VALUE[] ITEM PREVIEW
              </div>
              <pre style={{ margin:0, fontFamily:M, fontSize:8, color:'rgba(167,243,208,.8)',
                background:'rgba(0,0,0,.5)', padding:'10px 12px', maxHeight:200, overflowY:'auto',
                whiteSpace:'pre-wrap' }}>
                {JSON.stringify(result.first_item_preview, null, 2)}
              </pre>
            </div>
          )}

          {/* Raw JSON toggle */}
          <details>
            <summary style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', cursor:'pointer', letterSpacing:2 }}>
              RAW JSON RESPONSE
            </summary>
            <pre style={{ margin:'6px 0 0', fontFamily:M, fontSize:7, color:'rgba(100,116,139,.7)',
              background:'rgba(0,0,0,.4)', padding:'8px 12px', maxHeight:300, overflowY:'auto',
              whiteSpace:'pre-wrap' }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Prob// ─── Probe Tab — test up to 3 bookmakers side by side ───────────────────────
function ProbeTab({ bookmakers }: { bookmakers: Bookmaker[] }) {
  // Match detail overlay
  const [detailMatch, setDetailMatch] = useState<ProbeMatchData | null>(null);

  // Up to 3 bookmaker slots
  const [slots,    setSlots]   = useState<(number|null)[]>([null, null, null]);
  const [sport,    setSport]   = useState('Football');
  const [mode,     setMode]    = useState('upcoming');
  const [probing,  setProbing] = useState(false);
  const [results,  setResults] = useState<(any|null)[]>([null, null, null]);
  const [expanded, setExpanded]= useState<string|null>(null); // "bkIdx-matchIdx"
  const [rawView,     setRawView]     = useState<number|null>(null);
  const [probingAll,  setProbingAll]  = useState(false);
  const [probeAllRes, setProbeAllRes] = useState<any>(null);

  const setSlot = (i: number, val: number|null) =>
    setSlots(prev => prev.map((s, j) => j === i ? val : s));

  const activeSlots = slots.map((id, i) => ({ id, i })).filter(s => s.id !== null);

  const probeAll = async () => {
    if (!activeSlots.length) return;
    setProbing(true);
    setResults([null, null, null]);
    setExpanded(null);
    setRawView(null);

    await Promise.all(activeSlots.map(async ({ id, i }) => {
      try {
        const res = await fetchWithAuth('/odds/admin/probe', {
          method: 'POST',
          body:   JSON.stringify({ bookmaker_id: id, sport, mode }),
        }).then((r: Response) => r.json());
        setResults(prev => prev.map((r, j) => j === i ? res : r));
      } catch (e: any) {
        setResults(prev => prev.map((r, j) => j === i ? { ok: false, error: e.message } : r));
      }
    }));

    setProbing(false);
  };

  const probeAllBookmakers = async () => {
    setProbingAll(true); setProbeAllRes(null);
    try {
      const res = await fetchWithAuth('/odds/admin/probe-all', {
        method:'POST', body: JSON.stringify({ sport, mode, page_size: 40 }),
      }).then((r: Response) => r.json());
      setProbeAllRes(res);
    } catch (e: any) { setProbeAllRes({ ok: false, error: e.message }); }
    setProbingAll(false);
  };

  const SLOT_COLORS = ['var(--acid)', 'var(--cyan)', '#f472b6'];

  // Build merged match list across all slots for comparison view
  const buildComparisonRows = () => {
    // Collect all matches from all slots
    const allTeams = new Map<string, any[]>(); // "home v away" → [slot0_match, slot1_match, slot2_match]
    results.forEach((res, si) => {
      if (!res?.matches) return;
      res.matches.forEach((m: any) => {
        const key = `${m.home_team?.toLowerCase()} v ${m.away_team?.toLowerCase()}`;
        if (!allTeams.has(key)) allTeams.set(key, [null, null, null]);
        allTeams.get(key)![si] = m;
      });
    });
    return [...allTeams.entries()].map(([key, slotMatches]) => ({ key, slotMatches }));
  };

  const compRows = buildComparisonRows();
  const hasAnyResult = results.some(r => r !== null);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

      {/* ── Match detail overlay ── */}
      {detailMatch && (
        <MatchDetailView
          match={detailMatch as any}
          bookmakers={bookmakers}
          onClose={() => setDetailMatch(null)}
        />
      )}

      {/* ── Debug probe panel ── */}
      <DebugProbePanel bookmakers={bookmakers} />

      {/* ── Config row ── */}
      <div style={{ padding:'14px 16px', background:'var(--bg-surface)', border:'1px solid var(--border-dim)', display:'flex', flexDirection:'column', gap:10 }}>
        {/* Bookmaker slots */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
          {[0,1,2].map(i => {
            const color = SLOT_COLORS[i];
            const bk    = bookmakers.find(b => b.id === slots[i]);
            return (
              <div key={i} style={{ display:'flex', flexDirection:'column', gap:4 }}>
                <label style={{ fontFamily:M, fontSize:7, letterSpacing:2, color, display:'block' }}>
                  BOOKMAKER {i+1}{i>0?' (optional)':''}
                </label>
                <div style={{ display:'flex', gap:4 }}>
                  <select
                    value={slots[i]??''}
                    onChange={e => setSlot(i, Number(e.target.value)||null)}
                    style={{ ...s.mini, flex:1, borderColor:`${color}44` }}
                  >
                    <option value="">— none —</option>
                    {bookmakers
                      .filter(b => !slots.includes(b.id) || slots[i] === b.id)
                      .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  {slots[i] && (
                    <button onClick={()=>setSlot(i,null)} style={{ ...s.ghost, padding:'4px 8px', fontSize:10, color:'rgba(255,61,90,.6)', borderColor:'rgba(255,61,90,.3)' }}>✕</button>
                  )}
                </div>
                {bk && (
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap' as const }}>
                    <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>{bk.domain}</span>
                    <span style={{ fontFamily:M, fontSize:7, padding:'1px 5px', color, background:`${color}14`, border:`1px solid ${color}44` }}>{bk.vendor_slug||'betb2b'}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sport / Mode / Probe button */}
        <div style={{ display:'flex', gap:10, alignItems:'flex-end' }}>
          <div style={{ flex:'0 0 160px' }}>
            <label style={s.lbl}>SPORT</label>
            <select value={sport} onChange={e=>setSport(e.target.value)} style={s.mini}>
              {SPORTS.map(sp=><option key={sp}>{sp}</option>)}
            </select>
          </div>
          <div style={{ flex:'0 0 130px' }}>
            <label style={s.lbl}>MODE</label>
            <select value={mode} onChange={e=>setMode(e.target.value)} style={s.mini}>
              {MODES.map(m=><option key={m}>{m}</option>)}
            </select>
          </div>
          <button
            onClick={probeAll}
            disabled={!activeSlots.length || probing}
            style={{ ...s.btn, opacity:(!activeSlots.length||probing)?.4:1 }}
          >
            {probing ? `⟳ PROBING ${activeSlots.length}…` : `▶ PROBE ${activeSlots.length > 1 ? `ALL ${activeSlots.length}` : ''}`}
          </button>
          <button
            onClick={probeAllBookmakers}
            disabled={probingAll}
            style={{ ...s.cyan, fontSize:8, opacity:probingAll?.4:1 }}
          >
            {probingAll ? '⟳ FETCHING ALL…' : '⚡ PROBE ALL BOOKMAKERS'}
          </button>
          {hasAnyResult && (
            <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
              {results.filter(Boolean).map((r,i) => r && (
                <span key={i} style={{ fontFamily:M, fontSize:8, color:r.ok?SLOT_COLORS[i]:'var(--red)' }}>
                  {r.ok ? `✓ ${r.count}` : '✗'} {bookmakers.find(b=>b.id===slots[i])?.name}
                  {r.latency_ms!=null && <span style={{ color:'var(--text-muted)', marginLeft:4 }}>{r.latency_ms}ms</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Error panels ── */}
      {results.map((r, i) => r && !r.ok && (
        <div key={i} style={{ padding:'8px 12px', background:'rgba(255,61,90,.04)', border:'1px solid rgba(255,61,90,.3)', fontFamily:M, fontSize:9, color:'var(--red)' }}>
          ✗ {bookmakers.find(b=>b.id===slots[i])?.name}: {r.error || `HTTP ${r.status}`}
        </div>
      ))}

      {/* ── Comparison match list ── */}
      {compRows.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          {/* Header */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr' + activeSlots.map(()=>' 180px').join(''), gap:0, background:'var(--bg-elevated)', border:'1px solid var(--border-dim)', padding:'6px 14px' }}>
            <span style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)' }}>MATCH</span>
            {activeSlots.map(({id, i}) => {
              const bk = bookmakers.find(b => b.id === id);
              return (
                <span key={i} style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:SLOT_COLORS[i], textAlign:'center' as const }}>
                  {bk?.name?.toUpperCase()}
                </span>
              );
            })}
          </div>

          {compRows.map(({ key, slotMatches }) => {
            const isOpen = expanded?.startsWith(key);
            // Use first non-null match for display info
            const baseMatch = slotMatches.find(Boolean);
            if (!baseMatch) return null;

            return (
              <div key={key} style={{ border:'1px solid var(--border-dim)', background:'var(--bg-surface)' }}>
                {/* Row header */}
                <div
                  onClick={() => setExpanded(isOpen ? null : key)}
                  style={{ display:'grid', gridTemplateColumns:'1fr' + activeSlots.map(()=>' 180px').join(''), gap:0, padding:'10px 14px', cursor:'pointer', alignItems:'center', background:isOpen?'rgba(255,255,255,.02)':'transparent' }}
                >
                  <div>
                    <div style={{ fontFamily:M, fontSize:11, fontWeight:700, color:'var(--text-primary)' }}>
                      {baseMatch.home_team} <span style={{ color:'var(--text-muted)', fontWeight:400 }}>v</span> {baseMatch.away_team}
                    </div>
                    <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', marginTop:2 }}>
                      {baseMatch.competition}
                      {baseMatch.start_time && <span style={{ marginLeft:8 }}>{new Date(baseMatch.start_time).toLocaleTimeString()}</span>}
                    </div>
                  </div>

                  {/* 1X2 odds per bookmaker */}
                  {activeSlots.map(({i}) => {
                    const m   = slotMatches[i];
                    const mkt = m?.markets?.['1X2'] || {};
                    const h   = typeof mkt['Home']==='object' ? mkt['Home']?.odds : mkt['Home'];
                    const d   = typeof mkt['Draw']==='object' ? mkt['Draw']?.odds : mkt['Draw'];
                    const a   = typeof mkt['Away']==='object' ? mkt['Away']?.odds : mkt['Away'];
                    return (
                      <div key={i} style={{ display:'flex', gap:4, justifyContent:'center' }}>
                        {[['H',h],['D',d],['A',a]].map(([lbl,val]) => (
                          <div key={String(lbl)} style={{ textAlign:'center' as const, minWidth:44, padding:'3px 6px', background:'rgba(255,255,255,.04)', border:`1px solid ${val?SLOT_COLORS[i]+'44':'var(--border-dim)'}` }}>
                            <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)' }}>{lbl}</div>
                            <div style={{ fontFamily:M, fontSize:11, fontWeight:800, color:val?SLOT_COLORS[i]:'var(--text-muted)' }}>
                              {val ? Number(val).toFixed(2) : '—'}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {/* Expanded: all markets per bookmaker */}
                {isOpen && (
                  <div style={{ borderTop:'1px solid var(--border-dim)', padding:'10px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:4 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailMatch(baseMatch as any); }}
                        style={{ fontFamily:M, fontSize:7, letterSpacing:1.5, padding:'4px 12px', background:'rgba(198,241,53,.08)', border:'1px solid rgba(198,241,53,.35)', color:'var(--acid)', cursor:'pointer' }}
                      >
                        ⚡ FULL MARKETS + ARBITRAGE →
                      </button>
                    </div>
                    {activeSlots.map(({id, i}) => {
                      const m  = slotMatches[i];
                      const bk = bookmakers.find(b => b.id === id);
                      if (!m) return (
                        <div key={i} style={{ padding:'8px 12px', background:'rgba(255,255,255,.02)', border:'1px solid var(--border-dim)', fontFamily:M, fontSize:8, color:'var(--text-muted)' }}>
                          {bk?.name} — match not found
                        </div>
                      );
                      return (
                        <div key={i}>
                          <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:SLOT_COLORS[i], marginBottom:6, display:'flex', alignItems:'center', gap:8 }}>
                            {bk?.name?.toUpperCase()}
                            <button
                              onClick={() => setRawView(rawView===i?null:i)}
                              style={{ ...s.ghost, fontSize:6, padding:'2px 8px' }}
                            >
                              {rawView===i?'HIDE':'RAW JSON'}
                            </button>
                          </div>
                          {rawView === i ? (
                            <pre style={{ margin:0, fontFamily:M, fontSize:8, color:'rgba(167,243,208,.8)', background:'rgba(0,0,0,.5)', padding:'10px 12px', maxHeight:280, overflowY:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' as const }}>
                              {JSON.stringify(m, null, 2)}
                            </pre>
                          ) : (
                            <RawOddsTable markets={m.markets||{}} accent={SLOT_COLORS[i]} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Probe-all result ── */}
      {probeAllRes && (() => {
        const bkNamesAll: string[] = probeAllRes.per_bookmaker ? Object.keys(probeAllRes.per_bookmaker) : [];
        const deduped: ProbeMatchData[] = (() => {
          if (!probeAllRes.matches) return [];
          const seen = new Set<string>();
          return probeAllRes.matches.filter((m: ProbeMatchData) => {
            const key = `${m.home_team?.toLowerCase()}|${m.away_team?.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          });
        })();
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {/* Summary bar */}
            <div style={{ display:'flex', gap:10, alignItems:'center', padding:'10px 14px', flexWrap:'wrap' as const,
              background: probeAllRes.total > 0 ? 'rgba(198,241,53,.04)' : 'rgba(255,61,90,.04)',
              border:`1px solid ${probeAllRes.total > 0 ? 'rgba(198,241,53,.25)' : 'rgba(255,61,90,.25)'}` }}>
              <span style={{ fontFamily:M, fontSize:13, fontWeight:800, color: probeAllRes.total > 0 ? 'var(--acid)' : 'var(--red)' }}>
                {probeAllRes.total > 0 ? `${deduped.length} MATCHES` : `✗ ${probeAllRes.error || 'No data'}`}
              </span>
              <span style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)' }}>
                · {bkNamesAll.filter((n: string) => probeAllRes.per_bookmaker?.[n]?.ok).length}/{bkNamesAll.length} with matches
                · {bkNamesAll.filter((n: string) => probeAllRes.per_bookmaker?.[n]?.api_ok).length} APIs responding
              </span>
              {probeAllRes.total === 0 && bkNamesAll.some((n: string) => probeAllRes.per_bookmaker?.[n]?.api_ok) && (
                <span style={{ fontFamily:M, fontSize:8, color:'var(--amber)', padding:'2px 8px', background:'rgba(255,179,0,.08)', border:'1px solid rgba(255,179,0,.3)' }}>
                  ⚠ APIs online but no live {sport} right now — try UPCOMING
                </span>
              )}
              <button onClick={()=>setProbeAllRes(null)} style={{ ...s.ghost, fontSize:7, padding:'2px 8px', marginLeft:'auto' }}>✕ CLOSE</button>
            </div>

            {/* Per-bookmaker status pills */}
            {probeAllRes.per_bookmaker && (
              <div style={{ display:'flex', gap:5, flexWrap:'wrap' as const }}>
                {bkNamesAll.map((bkName: string, i: number) => {
                  const stat = probeAllRes.per_bookmaker[bkName];
                  const c    = getBkColor(i);
                  return (
                    <div key={bkName} style={{ display:'flex', gap:5, alignItems:'center', padding:'4px 10px',
                      background: stat.ok ? `${c}12` : stat.api_ok ? `${c}06` : 'rgba(255,61,90,.06)',
                      border:`1px solid ${stat.ok ? `${c}40` : stat.api_ok ? `${c}25` : 'rgba(255,61,90,.25)'}` }}>
                      <div style={{ width:6, height:6, borderRadius:'50%',
                        background: stat.ok ? c : stat.api_ok ? 'var(--amber)' : 'var(--red)',
                        flexShrink:0 }}/>
                      <span style={{ fontFamily:M, fontSize:9, fontWeight:700,
                        color: stat.ok ? c : stat.api_ok ? 'var(--amber)' : 'var(--red)' }}>{bkName}</span>
                      <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>
                        {stat.ok
                          ? `${stat.count} · ${stat.latency_ms}ms`
                          : stat.api_ok
                            ? `0 matches · ${stat.latency_ms}ms`
                            : (stat.error?.substring(0,30) || 'failed')}
                      </span>
                      {stat.api_ok && !stat.ok && (
                        <span style={{ fontFamily:M, fontSize:6, color:'var(--amber)', letterSpacing:0.5 }}>
                          ↳ 0 {sport} matches
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Match comparison cards */}
            {deduped.slice(0, 30).map((match: ProbeMatchData, i: number) => (
              <ProbeMatchCard
                key={`${match.home_team}|${match.away_team}`}
                match={match}
                bkNames={bkNamesAll}
                defaultOpen={i === 0}
                onClick={() => setDetailMatch(match)}
              />
            ))}
            {deduped.length > 30 && (
              <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', textAlign:'center' as const, padding:'8px',
                background:'var(--bg-surface)', border:'1px solid var(--border-dim)' }}>
                showing 30 of {deduped.length} matches
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Empty state ── */}
      {!hasAnyResult && !probing && !probeAllRes && (
        <div style={{ padding:'48px 0', textAlign:'center' as const, fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>
          Select 1–3 bookmakers to compare odds, or use ⚡ PROBE ALL to fetch all bookmakers at once
        </div>
      )}
    </div>
  );
}
// s View Tab — browse cached unified odds ───────────────────────────────
function OddsViewTab({ bookmakers, onMatchClick }: { bookmakers: Bookmaker[]; onMatchClick?: (m: any) => void }) {
  const [sport,    setSport]   = useState('Football');
  const [mode,     setMode]    = useState('upcoming');
  const [loading,  setLoading] = useState(false);
  const [data,     setData]    = useState<any>(null);
  const [expanded, setExpanded]= useState<number | null>(null);
  const [market,   setMarket]  = useState('');

  const load = async () => {
    setLoading(true); setExpanded(null);
    try {
      const qs  = market ? `?market=${encodeURIComponent(market)}` : '';
      const url = mode === 'live' ? `/odds/live/${encodeURIComponent(sport)}${qs}` : `/odds/sport/${encodeURIComponent(sport)}${qs}`;
      const res = await fetchWithAuth(url).then((r: Response) => r.json());
      setData(res);
    } catch { setData(null); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [sport, mode]);

  const matches: Match[] = data?.matches || [];
  const allMarkets = [...new Set(matches.flatMap(m => Object.keys(m.markets || {})))].sort();

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Controls */}
      <div style={{ display:'grid', gridTemplateColumns:'160px 140px 1fr auto auto', gap:10, alignItems:'flex-end', padding:'12px 14px', background:'var(--bg-surface)', border:'1px solid var(--border-dim)' }}>
        <div>
          <label style={s.lbl}>SPORT</label>
          <select value={sport} onChange={e=>setSport(e.target.value)} style={s.mini}>
            {SPORTS.map(sp=><option key={sp}>{sp}</option>)}
          </select>
        </div>
        <div>
          <label style={s.lbl}>MODE</label>
          <select value={mode} onChange={e=>setMode(e.target.value)} style={s.mini}>
            {MODES.map(m=><option key={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={s.lbl}>FILTER MARKET</label>
          <select value={market} onChange={e=>setMarket(e.target.value)} style={s.mini}>
            <option value="">All markets</option>
            {allMarkets.map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <button onClick={load} disabled={loading} style={{ ...s.btn, opacity:loading?.5:1 }}>
          {loading?'⟳':'↻'} REFRESH
        </button>
        <div style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', whiteSpace:'nowrap' }}>
          {data?.total ?? 0} matches
        </div>
      </div>

      {/* Notice — cached data */}
      <div style={{ padding:'6px 12px', background:'rgba(56,189,248,.04)', border:'1px solid rgba(56,189,248,.2)', fontFamily:M, fontSize:8, color:'rgba(56,189,248,.8)' }}>
        ℹ Showing cached data from Celery workers. Use the PROBE tab for real-time data.
        Customers see this same cached feed at /odds/sport/{sport}.
      </div>

      {/* Matches */}
      {loading && <div style={{ padding:'32px', textAlign:'center', fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>Loading…</div>}
      {!loading && !matches.length && <div style={{ padding:'32px', textAlign:'center', fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>
        No cached data — trigger a harvest from the MONITOR tab first
      </div>}

      {matches.map((match, i) => {
        const bks = Object.keys(match.bookmakers || {});
        return (
          <div key={i} style={{ border:'1px solid var(--border-dim)', background:'var(--bg-surface)' }}>
            <div onClick={()=>setExpanded(expanded===i?null:i)} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', cursor:'pointer', position:'relative' as const }}>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:M, fontSize:11, fontWeight:700, color:'var(--text-primary)' }}>
                  {match.home_team} <span style={{ color:'var(--text-muted)', fontWeight:400 }}>v</span> {match.away_team}
                </div>
                <div style={{ display:'flex', gap:8, marginTop:3 }}>
                  <span style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)' }}>{match.competition}</span>
                  <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>
                    {bks.length} bookmaker{bks.length!==1?'s':''}
                  </span>
                  {match.status === 'live' && match.score_home != null && (
                    <span style={{ fontFamily:M, fontSize:8, color:'var(--red)', fontWeight:700 }}>
                      {match.score_home}–{match.score_away} 🔴
                    </span>
                  )}
                </div>
              </div>
              {/* Best 1X2 odds */}
              <div style={{ display:'flex', gap:5 }}>
                {(['Home','Draw','Away'] as const).map(o => {
                  const m = match.markets?.['1X2']?.[o];
                  return m ? (
                    <div key={o} style={{ textAlign:'center', padding:'3px 10px', background:'rgba(255,255,255,.04)', border:'1px solid var(--border-dim)', minWidth:48 }}>
                      <div style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>{o}</div>
                      <div style={{ fontFamily:M, fontSize:12, fontWeight:800, color:'var(--acid)' }}>{m.odds.toFixed(2)}</div>
                      <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)' }}>{m.bookmaker}</div>
                    </div>
                  ) : null;
                })}
              </div>
              {/* Bookmaker pills */}
              <div style={{ display:'flex', gap:3, flexWrap:'wrap', maxWidth:160 }}>
                {bks.map(bk => <span key={bk} style={{ ...pill('var(--cyan)'), fontSize:7 }}>{bk}</span>)}
              </div>
              <span style={{ fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>{expanded===i?'▲':'▼'}</span>
              {onMatchClick && (
                <button
                  onClick={(e) => { e.stopPropagation(); onMatchClick(match); }}
                  style={{ fontFamily:M, fontSize:6, letterSpacing:1, padding:'2px 8px', background:'rgba(198,241,53,.08)', border:'1px solid rgba(198,241,53,.3)', color:'var(--acid)', cursor:'pointer', flexShrink:0 }}
                >
                  ⚡ FULL
                </button>
              )}
            </div>
            {expanded === i && (
              <div style={{ borderTop:'1px solid var(--border-dim)', padding:'10px 14px' }}>
                <OddsTable match={match} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ─── Sport Config Editor ──────────────────────────────────────────────────────
// Per-sport endpoint grid. Each sport gets its own URL + ordered params + headers.
// Params are list-of-tuples so order is preserved (matches browser exactly).

const ALL_SPORTS = ['Football','Basketball','Tennis','Ice Hockey','Volleyball','Cricket','Rugby','Table Tennis','Snooker'];
const DEFAULT_SPORT_IDS: Record<string,string> = {
  Football:'1', Basketball:'3', Tennis:'4', 'Ice Hockey':'2',
  Volleyball:'5', Cricket:'21', Rugby:'8', 'Table Tennis':'19', Snooker:'14',
};

function buildDefaultSportConfig(domain: string, partner: string, gr: string, sportId: string) {
  const params: [string,string][] = [
    ['count','40'], ['lng','en'],
    ...(gr ? [['gr', gr]] as [string,string][] : []),
    ['mode','{{mode}}'],
    ['country','87'],
    ['partner', partner],
    ['virtualSports','true'],
    ['noFilterBlockEvent','true'],
    ['sports', sportId],
  ];
  return {
    url: `https://${domain}/service-api/LiveFeed/Get1x2_VZip`,
    params,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer': `https://${domain}/en/live`,
      'x-app-n': '__BETTING_APP__',
      'x-mobile-project-id': '0',
      'x-requested-with': 'XMLHttpRequest',
      'x-svc-source': '__BETTING_APP__',
    },
  };
}

function SportConfigEditor({ bookmarkerId, domain, csvRow, toast$, onRefresh }: {
  bookmarkerId: number | null;
  domain: string;
  csvRow?: CsvBookmaker;
  toast$: (msg: string, ok?: boolean) => void;
  onRefresh: () => void;
}) {
  const [sportsCfg,   setSportsCfg]  = useState<Record<string,any>>({});
  const [activeSport, setActiveSport]= useState<string>('Football');
  const [editJson,    setEditJson]   = useState('');
  const [saving,      setSaving]     = useState(false);
  const [deleting,    setDeleting]   = useState(false);
  const [autoFilling, setAutoFilling]= useState(false);
  const [probing,     setProbing]    = useState(false);
  const [probeResults,setProbeResults]= useState<Record<string,any>>({});
  const [validating,  setValidating] = useState(false);

  // Load per-sport configs
  const loadSportConfigs = async () => {
    if (!bookmarkerId) return;
    try {
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports`).then((r:Response)=>r.json());
      setSportsCfg(res.sports || {});
    } catch {}
  };

  useEffect(() => { loadSportConfigs(); }, [bookmarkerId]);

  // When active sport changes, load its JSON into editor
  useEffect(() => {
    const cfg = sportsCfg[activeSport];
    setEditJson(cfg ? JSON.stringify(cfg, null, 2) : '');
  }, [activeSport, sportsCfg]);

  const configuredSports = Object.keys(sportsCfg);
  const hasCfg = (sport: string) => !!sportsCfg[sport];

  // Auto-fill all sports from CSV partner/gr
  const autoFill = async () => {
    if (!bookmarkerId) return;
    const partner = csvRow?.betb2b_partner || '';
    const gr      = csvRow?.betb2b_gr      || '';
    if (!partner) { toast$('⚠ Import CSV first to get partner ID', false); return; }
    setAutoFilling(true);
    try {
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports/auto-fill`, {
        method: 'POST',
        body:   JSON.stringify({ partner, gr }),
      }).then((r:Response)=>r.json());
      if (res.ok) {
        setSportsCfg(res.sports || {});
        toast$(`✓ Auto-filled ${res.filled_sports?.length} sports`);
        onRefresh();
      } else {
        toast$(`✗ ${res.error}`, false);
      }
    } catch (e:any) { toast$(`✗ ${e.message}`, false); }
    setAutoFilling(false);
  };

  // Fill current sport from CSV defaults
  const fillCurrentSport = () => {
    if (!csvRow?.betb2b_partner) { toast$('Import CSV first', false); return; }
    const cfg = buildDefaultSportConfig(
      domain, csvRow.betb2b_partner, csvRow.betb2b_gr || '',
      DEFAULT_SPORT_IDS[activeSport] || '1'
    );
    setEditJson(JSON.stringify(cfg, null, 2));
  };

  // Save current sport config
  const saveSport = async () => {
    if (!bookmarkerId) return;
    setSaving(true);
    try {
      const parsed = JSON.parse(editJson);
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports/${encodeURIComponent(activeSport)}`, {
        method: 'PUT',
        body:   JSON.stringify(parsed),
      }).then((r:Response)=>r.json());
      if (res.ok) {
        setSportsCfg(prev => ({ ...prev, [activeSport]: res.config }));
        toast$(`✓ ${activeSport} config saved`);
      } else {
        toast$(`✗ ${res.error}`, false);
      }
    } catch (e:any) { toast$(`✗ ${e.message}`, false); }
    setSaving(false);
  };

  // Delete current sport config
  const deleteSport = async () => {
    if (!bookmarkerId || !confirm(`Remove ${activeSport} config?`)) return;
    setDeleting(true);
    try {
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports/${encodeURIComponent(activeSport)}`, {
        method: 'DELETE',
      }).then((r:Response)=>r.json());
      if (res.ok) {
        const next = { ...sportsCfg }; delete next[activeSport];
        setSportsCfg(next); setEditJson('');
        toast$(`✓ ${activeSport} removed`);
      }
    } catch (e:any) { toast$(`✗ ${e.message}`, false); }
    setDeleting(false);
  };

  // Probe current sport live
  const probeSport = async () => {
    if (!bookmarkerId) return;
    setProbing(true);
    try {
      const res = await fetchWithAuth('/odds/admin/probe', {
        method: 'POST',
        body:   JSON.stringify({ bookmaker_id: bookmarkerId, sport: activeSport, mode: 'live' }),
      }).then((r:Response)=>r.json());
      setProbeResults(prev => ({ ...prev, [activeSport]: res }));
    } catch (e:any) { setProbeResults(prev => ({ ...prev, [activeSport]: { ok:false, error: String(e) } })); }
    setProbing(false);
  };

  // Validate all sports
  const validateAll = async () => {
    if (!bookmarkerId) return;
    setValidating(true); setProbeResults({});
    try {
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports/validate-all`, {
        method: 'POST',
      }).then((r:Response)=>r.json());
      setProbeResults(res.results || {});
      toast$(`✓ ${res.ok_sports}/${res.total_sports} sports responding`);
    } catch (e:any) { toast$(`✗ ${e.message}`, false); }
    setValidating(false);
  };

  const sportProbeResult = probeResults[activeSport];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      {/* Toolbar */}
      <div style={{ display:'flex', gap:6, padding:'8px 12px', borderBottom:'1px solid var(--border-dim)', flexWrap:'wrap' as const, flexShrink:0 }}>
        <span style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', alignSelf:'center' }}>
          {configuredSports.length}/{ALL_SPORTS.length} SPORTS CONFIGURED
        </span>
        {csvRow?.betb2b_partner && (
          <button onClick={autoFill} disabled={autoFilling} style={{ ...s.btn, fontSize:7, padding:'4px 10px' }}>
            {autoFilling ? '⟳ FILLING…' : `⚡ AUTO-FILL ALL FROM CSV (partner=${csvRow.betb2b_partner})`}
          </button>
        )}
        <button onClick={validateAll} disabled={validating} style={{ ...s.ghost, fontSize:7, padding:'4px 10px' }}>
          {validating ? '⟳ TESTING…' : '▶ TEST ALL SPORTS'}
        </button>
        <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', alignSelf:'center', marginLeft:'auto' }}>
          {'{{mode}}'} = "4" live / "1" upcoming — replaced at fetch time
        </span>
      </div>

      {/* Sport tabs */}
      <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--border-dim)', overflowX:'auto', flexShrink:0 }}>
        {ALL_SPORTS.map(sport => {
          const pr = probeResults[sport];
          const configured = hasCfg(sport);
          return (
            <button key={sport} onClick={()=>setActiveSport(sport)} style={{
              fontFamily:M, fontSize:7, padding:'6px 12px', whiteSpace:'nowrap' as const, cursor:'pointer',
              background: activeSport===sport ? 'rgba(255,255,255,.04)' : 'transparent',
              border:'none', borderBottom:`2px solid ${activeSport===sport?'var(--acid)':'transparent'}`,
              color: pr ? (pr.ok?'var(--acid)':'var(--red)') : configured ? 'var(--text-primary)' : 'var(--text-muted)',
            }}>
              {sport}
              {configured && !pr && <span style={{ marginLeft:4, color:'var(--acid)', fontSize:6 }}>✓</span>}
              {pr && <span style={{ marginLeft:4, fontSize:7 }}>{pr.ok ? `✓${pr.count}` : '✗'}</span>}
            </button>
          );
        })}
      </div>

      {/* Editor + probe side by side */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {/* JSON editor */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'10px 12px', gap:8, minWidth:0 }}>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <span style={{ fontFamily:M, fontSize:9, fontWeight:700, color:'var(--acid)' }}>{activeSport}</span>
            {csvRow?.betb2b_partner && (
              <button onClick={fillCurrentSport} style={{ ...s.ghost, fontSize:6, padding:'2px 8px', borderColor:'rgba(198,241,53,.3)', color:'var(--acid)' }}>
                ↺ FILL FROM CSV
              </button>
            )}
            <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', marginLeft:'auto' }}>
              sport_id default: {DEFAULT_SPORT_IDS[activeSport] || '?'}
            </span>
          </div>

          {!hasCfg(activeSport) && !editJson && (
            <div style={{ padding:'20px', background:'rgba(255,255,255,.02)', border:'1px dashed rgba(255,255,255,.1)', fontFamily:M, fontSize:8, color:'var(--text-muted)', textAlign:'center' as const }}>
              No config for {activeSport} yet.
              {csvRow?.betb2b_partner && ' Click FILL FROM CSV to generate one.'}
            </div>
          )}

          {(hasCfg(activeSport) || editJson) && (
            <textarea
              value={editJson}
              onChange={e=>setEditJson(e.target.value)}
              rows={16}
              spellCheck={false}
              style={{ ...s.mini, fontFamily:M, fontSize:8, lineHeight:1.5, resize:'vertical', flex:1 }}
            />
          )}

          <div style={{ display:'flex', gap:6 }}>
            <button onClick={probeSport} disabled={probing||!hasCfg(activeSport)} style={{ ...s.ghost, fontSize:7, padding:'4px 10px' }}>
              {probing ? '⟳ PROBING…' : '▶ PROBE LIVE'}
            </button>
            <button onClick={deleteSport} disabled={deleting||!hasCfg(activeSport)} style={{ ...s.ghost, fontSize:7, padding:'4px 10px', color:'var(--red)', borderColor:'rgba(255,61,90,.3)' }}>
              🗑 REMOVE
            </button>
            <button onClick={saveSport} disabled={saving||!editJson} style={{ ...s.btn, fontSize:7, padding:'4px 10px', opacity:(saving||!editJson)?.5:1 }}>
              {saving ? 'SAVING…' : 'SAVE ' + activeSport.toUpperCase()}
            </button>
          </div>
        </div>

        {/* Probe result panel */}
        {sportProbeResult && (
          <div style={{ width:220, borderLeft:'1px solid var(--border-dim)', padding:'10px 12px', display:'flex', flexDirection:'column', gap:8, overflow:'auto', flexShrink:0 }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <span style={{ fontFamily:M, fontSize:8, fontWeight:700, color:sportProbeResult.ok?'var(--acid)':'var(--red)' }}>
                {sportProbeResult.ok ? `✓ ${sportProbeResult.count} matches` : '✗ FAILED'}
              </span>
              <button onClick={()=>setProbeResults(prev=>{const n={...prev};delete n[activeSport];return n;})} style={{ fontFamily:M, fontSize:9, background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer' }}>✕</button>
            </div>
            {sportProbeResult.latency_ms != null && (
              <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>{sportProbeResult.latency_ms}ms</span>
            )}
            {sportProbeResult.error && (
              <div style={{ fontFamily:M, fontSize:7, color:'var(--red)', padding:'4px 6px', background:'rgba(255,61,90,.05)', border:'1px solid rgba(255,61,90,.2)' }}>
                {sportProbeResult.error}
              </div>
            )}
            {sportProbeResult.matches?.slice(0,5).map((m:any, i:number) => (
              <div key={i} style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', borderBottom:'1px solid rgba(255,255,255,.04)', paddingBottom:4 }}>
                <div style={{ color:'var(--text-primary)', fontSize:8 }}>{m.home_team}</div>
                <div>v {m.away_team}</div>
                <div style={{ color:Object.keys(m.markets||{}).length?'var(--acid)':'var(--red)', fontSize:6 }}>
                  {Object.keys(m.markets||{}).join(', ') || 'no markets'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bookmaker Config Tab ─────────────────────────────────────────────────────

interface CsvBookmaker {
  name: string; domain: string; vendor_slug: string;
  betb2b_partner: string; betb2b_gr: string; betb2b_endpoint: string;
  brand_color?: string;
}
interface ConfigHistory { config: any; saved_by: string; saved_at: string }

function BookmakerConfigTab({ bookmakers, onRefresh }: { bookmakers: Bookmaker[]; onRefresh: ()=>void }) {
  const [selected,   setSelected]   = useState<number | null>(null);
  const [config,     setConfig]     = useState('');
  const [vendor,     setVendor]     = useState('betb2b');
  const [saving,     setSaving]     = useState(false);
  const [validating, setValidating] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [toast,      setToast]      = useState<{msg:string;ok:boolean}|null>(null);
  const [csvData,    setCsvData]    = useState<CsvBookmaker[]>([]);
  const [csvError,   setCsvError]   = useState('');
  const [showAdd,    setShowAdd]    = useState(false);
  const [newBm,      setNewBm]      = useState({ name:'', domain:'', vendor_slug:'betb2b', brand_color:'#1F8AEB' });
  const [adding,     setAdding]     = useState(false);
  const [history,    setHistory]    = useState<ConfigHistory[]>([]);
  const [showHistory,setShowHistory]= useState(false);
  const [probeResult,setProbeResult]= useState<any>(null);
  const [activeSection, setActiveSection] = useState<'editor'|'validate'|'history'>('editor');

  const toast$ = (msg: string, ok = true) => {
    setToast({msg, ok});
    setTimeout(() => setToast(null), 4000);
  };

  // ── Load config from API when bookmaker selected ──────────────────────────
  useEffect(() => {
    if (!selected) return;
    setHistory([]); setProbeResult(null); setShowHistory(false);
    fetchWithAuth(`/bookmakers/${selected}/config`)
      .then((r: Response) => r.json())
      .then((d: any) => {
        const cfg = d.harvest_config || {};
        setConfig(JSON.stringify(cfg, null, 2));
        setVendor(d.vendor_slug || 'betb2b');
      }).catch(() => {});
  }, [selected]);

  // ── Load history ──────────────────────────────────────────────────────────
  const loadHistory = async () => {
    if (!selected) return;
    const res = await fetchWithAuth(`/bookmakers/${selected}/config/history`).then((r: Response) => r.json());
    setHistory(res.history || []);
    setShowHistory(true);
    setActiveSection('history');
  };

  // ── CSV import ────────────────────────────────────────────────────────────
  const importCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text   = ev.target?.result as string;
        const lines  = text.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        const parsed: CsvBookmaker[] = lines.slice(1).map(line => {
          const vals = line.split(',');
          const row: any = {};
          headers.forEach((h, i) => row[h] = (vals[i] || '').trim());
          return row as CsvBookmaker;
        }).filter(r => r.name && r.domain);
        setCsvData(parsed);
      } catch (err: any) { setCsvError(`CSV error: ${err.message}`); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Build BetB2B config from CSV row ──────────────────────────────────────
  const buildBetB2BConfig = (row: CsvBookmaker) => ({
    params: {
      ...(row.betb2b_gr ? { gr: row.betb2b_gr } : {}),
      lng: "en", mode: "4", country: "87",
      partner: row.betb2b_partner || "REPLACE_WITH_PARTNER_ID",
      virtualSports: "true", noFilterBlockEvent: "true",
    },
    headers: {
      "Accept":              "application/json, text/plain, */*",
      "Accept-Language":     "en-GB,en-US;q=0.9,en;q=0.8",
      "Referer":             `https://${row.domain}/en/live`,
      "x-app-n":             "__BETTING_APP__",
      "x-mobile-project-id": "0",
      "x-requested-with":    "XMLHttpRequest",
      "x-svc-source":        "__BETTING_APP__",
    },
    sport_mappings: [
      {sport_name:"Football",   bk_sport_id:"1",  param_key:"sports",param_in:"query"},
      {sport_name:"Basketball", bk_sport_id:"3",  param_key:"sports",param_in:"query"},
      {sport_name:"Tennis",     bk_sport_id:"4",  param_key:"sports",param_in:"query"},
      {sport_name:"Ice Hockey", bk_sport_id:"2",  param_key:"sports",param_in:"query"},
      {sport_name:"Volleyball", bk_sport_id:"5",  param_key:"sports",param_in:"query"},
      {sport_name:"Cricket",    bk_sport_id:"21", param_key:"sports",param_in:"query"},
    ],
  });

  const findCsvRow = (bm: Bookmaker): CsvBookmaker | undefined =>
    csvData.find(r =>
      r.domain.toLowerCase() === bm.domain?.toLowerCase() ||
      r.name.toLowerCase()   === bm.name?.toLowerCase()
    );

  const selectedBm = bookmakers.find(b => b.id === selected);
  const csvRow     = selectedBm ? findCsvRow(selectedBm) : undefined;

  // ── Create bookmaker via /bookmakers/onboard then patch vendor+color ───────
  const createBookmaker = async () => {
    if (!newBm.name || !newBm.domain) return;
    setAdding(true);
    try {
      // Step 1: onboard (find-or-create by domain)
      const res = await fetchWithAuth('/bookmakers/onboard', {
        method: 'POST',
        body:   JSON.stringify({ name: newBm.name, domain: newBm.domain }),
      }).then((r: Response) => r.json());

      if (!res.id) { toast$(`✗ ${res.error || 'Onboard failed'}`, false); setAdding(false); return; }

      // Step 2: patch vendor_slug + brand_color via PUT /bookmaker/<id>
      await fetchWithAuth(`/bookmaker/${res.id}`, {
        method: 'PUT',
        body:   JSON.stringify({ vendor_slug: newBm.vendor_slug, brand_color: newBm.brand_color }),
      });

      toast$(res.existing ? `ℹ ${res.name} already exists — config ready to set` : `✓ ${res.name} created`);
      setShowAdd(false);
      setNewBm({ name:'', domain:'', vendor_slug:'betb2b', brand_color:'#1F8AEB' });
      onRefresh();
      setSelected(res.id);
    } catch (err: any) { toast$(`✗ ${err.message}`, false); }
    setAdding(false);
  };

  // ── Toggle bookmaker active via /bookmaker/<id>/activate ─────────────────
  const toggleActive = async () => {
    if (!selected) return;
    try {
      const res = await fetchWithAuth(`/bookmaker/${selected}/activate`, { method: 'POST' })
        .then((r: Response) => r.json());
      toast$(`✓ ${selectedBm?.name} ${res.is_active ? 'activated' : 'deactivated'}`);
      onRefresh();
    } catch (err: any) { toast$(`✗ ${err.message}`, false); }
  };

  // ── Save config ───────────────────────────────────────────────────────────
  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const parsed = JSON.parse(config);
      const res = await fetchWithAuth(`/bookmakers/${selected}/config`, {
        method: 'PUT',
        body:   JSON.stringify({ harvest_config: parsed, vendor_slug: vendor }),
      }).then((r: Response) => r.json());
      if (res.ok) {
        toast$('✓ Config saved');
        onRefresh();
      } else {
        toast$(`✗ ${res.error || JSON.stringify(res)}`, false);
      }
    } catch (err: any) { toast$(`✗ ${err.message}`, false); }
    setSaving(false);
  };

  // ── Validate + probe ──────────────────────────────────────────────────────
  const validate = async () => {
    if (!selected) return;
    setValidating(true); setProbeResult(null); setActiveSection('validate');
    try {
      const parsed = JSON.parse(config);
      const res = await fetchWithAuth(`/bookmakers/${selected}/config/validate`, {
        method: 'POST',
        body:   JSON.stringify({ harvest_config: parsed, vendor_slug: vendor, probe: true }),
      }).then((r: Response) => r.json());
      setProbeResult(res);
    } catch (err: any) { setProbeResult({ valid: false, errors: [String(err)] }); }
    setValidating(false);
  };

  // ── Clear config ──────────────────────────────────────────────────────────
  const clearConfig = async () => {
    if (!selected || !confirm(`Clear this bookmaker's harvest config?`)) return;
    setDeleting(true);
    try {
      await fetchWithAuth(`/bookmakers/${selected}/config`, { method: 'DELETE' });
      setConfig('{}');
      toast$('✓ Config cleared');
      onRefresh();
    } catch (err: any) { toast$(`✗ ${err.message}`, false); }
    setDeleting(false);
  };

  // ── Delete bookmaker ──────────────────────────────────────────────────────
  const deleteBookmaker = async () => {
    if (!selected || !confirm(`Delete ${selectedBm?.name}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetchWithAuth(`/admin/bookmakers/${selected}`, { method: 'DELETE' });
      setSelected(null); setConfig('');
      toast$('✓ Bookmaker deleted');
      onRefresh();
    } catch (err: any) { toast$(`✗ ${err.message}`, false); }
    setDeleting(false);
  };

  // ── Restore from history ──────────────────────────────────────────────────
  const restoreHistory = async (index: number) => {
    if (!selected) return;
    const res = await fetchWithAuth(`/bookmakers/${selected}/config/restore/${index}`, {
      method: 'POST',
    }).then((r: Response) => r.json());
    if (res.ok) {
      setConfig(JSON.stringify(res.harvest_config, null, 2));
      setShowHistory(false); setActiveSection('editor');
      toast$('✓ Config restored');
    }
  };

  const SPORTPESA_PRESET = {
    headers: {Accept:"application/json"}, params: {markets:"10,46,52,43"},
    list_url:"https://www.ke.sportpesa.com/api/games",
    markets_url:"https://www.ke.sportpesa.com/api/games/markets",
  };
  const GENERIC_PRESET = {
    headers:{}, params:{}, list_url:"",
    field_map:{match_id:"id",home_team:"home",away_team:"away",sport:"sport",competition:"league",start_time:"startTime"},
    array_path:"",
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

      {/* ── Toast ── */}
      {toast && (
        <div style={{ padding:'8px 14px', fontFamily:M, fontSize:9,
          color: toast.ok ? 'var(--acid)' : 'var(--red)',
          background: toast.ok ? 'rgba(198,241,53,.06)' : 'rgba(255,61,90,.06)',
          border:`1px solid ${toast.ok ? 'rgba(198,241,53,.3)' : 'rgba(255,61,90,.3)'}`,
          borderBottom:'none',
        }}>{toast.msg}</div>
      )}

      {/* ── CSV import bar ── */}
      <div style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 14px', borderBottom:'1px solid var(--border-dim)', background:'rgba(255,255,255,.01)' }}>
        <span style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)' }}>CSV</span>
        <label style={{ ...s.ghost, fontSize:7, cursor:'pointer', padding:'4px 10px', position:'relative' as const }}>
          📂 IMPORT
          <input type="file" accept=".csv" onChange={importCsv} style={{ position:'absolute', opacity:0, width:0, height:0 }} />
        </label>
        {csvError && <span style={{ fontFamily:M, fontSize:7, color:'var(--red)' }}>{csvError}</span>}
        {csvData.length > 0 && (
          <span style={{ fontFamily:M, fontSize:7, color:'var(--acid)' }}>
            ✓ {csvData.length} rows · {csvData.filter(r=>r.vendor_slug==='betb2b' && r.betb2b_partner).length} confirmed BetB2B
          </span>
        )}
        <span style={{ marginLeft:'auto', fontFamily:M, fontSize:7, color:'var(--text-muted)' }}>
          {bookmakers.length} bookmakers in DB
        </span>
        <button onClick={()=>setShowAdd(v=>!v)} style={{ ...s.ghost, fontSize:7, padding:'4px 10px', marginLeft:'auto', borderColor:'rgba(198,241,53,.3)', color:'var(--acid)' }}>
          {showAdd ? '✕ CANCEL' : '+ ADD BOOKMAKER'}
        </button>
      </div>

      {/* ── Add bookmaker form ── */}
      {showAdd && (
        <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border-dim)', background:'rgba(198,241,53,.02)', display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--acid)' }}>NEW BOOKMAKER</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 140px 90px', gap:8, alignItems:'flex-end' }}>
            <div>
              <label style={s.lbl}>NAME</label>
              <input value={newBm.name} onChange={e=>setNewBm(p=>({...p,name:e.target.value}))} placeholder="e.g. 1xBet" style={s.mini} />
            </div>
            <div>
              <label style={s.lbl}>DOMAIN</label>
              <input value={newBm.domain} onChange={e=>setNewBm(p=>({...p,domain:e.target.value}))} placeholder="e.g. 1xbet.co.ke" style={s.mini} />
            </div>
            <div>
              <label style={s.lbl}>VENDOR</label>
              <select value={newBm.vendor_slug} onChange={e=>setNewBm(p=>({...p,vendor_slug:e.target.value}))} style={s.mini}>
                <option value="betb2b">BetB2B</option>
                <option value="sportpesa">Sportpesa</option>
                <option value="generic">Generic</option>
              </select>
            </div>
            <div>
              <label style={s.lbl}>COLOR</label>
              <input type="color" value={newBm.brand_color} onChange={e=>setNewBm(p=>({...p,brand_color:e.target.value}))} style={{ ...s.mini, height:32, padding:2, cursor:'pointer' }} />
            </div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button onClick={()=>setShowAdd(false)} style={{ ...s.ghost, fontSize:8 }}>CANCEL</button>
            <button onClick={createBookmaker} disabled={adding||!newBm.name||!newBm.domain} style={{ ...s.btn, opacity:(adding||!newBm.name||!newBm.domain)?.5:1 }}>
              {adding ? 'CREATING…' : 'CREATE'}
            </button>
          </div>
        </div>
      )}

      {/* ── BetB2B grid from CSV ── */}
      {csvData.filter(r => r.vendor_slug === 'betb2b').length > 0 && (
        <div style={{ borderBottom:'1px solid var(--border-dim)', padding:'8px 14px', background:'rgba(198,241,53,.01)' }}>
          <div style={{ fontFamily:M, fontSize:6, letterSpacing:2, color:'var(--acid)', marginBottom:6 }}>BETB2B FROM CSV</div>
          <div style={{ display:'flex', flexWrap:'wrap' as const, gap:4 }}>
            {csvData.filter(r => r.vendor_slug === 'betb2b').map(row => {
              const dbBm    = bookmakers.find(b => b.domain?.toLowerCase() === row.domain.toLowerCase() || b.name?.toLowerCase() === row.name.toLowerCase());
              const isMatch = dbBm?.id === selected;
              return (
                <button key={row.domain}
                  onClick={() => { if (dbBm) { setSelected(dbBm.id); setVendor('betb2b'); setConfig(JSON.stringify(buildBetB2BConfig(row), null, 2)); setActiveSection('editor'); } }}
                  style={{ background: isMatch?'rgba(198,241,53,.08)':'rgba(255,255,255,.02)', border:`1px solid ${isMatch?'var(--acid)':row.betb2b_partner?'rgba(198,241,53,.2)':'rgba(251,146,60,.3)'}`, padding:'6px 10px', cursor: dbBm?'pointer':'not-allowed', textAlign:'left' as const, opacity:dbBm?1:.4 }}
                  title={dbBm?`id=${dbBm.id}`:'Not in DB'}
                >
                  <div style={{ fontFamily:M, fontSize:8, fontWeight:700, color:row.betb2b_partner?'var(--acid)':'#fb923c' }}>{row.name}</div>
                  <div style={{ fontFamily:M, fontSize:6, color:'var(--text-muted)' }}>{row.domain}</div>
                  <div style={{ fontFamily:M, fontSize:7, color:row.betb2b_partner?'var(--acid)':'#fb923c' }}>
                    partner={row.betb2b_partner||'⚠'} {row.betb2b_gr&&<span style={{color:'var(--text-muted)'}}>gr={row.betb2b_gr}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Main layout ── */}
      <div style={{ display:'flex', gap:0, minHeight:520 }}>

        {/* Sidebar */}
        <div style={{ width:210, borderRight:'1px solid var(--border-dim)', flexShrink:0, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'7px 12px', borderBottom:'1px solid var(--border-dim)', fontFamily:M, fontSize:6, letterSpacing:2, color:'var(--text-muted)', background:'var(--bg-surface)', flexShrink:0 }}>
            DB BOOKMAKERS
          </div>
          <div style={{ overflowY:'auto', flex:1 }}>
            {bookmakers.map(bm => {
              const csv   = findCsvRow(bm);
              const hasCfg = !!bm.vendor_slug;
              return (
                <div key={bm.id} onClick={() => { setSelected(bm.id); setActiveSection('editor');
                  if (csv?.vendor_slug === 'betb2b') { setVendor('betb2b'); setConfig(JSON.stringify(buildBetB2BConfig(csv), null, 2)); }
                  else if (csv?.vendor_slug === 'sportpesa') { setVendor('sportpesa'); setConfig(JSON.stringify(SPORTPESA_PRESET, null, 2)); }
                }}
                  style={{ padding:'8px 12px', cursor:'pointer', background:selected===bm.id?'rgba(198,241,53,.06)':'transparent', borderLeft:`3px solid ${selected===bm.id?'var(--acid)':'transparent'}`, borderBottom:'1px solid var(--border-dim)' }}
                >
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span style={{ fontFamily:M, fontSize:9, color:selected===bm.id?'var(--acid)':'var(--text-primary)', fontWeight:selected===bm.id?700:400 }}>{bm.name}</span>
                    <span style={{ fontFamily:M, fontSize:6, color: bm.vendor_slug ? 'var(--acid)' : 'var(--text-muted)', padding:'1px 4px', border:`1px solid ${ bm.vendor_slug ?'rgba(198,241,53,.3)':'rgba(255,255,255,.1)'}` }}>
                      {bm.vendor_slug ? '✓ CFG' : 'NO CFG'}
                    </span>
                  </div>
                  <div style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', marginTop:2 }}>{bm.domain}</div>
                  <div style={{ fontFamily:M, fontSize:6, color:'rgba(56,189,248,.6)', marginTop:1 }}>{bm.vendor_slug}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          {!selected ? (
            <div style={{ padding:'64px', textAlign:'center' as const, fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>
              {csvData.length > 0 ? 'Click a bookmaker to configure' : 'Import CSV then select a bookmaker'}
            </div>
          ) : (
            <>
              {/* Bookmaker header */}
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderBottom:'1px solid var(--border-dim)', background:'rgba(255,255,255,.01)', flexShrink:0 }}>
                <span style={{ fontFamily:M, fontSize:12, fontWeight:800, color:'var(--text-primary)' }}>{selectedBm?.name}</span>
                <span style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)' }}>{selectedBm?.domain}</span>
                <span style={pill('var(--cyan)')}>{vendor}</span>
                <button onClick={toggleActive} style={{ ...pill(selectedBm?.is_active ? 'var(--acid)' : 'var(--red)'), background: selectedBm?.is_active ? 'rgba(198,241,53,.08)' : 'rgba(255,61,90,.08)', border: `1px solid ${selectedBm?.is_active ? 'rgba(198,241,53,.4)' : 'rgba(255,61,90,.4)'}`, cursor:'pointer', padding:'2px 8px' }}>
                  {selectedBm?.is_active ? '● ACTIVE' : '○ INACTIVE'}
                </button>
                <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
                  <button onClick={loadHistory} style={{ ...s.ghost, fontSize:7, padding:'4px 10px' }}>⏱ HISTORY</button>
                  <button onClick={clearConfig} disabled={deleting} style={{ ...s.ghost, fontSize:7, padding:'4px 10px', color:'#fb923c', borderColor:'rgba(251,146,60,.4)' }}>🗑 CLEAR CONFIG</button>
                  <button onClick={deleteBookmaker} disabled={deleting} style={{ ...s.ghost, fontSize:7, padding:'4px 10px', color:'var(--red)', borderColor:'rgba(255,61,90,.4)' }}>✕ DELETE</button>
                </div>
              </div>

              {/* Section tabs */}
              <div style={{ display:'flex', borderBottom:'1px solid var(--border-dim)', flexShrink:0 }}>
                {(['editor','validate','history'] as const).map(sec => (
                  <button key={sec} onClick={() => { setActiveSection(sec); if (sec==='history') loadHistory(); }}
                    style={{ fontFamily:M, fontSize:7, letterSpacing:2, padding:'7px 14px', background:'transparent', border:'none', borderBottom:`2px solid ${activeSection===sec?'var(--acid)':'transparent'}`, cursor:'pointer', color:activeSection===sec?'var(--acid)':'var(--text-muted)' }}>
                    {sec === 'editor' ? '✏ EDITOR' : sec === 'validate' ? '⚡ VALIDATE + PROBE' : '⏱ HISTORY'}
                  </button>
                ))}
              </div>

              {/* ── EDITOR section ── */}
              {activeSection === 'editor' && (
                <SportConfigEditor
                  bookmarkerId={selected}
                  domain={selectedBm?.domain || ''}
                  csvRow={csvRow}
                  toast$={toast$}
                  onRefresh={onRefresh}
                />
              )}

              {/* ── VALIDATE section ── */}
              {activeSection === 'validate' && (
                <div style={{ flex:1, padding:'12px 14px', overflow:'auto' }}>
                  <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                    <button onClick={validate} disabled={validating} style={{ ...s.btn, opacity:validating?.5:1 }}>
                      {validating ? '⟳ PROBING…' : '▶ RUN VALIDATE + PROBE'}
                    </button>
                    <span style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', alignSelf:'center' }}>
                      Checks schema then does a live Football/live fetch
                    </span>
                  </div>

                  {probeResult && (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      {/* Valid/invalid banner */}
                      <div style={{ padding:'8px 12px', background:probeResult.valid?'rgba(198,241,53,.05)':'rgba(255,61,90,.05)', border:`1px solid ${probeResult.valid?'rgba(198,241,53,.3)':'rgba(255,61,90,.3)'}`, fontFamily:M, fontSize:10, color:probeResult.valid?'var(--acid)':'var(--red)', fontWeight:800 }}>
                        {probeResult.valid ? '✓ VALID' : '✗ INVALID'}
                        {probeResult.probe_latency != null && <span style={{ fontSize:8, fontWeight:400, marginLeft:12, color:'var(--text-muted)' }}>{probeResult.probe_latency}ms</span>}
                      </div>

                      {/* Errors */}
                      {(probeResult.errors||[]).map((e: string, i: number) => (
                        <div key={i} style={{ padding:'6px 10px', background:'rgba(255,61,90,.05)', border:'1px solid rgba(255,61,90,.3)', fontFamily:M, fontSize:8, color:'var(--red)' }}>✗ {e}</div>
                      ))}

                      {/* Warnings */}
                      {(probeResult.warnings||[]).map((w: string, i: number) => (
                        <div key={i} style={{ padding:'6px 10px', background:'rgba(251,146,60,.05)', border:'1px solid rgba(251,146,60,.3)', fontFamily:M, fontSize:8, color:'#fb923c' }}>⚠ {w}</div>
                      ))}

                      {/* Probe result */}
                      {probeResult.probe_ok !== undefined && (
                        <div style={{ padding:'8px 12px', background:probeResult.probe_ok?'rgba(198,241,53,.03)':'rgba(255,61,90,.03)', border:`1px solid ${probeResult.probe_ok?'rgba(198,241,53,.2)':'rgba(255,61,90,.2)'}` }}>
                          <div style={{ fontFamily:M, fontSize:9, color:probeResult.probe_ok?'var(--acid)':'var(--red)', fontWeight:700, marginBottom:6 }}>
                            {probeResult.probe_ok ? `✓ LIVE PROBE: ${probeResult.probe_count} matches` : `✗ PROBE FAILED: ${probeResult.probe_error}`}
                          </div>
                          {probeResult.probe_sample?.map((m: any, i: number) => (
                            <div key={i} style={{ fontFamily:M, fontSize:8, color:'var(--text-muted)', padding:'2px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                              {m.home_team} v {m.away_team}
                              <span style={{ marginLeft:8, color:'var(--text-muted)', fontSize:7 }}>{m.competition}</span>
                              <span style={{ marginLeft:8, color: Object.keys(m.markets||{}).length ? 'var(--acid)' : 'var(--red)', fontSize:7 }}>
                                {Object.keys(m.markets||{}).length} markets
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!probeResult && !validating && (
                    <div style={{ padding:'32px', textAlign:'center' as const, fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>
                      Click RUN to validate the current JSON and probe the API
                    </div>
                  )}
                </div>
              )}

              {/* ── HISTORY section ── */}
              {activeSection === 'history' && (
                <div style={{ flex:1, padding:'12px 14px', overflow:'auto' }}>
                  {history.length === 0 ? (
                    <div style={{ padding:'32px', textAlign:'center' as const, fontFamily:M, fontSize:9, color:'var(--text-muted)' }}>No history yet</div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      <div style={{ fontFamily:M, fontSize:7, letterSpacing:2, color:'var(--text-muted)', marginBottom:4 }}>
                        LAST {history.length} SAVED CONFIGS — click RESTORE to load
                      </div>
                      {history.map((h, i) => (
                        <div key={i} style={{ border:'1px solid var(--border-dim)', background:'rgba(255,255,255,.02)' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderBottom:'1px solid var(--border-dim)' }}>
                            <span style={{ fontFamily:M, fontSize:7, color:'var(--text-muted)', flex:1 }}>
                              {i === 0 ? '← LATEST' : `${i+1} versions ago`}
                              <span style={{ marginLeft:8 }}>{new Date(h.saved_at).toLocaleString()}</span>
                              <span style={{ marginLeft:8, color:'rgba(56,189,248,.7)' }}>{h.saved_by}</span>
                            </span>
                            <button onClick={() => restoreHistory(i)} style={{ ...s.ghost, fontSize:7, padding:'3px 8px', borderColor:'rgba(198,241,53,.4)', color:'var(--acid)' }}>
                              ↩ RESTORE
                            </button>
                          </div>
                          <pre style={{ margin:0, padding:'8px 12px', fontFamily:M, fontSize:7, color:'rgba(167,243,208,.7)', maxHeight:120, overflow:'auto', whiteSpace:'pre-wrap' }}>
                            {JSON.stringify(h.config, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AdminOddsMonitor() {
  const [tab,        setTab]        = useState<'monitor'|'probe'|'odds'|'sbo'|'config'>('monitor');
  const [bookmakers, setBookmakers] = useState<Bookmaker[]>([]);
  const [detailMatch, setDetailMatch] = useState<any>(null);

  const loadBks = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/admin/bookmakers').then((r: Response) => r.json());
      setBookmakers(Array.isArray(res) ? res : (res.items || []));
    } catch {}
  }, []);

  useEffect(() => { loadBks(); }, [loadBks]);

  const TABS = [
    { key: 'monitor' as const, label: '⚙ MONITOR', accent: 'var(--acid)' },
    { key: 'probe'   as const, label: '▶ PROBE',   accent: 'var(--acid)' },
    { key: 'odds'    as const, label: '📊 ODDS',   accent: 'var(--acid)' },
    { key: 'sbo'     as const, label: '⚡ SBO',    accent: SBO_GOLD      },
    { key: 'config'  as const, label: '🔧 CONFIG', accent: 'var(--acid)' },
  ];

  return (
    <div style={{ maxWidth:1300, margin:'0 auto', fontFamily:M }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:M, fontSize:20, fontWeight:800, letterSpacing:3, margin:0, color:'var(--acid)' }}>ODDS MONITOR</h1>
          <p style={{ fontFamily:M, fontSize:8, letterSpacing:3, color:'var(--text-muted)', marginTop:4, marginBottom:0 }}>
            {bookmakers.filter(b=>b.is_active).length} ACTIVE BOOKMAKERS · CELERY WORKERS
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
            background: `${SBO_GOLD}0A`, border: `1px solid ${SBO_GOLD}33` }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: SBO_GOLD,
              boxShadow: `0 0 5px ${SBO_GOLD}` }} />
            <span style={{ fontFamily: M, fontSize: 7, color: SBO_GOLD, letterSpacing: 1 }}>SBO ENGINE</span>
          </div>
          <a href="/odds/sport/Football" target="_blank" style={{ ...s.ghost, textDecoration: 'none', fontSize: 8 }}>
            PUBLIC API →
          </a>
        </div>
      </div>

      {/* Tab nav */}
      <div style={{ display: 'flex', borderBottom: '2px solid var(--border-dim)', marginBottom: 16 }}>
        {TABS.map(t => {
          const isActive = tab === t.key;
          const isSbo    = t.key === 'sbo';
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              fontFamily: M, fontSize: 8, letterSpacing: 2, padding: '9px 18px',
              background: isActive ? (isSbo ? `${SBO_GOLD}08` : 'var(--bg-surface)') : 'transparent',
              border: 'none',
              borderBottom: `2px solid ${isActive ? t.accent : 'transparent'}`,
              marginBottom: -2, cursor: 'pointer',
              color: isActive ? t.accent : 'var(--text-muted)',
              textShadow: isActive && isSbo ? `0 0 12px ${SBO_GOLD}66` : 'none',
            }}>
              {t.label}
              {isSbo && !isActive && (
                <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
                  background: SBO_GOLD, marginLeft: 5, verticalAlign: 'middle',
                  boxShadow: `0 0 4px ${SBO_GOLD}` }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Match detail overlay (global) */}
      {detailMatch && (
        <MatchDetailView
          match={detailMatch}
          bookmakers={bookmakers}
          onClose={() => setDetailMatch(null)}
        />
      )}

      {/* Tab content */}
      <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-dim)', padding:'16px' }}>
        {tab === 'monitor' && <MonitorTab bookmakers={bookmakers} />}
        {tab === 'probe'   && <ProbeTab   bookmakers={bookmakers} />}
        {tab === 'odds'    && <OddsViewTab bookmakers={bookmakers} onMatchClick={setDetailMatch} />}
        {tab === 'sbo'     && <SboTab onMatchClick={setDetailMatch} />}
        {tab === 'config'  && <BookmakerConfigTab bookmakers={bookmakers} onRefresh={loadBks} />}
      </div>

      <style>{`
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        select option{background:var(--bg-elevated,#0c150c);color:var(--text-primary,#eee)}
        input:focus,select:focus,textarea:focus{outline:none;border-color:rgba(198,241,53,.4)!important}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1)}
      `}</style>
    </div>
  );
}