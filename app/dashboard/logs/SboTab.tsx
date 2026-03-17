/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SboTab.tsx
 * ===========
 * Premium SBO tab for AdminOddsMonitor — Sportpesa / Betika / Odibets unified
 * odds engine.  Drop this file into the same directory as AdminOddsMonitor.tsx
 * and import it:
 *
 *   import SboTab from './SboTab';
 *
 * Then add the tab button + render in AdminOddsMonitor's main return.
 * See integration instructions at the bottom of this file.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── shared mono font (same as parent) ───────────────────────────────────────
const M = "'IBM Plex Mono','Fira Code',monospace";

// ─── SBO colour palette ───────────────────────────────────────────────────────
const GOLD   = '#F5C842';
const GOLD2  = '#FFE082';
const AMBER  = '#FB923C';
const GREEN  = '#4ADE80';
const RED    = '#F87171';
const CYAN   = '#38BDF8';
const MUTED  = 'rgba(255,255,255,.38)';
const BORDER = 'rgba(245,200,66,.18)';

const BK_COLORS: Record<string, string> = {
  Sportpesa: '#1FB954',
  Betika:    '#E8312A',
  Odibets:   '#0066CC',
};

// ─── Sport display names ──────────────────────────────────────────────────────
const SPORT_DISPLAY: Record<string, string> = {
  soccer: 'Football', basketball: 'Basketball', tennis: 'Tennis',
  'ice-hockey': 'Ice Hockey', volleyball: 'Volleyball', cricket: 'Cricket',
  rugby: 'Rugby', boxing: 'Boxing', handball: 'Handball',
  mma: 'MMA / UFC', 'table-tennis': 'Table Tennis', esoccer: 'E-Soccer',
  snooker: 'Snooker', darts: 'Darts', 'american-football': 'American Football',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SboSport {
  sport: string;
  display: string;
  bookmakers: string[];
  sportpesa_id?: string;
  betika_id?: number;
  odibets_id?: string;
}

interface SboOdd { odd: number; bookie: string }
interface SboArbBet { outcome: string; bookie: string; odd: number; stake_pct: number }
interface SboArb {
  market: string;
  profit_pct: number;
  implied_prob: number;
  bets: SboArbBet[];
}

interface SboBookmakerEntry {
  fetched_at?: string;
  market_count?: number;
  raw_markets?: any[];
  error?: string;
}

interface SboMatch {
  betradar_id:  string;
  home_team:    string;
  away_team:    string;
  competition:  string;
  sport:        string;
  start_time:   string | null;
  bookie_count: number;
  market_count: number;
  best_odds:    Record<string, Record<string, SboOdd>>;
  bookmakers:   Record<string, SboBookmakerEntry>;
  arbitrage:    SboArb[];
  best_profit?: number;
}

interface SboResponse {
  sport:      string;
  display:    string;
  total:      number;
  arb_count:  number;
  latency_ms: number;
  page:       number;
  per_page:   number;
  pages:      number;
  bookmakers: string[];
  meta:       { sportpesa_count: number; betika_count: number; odibets_count: number };
  matches:    SboMatch[];
}

interface ProbeResponse {
  ok:           boolean;
  sport:        string;
  total:        number;
  arb_count:    number;
  latency_ms:   number;
  bookmakers:   string[];
  per_bookmaker: Record<string, { ok: boolean; count: number; latency_ms: number | null; error: string | null }>;
  matches:      SboMatch[];
  error?:       string;
}

// ─── Shared micro-components ──────────────────────────────────────────────────

function Pill({ children, color = GOLD }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      fontFamily: M, fontSize: 7, letterSpacing: 1,
      padding: '1px 7px', color,
      background: `${color}18`, border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  );
}

function StatCard({ label, value, color = GOLD, sub }: {
  label: string; value: any; color?: string; sub?: string
}) {
  return (
    <div style={{
      padding: '12px 14px',
      background: `${color}06`,
      border: `1px solid ${color}28`,
    }}>
      <div style={{ fontFamily: M, fontSize: 20, fontWeight: 800, color, letterSpacing: -1 }}>
        {value}
      </div>
      <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 3, color: MUTED, marginTop: 3 }}>
        {label}
      </div>
      {sub && <div style={{ fontFamily: M, fontSize: 7, color: MUTED, opacity: .6, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Arb badge ────────────────────────────────────────────────────────────────
function ArbBadge({ arb }: { arb: SboArb }) {
  const [open, setOpen] = useState(false);
  const profit = arb.profit_pct;
  const c = profit > 3 ? GREEN : profit > 1 ? GOLD : AMBER;

  return (
    <div style={{ background: `${c}0C`, border: `1px solid ${c}44`, marginBottom: 4 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer' }}
      >
        <span style={{ fontFamily: M, fontSize: 16, fontWeight: 900, color: c }}>
          +{profit.toFixed(2)}%
        </span>
        <span style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: c }}>
          ARB · {arb.market.toUpperCase().replace(/_/g, ' ')}
        </span>
        <span style={{ fontFamily: M, fontSize: 7, color: MUTED, marginLeft: 'auto' }}>
          impl. prob {arb.implied_prob.toFixed(1)}%
        </span>
        <span style={{ fontFamily: M, fontSize: 9, color: c, transform: open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform .15s' }}>›</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${c}22`, padding: '6px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
          {arb.bets.map((bet, i) => (
            <div key={i} style={{
              padding: '5px 10px', flex: 1, minWidth: 90,
              background: `${BK_COLORS[bet.bookie] || GOLD}10`,
              border: `1px solid ${BK_COLORS[bet.bookie] || GOLD}44`,
              textAlign: 'center' as const,
            }}>
              <div style={{ fontFamily: M, fontSize: 6, color: BK_COLORS[bet.bookie] || GOLD, letterSpacing: 1, marginBottom: 2 }}>
                {bet.bookie}
              </div>
              <div style={{ fontFamily: M, fontSize: 8, color: MUTED }}>{bet.outcome}</div>
              <div style={{ fontFamily: M, fontSize: 15, fontWeight: 800, color: c }}>{bet.odd.toFixed(2)}</div>
              <div style={{ fontFamily: M, fontSize: 7, color: MUTED }}>{bet.stake_pct.toFixed(1)}%</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Odds comparison row ──────────────────────────────────────────────────────
function BestOddsGrid({ bestOdds, markets }: { bestOdds: Record<string, Record<string, SboOdd>>; markets?: string[] }) {
  const keys = markets ?? ['1x2', 'over_under_2.5', 'btts', 'double_chance'];
  const present = keys.filter(k => bestOdds[k]);
  if (!present.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {present.map(mkt => {
        const outcomes = bestOdds[mkt];
        return (
          <div key={mkt} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <div style={{
              fontFamily: M, fontSize: 7, letterSpacing: 1.5, color: MUTED,
              width: 130, flexShrink: 0, padding: '0 8px 0 0',
            }}>
              {mkt.replace(/_/g, ' ').toUpperCase()}
            </div>
            <div style={{ display: 'flex', gap: 0, flex: 1 }}>
              {Object.entries(outcomes).map(([out, { odd, bookie }]) => {
                const bc = BK_COLORS[bookie] || GOLD;
                return (
                  <div key={out} style={{
                    flex: 1, textAlign: 'center' as const, padding: '4px 6px',
                    borderRight: `1px solid ${BORDER}`,
                  }}>
                    <div style={{ fontFamily: M, fontSize: 6, color: MUTED, marginBottom: 1 }}>{out}</div>
                    <div style={{ fontFamily: M, fontSize: 12, fontWeight: 800, color: GOLD2 }}>
                      {odd.toFixed(2)}
                    </div>
                    <div style={{
                      fontFamily: M, fontSize: 6, color: bc,
                      padding: '0px 4px', background: `${bc}14`, marginTop: 1, display: 'inline-block',
                    }}>
                      {bookie.substring(0, 3).toUpperCase()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Single match card ────────────────────────────────────────────────────────
function SboMatchCard({ match, defaultOpen = false, onDetailClick }: {
  match: SboMatch;
  defaultOpen?: boolean;
  onDetailClick?: (m: SboMatch) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasArb   = match.arbitrage?.length > 0;
  const bestProfit = hasArb
    ? Math.max(...match.arbitrage.map(a => a.profit_pct))
    : 0;

  const borderColor = hasArb ? GREEN : BORDER;

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderLeft: `3px solid ${hasArb ? GREEN : `${GOLD}44`}`,
      background: hasArb ? `${GREEN}04` : 'var(--bg-surface)',
      marginBottom: 4,
    }}>
      {/* Header row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer' }}
      >
        {/* Teams */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: M, fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {match.home_team}
            <span style={{ color: MUTED, fontWeight: 400, margin: '0 6px', fontSize: 9 }}>v</span>
            {match.away_team}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>{match.competition}</span>
            <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>
              {match.bookie_count} bk · {match.market_count} mkts
            </span>
            {match.start_time && (
              <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>
                {new Date(match.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>

        {/* Bookmaker dots */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {Object.keys(match.bookmakers).map(bk => (
            <div key={bk} style={{
              width: 7, height: 7, borderRadius: '50%',
              background: BK_COLORS[bk] || GOLD,
              boxShadow: `0 0 5px ${BK_COLORS[bk] || GOLD}66`,
            }} title={bk} />
          ))}
        </div>

        {/* Quick 1X2 */}
        {!open && match.best_odds?.['1x2'] && (
          <div style={{ display: 'flex', gap: 0 }}>
            {Object.entries(match.best_odds['1x2']).map(([out, { odd }]) => (
              <div key={out} style={{
                padding: '3px 8px', textAlign: 'center' as const,
                background: 'rgba(0,0,0,.25)', borderRight: `1px solid ${BORDER}`, minWidth: 44,
              }}>
                <div style={{ fontFamily: M, fontSize: 6, color: MUTED }}>{out}</div>
                <div style={{ fontFamily: M, fontSize: 12, fontWeight: 800, color: GOLD2 }}>
                  {odd.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Arb profit badge */}
        {hasArb && (
          <div style={{
            padding: '4px 10px', background: `${GREEN}14`,
            border: `1px solid ${GREEN}55`, fontFamily: M, fontSize: 12,
            fontWeight: 900, color: GREEN, flexShrink: 0,
          }}>
            +{bestProfit.toFixed(2)}%
          </div>
        )}

        <span style={{ fontFamily: M, fontSize: 9, color: MUTED }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded body */}
      {open && (
        <div style={{ borderTop: `1px solid ${BORDER}`, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Bookmaker legend */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
            {Object.entries(match.bookmakers).map(([bk, info]) => {
              const c = BK_COLORS[bk] || GOLD;
              const hasErr = !!info.error;
              return (
                <div key={bk} style={{
                  display: 'flex', gap: 5, alignItems: 'center',
                  padding: '3px 9px',
                  background: hasErr ? 'rgba(248,113,113,.06)' : `${c}0E`,
                  border: `1px solid ${hasErr ? 'rgba(248,113,113,.3)' : `${c}44`}`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: hasErr ? RED : c }} />
                  <span style={{ fontFamily: M, fontSize: 8, color: hasErr ? RED : c, fontWeight: 700 }}>{bk}</span>
                  {!hasErr && info.market_count != null && (
                    <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>{info.market_count} mkts</span>
                  )}
                  {hasErr && <span style={{ fontFamily: M, fontSize: 7, color: RED }}>✗</span>}
                </div>
              );
            })}
          </div>

          {/* Best odds grid */}
          <BestOddsGrid bestOdds={match.best_odds} />

          {/* Arbitrage opportunities */}
          {match.arbitrage?.length > 0 && (
            <div>
              <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: GREEN, marginBottom: 5 }}>
                ⚡ {match.arbitrage.length} ARBITRAGE OPPORTUNIT{match.arbitrage.length > 1 ? 'IES' : 'Y'}
              </div>
              {match.arbitrage.map((arb, i) => (
                <ArbBadge key={i} arb={arb} />
              ))}
            </div>
          )}

          {/* Detail link */}
          {onDetailClick && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onDetailClick(match); }}
                style={{
                  fontFamily: M, fontSize: 7, letterSpacing: 1.5,
                  padding: '4px 14px', cursor: 'pointer',
                  background: `${GOLD}10`, border: `1px solid ${GOLD}44`,
                  color: GOLD,
                }}
              >
                ⚡ FULL MARKETS →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Arbitrage leaderboard ────────────────────────────────────────────────────
function ArbLeaderboard({ matches }: { matches: SboMatch[] }) {
  const arbs = matches
    .filter(m => m.arbitrage?.length)
    .map(m => ({
      match: m,
      best:  Math.max(...m.arbitrage.map(a => a.profit_pct)),
      arb:   m.arbitrage.reduce((a, b) => a.profit_pct > b.profit_pct ? a : b),
    }))
    .sort((a, b) => b.best - a.best)
    .slice(0, 10);

  if (!arbs.length) return (
    <div style={{ padding: '24px', textAlign: 'center' as const, fontFamily: M, fontSize: 8, color: MUTED }}>
      No arbitrage opportunities detected in this batch
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: `1px solid ${BORDER}` }}>
      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 120px 80px', gap: 0, background: 'rgba(0,0,0,.3)', padding: '5px 12px' }}>
        {['MATCH', 'MARKET', 'BETS', 'PROFIT'].map(h => (
          <div key={h} style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: MUTED }}>{h}</div>
        ))}
      </div>
      {arbs.map(({ match, best, arb }, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: '1fr 90px 120px 80px',
          padding: '8px 12px',
          borderTop: i > 0 ? `1px solid ${BORDER}` : 'none',
          background: i === 0 ? `${GREEN}05` : 'transparent',
        }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: 'var(--text-primary)' }}>
              {match.home_team} v {match.away_team}
            </div>
            <div style={{ fontFamily: M, fontSize: 7, color: MUTED }}>{match.competition}</div>
          </div>
          <div style={{ fontFamily: M, fontSize: 8, color: MUTED, alignSelf: 'center' }}>
            {arb.market.replace(/_/g, ' ')}
          </div>
          <div style={{ display: 'flex', gap: 3, alignSelf: 'center', flexWrap: 'wrap' as const }}>
            {arb.bets.map((bet, j) => (
              <span key={j} style={{
                fontFamily: M, fontSize: 7,
                color: BK_COLORS[bet.bookie] || GOLD,
                background: `${BK_COLORS[bet.bookie] || GOLD}14`,
                padding: '1px 5px',
              }}>
                {bet.bookie.substring(0, 3)} {bet.odd.toFixed(2)}
              </span>
            ))}
          </div>
          <div style={{
            fontFamily: M, fontSize: 16, fontWeight: 900,
            color: best > 3 ? GREEN : best > 1 ? GOLD : AMBER,
            alignSelf: 'center',
          }}>
            +{best.toFixed(2)}%
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Per-bookmaker health panel ───────────────────────────────────────────────
function HealthPanel() {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const check = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/sbo/admin/health').then((r: Response) => r.json());
      setData(res);
    } catch (e: any) { setData({ ok: false, error: e.message }); }
    setLoading(false);
  };

  return (
    <div style={{ padding: '12px 14px', background: `${GOLD}05`, border: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: GOLD }}>BOOKMAKER HEALTH</span>
        <button onClick={check} disabled={loading} style={{
          fontFamily: M, fontSize: 7, letterSpacing: 1, padding: '3px 10px', cursor: 'pointer',
          background: `${GOLD}14`, border: `1px solid ${GOLD}44`, color: GOLD,
          opacity: loading ? .5 : 1,
        }}>
          {loading ? '⟳ CHECKING…' : '▶ CHECK NOW'}
        </button>
        {data?.checked_at && (
          <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>
            last: {new Date(data.checked_at).toLocaleTimeString()}
          </span>
        )}
      </div>
      {data?.bookmakers && (
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.entries(data.bookmakers as Record<string, any>).map(([bk, stat]) => {
            const c = stat.ok ? BK_COLORS[bk] || GREEN : RED;
            return (
              <div key={bk} style={{ flex: 1, padding: '8px 10px', background: `${c}0A`, border: `1px solid ${c}33`, textAlign: 'center' as const }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: stat.ok ? `0 0 8px ${c}` : 'none', margin: '0 auto 5px' }} />
                <div style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: c }}>{bk}</div>
                {stat.ok
                  ? <div style={{ fontFamily: M, fontSize: 8, color: MUTED }}>{stat.matches} matches · {stat.latency_ms}ms</div>
                  : <div style={{ fontFamily: M, fontSize: 7, color: RED }}>{stat.error?.substring(0, 40) || 'failed'}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main SBO Tab ─────────────────────────────────────────────────────────────

export default function SboTab({ onMatchClick }: { onMatchClick?: (m: any) => void }) {
  const [sports,       setSports]      = useState<SboSport[]>([]);
  const [activeSport,  setActiveSport] = useState('soccer');
  const [view,         setView]        = useState<'matches' | 'arb'>('matches');
  const [loading,      setLoading]     = useState(false);
  const [probing,      setProbing]     = useState(false);
  const [data,         setData]        = useState<SboResponse | null>(null);
  const [probeData,    setProbeData]   = useState<ProbeResponse | null>(null);
  const [maxMatches,   setMaxMatches]  = useState(20);
  const [marketFilter, setMarketFilter]= useState('');
  const [arbOnly,      setArbOnly]     = useState(false);
  const intervalRef = useRef<any>(null);

  // Load sports list on mount
  useEffect(() => {
    fetchWithAuth('/sbo/admin/sports')
      .then((r: Response) => r.json())
      .then((d: any) => setSports(d.sports || []))
      .catch(() => {});
  }, []);

  const fetchSport = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        max:      String(maxMatches),
        per_page: '50',
        ...(marketFilter ? { market: marketFilter } : {}),
        ...(arbOnly ? { arb_only: '1' } : {}),
      });
      const res = await fetchWithAuth(`/sbo/sport/${activeSport}?${qs}`)
        .then((r: Response) => r.json());
      setData(res);
    } catch { /* keep existing */ }
    setLoading(false);
  }, [activeSport, maxMatches, marketFilter, arbOnly]);

  const probe = async () => {
    setProbing(true); setProbeData(null);
    try {
      const res = await fetchWithAuth('/sbo/admin/probe', {
        method: 'POST',
        body:   JSON.stringify({ sport: activeSport, max: maxMatches, full_markets: true }),
      }).then((r: Response) => r.json());
      setProbeData(res);
      setData(null);
    } catch (e: any) { setProbeData({ ok: false, sport: activeSport, total: 0, arb_count: 0, latency_ms: 0, bookmakers: [], per_bookmaker: {}, matches: [], error: e.message }); }
    setProbing(false);
  };

  useEffect(() => { fetchSport(); }, [activeSport]);

  const matches = (probeData?.matches ?? data?.matches ?? []) as SboMatch[];
  const arbMatches = matches.filter(m => m.arbitrage?.length > 0)
    .sort((a, b) => Math.max(...b.arbitrage.map(x => x.profit_pct)) - Math.max(...a.arbitrage.map(x => x.profit_pct)));

  const displayMatches = (view === 'arb' ? arbMatches : matches);
  const arbCount   = arbMatches.length;
  const totalCount = matches.length;
  const latency    = probeData?.latency_ms ?? data?.latency_ms;
  const meta       = data?.meta;
  const perBk      = probeData?.per_bookmaker;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Premium header banner ── */}
      <div style={{
        padding: '12px 16px',
        background: `linear-gradient(135deg, ${GOLD}0A 0%, rgba(0,0,0,0) 60%)`,
        border: `1px solid ${GOLD}33`,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div>
          <div style={{ fontFamily: M, fontSize: 11, fontWeight: 800, letterSpacing: 2, color: GOLD }}>
            ⚡ SBO PREMIUM ENGINE
          </div>
          <div style={{ fontFamily: M, fontSize: 7, color: MUTED, marginTop: 2 }}>
            SPORTPESA · BETIKA · ODIBETS · UNIFIED VIA BETRADAR ID · ARBITRAGE DETECTION
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['Sportpesa', 'Betika', 'Odibets'] as const).map(bk => (
            <Pill key={bk} color={BK_COLORS[bk]}>{bk}</Pill>
          ))}
        </div>
      </div>

      {/* ── Health panel ── */}
      <HealthPanel />

      {/* ── Sport tabs ── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${BORDER}`, overflowX: 'auto' as const }}>
        {sports.map(sp => {
          const isActive = activeSport === sp.sport;
          return (
            <button key={sp.sport} onClick={() => setActiveSport(sp.sport)} style={{
              fontFamily: M, fontSize: 7, letterSpacing: 1.5, padding: '7px 14px',
              whiteSpace: 'nowrap' as const, cursor: 'pointer', border: 'none',
              borderBottom: `2px solid ${isActive ? GOLD : 'transparent'}`,
              background: isActive ? `${GOLD}08` : 'transparent',
              color: isActive ? GOLD : MUTED,
            }}>
              {sp.display || SPORT_DISPLAY[sp.sport] || sp.sport.toUpperCase()}
            </button>
          );
        })}
      </div>

      {/* ── Controls row ── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' as const,
        padding: '10px 14px', background: 'var(--bg-surface)', border: `1px solid ${BORDER}`,
      }}>
        {/* Max matches */}
        <div>
          <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: MUTED, marginBottom: 3 }}>MAX MATCHES</div>
          <select value={maxMatches} onChange={e => setMaxMatches(Number(e.target.value))} style={{
            background: 'var(--bg-base)', border: `1px solid ${BORDER}`,
            color: 'var(--text-primary)', fontFamily: M, fontSize: 9,
            padding: '5px 8px', outline: 'none', cursor: 'pointer',
          }}>
            {[10, 20, 30, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {/* Market filter */}
        <div>
          <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: MUTED, marginBottom: 3 }}>MARKET FILTER</div>
          <select value={marketFilter} onChange={e => setMarketFilter(e.target.value)} style={{
            background: 'var(--bg-base)', border: `1px solid ${BORDER}`,
            color: 'var(--text-primary)', fontFamily: M, fontSize: 9,
            padding: '5px 8px', outline: 'none', cursor: 'pointer', minWidth: 130,
          }}>
            <option value="">All markets</option>
            {['1x2', 'over_under_2.5', 'btts', 'double_chance', 'ht_1x2',
              'over_under_1.5', 'over_under_3.5', 'handicap_0:1'].map(m => (
              <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {/* Arb only toggle */}
        <button onClick={() => setArbOnly(v => !v)} style={{
          fontFamily: M, fontSize: 8, padding: '5px 12px', cursor: 'pointer',
          background: arbOnly ? `${GREEN}14` : 'transparent',
          border: `1px solid ${arbOnly ? `${GREEN}55` : BORDER}`,
          color: arbOnly ? GREEN : MUTED,
        }}>
          ⚡ ARB ONLY {arbOnly ? '✓' : ''}
        </button>

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button onClick={fetchSport} disabled={loading} style={{
            fontFamily: M, fontSize: 8, letterSpacing: 1.5, padding: '6px 14px',
            cursor: 'pointer', border: `1px solid ${GOLD}55`, color: GOLD,
            background: `${GOLD}0C`, opacity: loading ? .5 : 1,
          }}>
            {loading ? '⟳ LOADING…' : '↻ REFRESH'}
          </button>
          <button onClick={probe} disabled={probing} style={{
            fontFamily: M, fontSize: 8, letterSpacing: 1.5, padding: '6px 14px',
            cursor: 'pointer', border: `1px solid ${AMBER}55`, color: AMBER,
            background: `${AMBER}0C`, opacity: probing ? .5 : 1,
          }}>
            {probing ? '⟳ PROBING…' : '▶ LIVE PROBE'}
          </button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      {(totalCount > 0 || arbCount > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6 }}>
          <StatCard label="TOTAL MATCHES"    value={totalCount} />
          <StatCard label="ARB OPPORTUNITIES" value={arbCount}   color={GREEN} />
          <StatCard label="SPORTPESA"        value={meta?.sportpesa_count ?? matches.filter(m => 'Sportpesa' in m.bookmakers).length} color={BK_COLORS.Sportpesa} sub="matches" />
          <StatCard label="BETIKA"           value={meta?.betika_count    ?? matches.filter(m => 'Betika'    in m.bookmakers).length} color={BK_COLORS.Betika}    sub="matches" />
          <StatCard label="ODIBETS"          value={meta?.odibets_count   ?? matches.filter(m => 'Odibets'   in m.bookmakers).length} color={BK_COLORS.Odibets}   sub="matches" />
        </div>
      )}

      {/* ── Per-bookmaker status (from probe) ── */}
      {perBk && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
          {Object.entries(perBk).map(([bk, stat]) => {
            const c = stat.ok ? BK_COLORS[bk] || GREEN : stat.error ? RED : AMBER;
            return (
              <div key={bk} style={{
                display: 'flex', gap: 6, alignItems: 'center', padding: '5px 12px',
                background: `${c}0A`, border: `1px solid ${c}33`,
              }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: stat.ok ? `0 0 6px ${c}` : 'none' }} />
                <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: c }}>{bk}</span>
                <span style={{ fontFamily: M, fontSize: 7, color: MUTED }}>
                  {stat.ok ? `${stat.count} matches` : stat.error ? stat.error.substring(0, 35) : '0 matches'}
                  {stat.latency_ms != null && ` · ${stat.latency_ms}ms`}
                </span>
              </div>
            );
          })}
          {latency != null && (
            <div style={{ marginLeft: 'auto', fontFamily: M, fontSize: 7, color: MUTED, alignSelf: 'center' }}>
              {latency}ms total
            </div>
          )}
        </div>
      )}

      {/* ── View toggle ── */}
      {totalCount > 0 && (
        <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${BORDER}` }}>
          {([
            { key: 'matches' as const, label: `ALL MATCHES (${totalCount})` },
            { key: 'arb'     as const, label: `⚡ ARBITRAGE (${arbCount})`, color: GREEN },
          ]).map(({ key, label, color }) => (
            <button key={key} onClick={() => setView(key)} style={{
              fontFamily: M, fontSize: 7, letterSpacing: 2, padding: '7px 16px',
              background: 'transparent', border: 'none',
              borderBottom: `2px solid ${view === key ? (color || GOLD) : 'transparent'}`,
              cursor: 'pointer', color: view === key ? (color || GOLD) : MUTED,
            }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Arb leaderboard ── */}
      {view === 'arb' && arbCount > 0 && (
        <div>
          <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: GREEN, marginBottom: 8 }}>
            TOP ARBITRAGE OPPORTUNITIES
          </div>
          <ArbLeaderboard matches={matches} />
          <div style={{ marginTop: 12, fontFamily: M, fontSize: 7, letterSpacing: 2, color: GREEN, marginBottom: 6 }}>
            DETAILED BREAKDOWN
          </div>
        </div>
      )}

      {/* ── Match list ── */}
      {loading && (
        <div style={{ padding: '40px', textAlign: 'center' as const, fontFamily: M, fontSize: 9, color: MUTED }}>
          ⟳ Fetching {SPORT_DISPLAY[activeSport] || activeSport} from Sportpesa · Betika · Odibets…
        </div>
      )}

      {!loading && displayMatches.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center' as const, fontFamily: M, fontSize: 9, color: MUTED }}>
          {arbOnly || view === 'arb'
            ? 'No arbitrage opportunities found in this batch'
            : `No matches returned for ${SPORT_DISPLAY[activeSport] || activeSport} — try increasing MAX or running LIVE PROBE`}
        </div>
      )}

      {displayMatches.slice(0, 50).map((m, i) => (
        <SboMatchCard
          key={m.betradar_id || `${m.home_team}|${m.away_team}`}
          match={m}
          defaultOpen={view === 'arb' && i === 0}
          onDetailClick={onMatchClick ? (match) => onMatchClick(match) : undefined}
        />
      ))}

      {displayMatches.length > 50 && (
        <div style={{
          padding: '10px', textAlign: 'center' as const, fontFamily: M, fontSize: 8, color: MUTED,
          background: 'var(--bg-surface)', border: `1px solid ${BORDER}`,
        }}>
          showing 50 of {displayMatches.length} matches · increase MAX to fetch more
        </div>
      )}
    </div>
  );
}


/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * HOW TO INTEGRATE INTO AdminOddsMonitor.tsx
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. Import at the top of AdminOddsMonitor.tsx:
 *
 *    import SboTab from './SboTab';
 *
 *
 * 2. Add 'sbo' to the TABS array:
 *
 *    const TABS = [
 *      { key:'monitor', label:'⚙ MONITOR'  },
 *      { key:'probe',   label:'▶ PROBE'    },
 *      { key:'odds',    label:'📊 ODDS'    },
 *      { key:'sbo',     label:'⚡ SBO'     },   ← ADD THIS
 *      { key:'config',  label:'🔧 CONFIG'  },
 *    ] as const;
 *
 *    Update the tab type:
 *    const [tab, setTab] = useState<'monitor'|'probe'|'odds'|'sbo'|'config'>('monitor');
 *
 *
 * 3. Render the tab in the tab content section:
 *
 *    {tab === 'sbo' && (
 *      <SboTab onMatchClick={setDetailMatch} />
 *    )}
 *
 *
 * 4. Optional — highlight the SBO tab button with gold color:
 *
 *    color: tab === t.key
 *      ? (t.key === 'sbo' ? '#F5C842' : 'var(--acid)')
 *      : 'var(--text-muted)',
 *    borderBottomColor: tab === t.key
 *      ? (t.key === 'sbo' ? '#F5C842' : 'var(--acid)')
 *      : 'transparent',
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */