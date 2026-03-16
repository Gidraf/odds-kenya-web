'use client';
/* =============================================================================
   PlaywrightOnboardingPage.tsx  — polling edition (no websockets)
   
   • Polls GET /playwright/sessions/<id>/state every 2 s
   • Shows a table of all captured requests per phase — click to select
   • Confirms, skips, recaptures via REST
   • Partner config auto-saved from URL params on every capture
   • Vendor wizard on completion
============================================================================= */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookmakerOption { id: number; name: string; domain?: string }

interface Country {
  code: string; name: string; flag: string;
  currency: string; region: string; timezone: string;
}

interface Candidate {
  phase: string; url: string; method: string; status: number;
  score: number; body_size: number; body_preview: string;
  params: Record<string, string>;
  params_extracted: Record<string, string>;
  ts: number;
}

interface PhaseResult {
  confirmed: boolean; skipped: boolean;
  url_template: string; array_path: string;
  placeholder_map: Record<string, string>;
  sample_count: number;
}

interface LogEntry { level: string; msg: string; ts: number }

interface SessionState {
  session_id: string; domain: string; bookmaker_id: number;
  status: 'launching' | 'active' | 'complete' | 'error';
  current_phase: string; page_url: string; page_title: string;
  partner_config: Record<string, string>;
  vendor_slug: string | null; error: string;
  phase_done: Record<string, boolean>;
  capture_counts: Record<string, number>;
  phases: Record<string, PhaseResult>;
  logs: LogEntry[];
}

type UiPhase = 'country_select' | 'domain_input' | 'launching' | 'active' | 'complete' | 'error';

const PHASES = ['list', 'markets', 'live_list', 'live_markets'] as const;
type Phase = typeof PHASES[number];

const PHASE_META: Record<Phase, { label: string; icon: string; accent: string; desc: string }> = {
  list:         { label: 'Upcoming List',  icon: '📋', accent: '#c6f135', desc: 'All upcoming matches with odds' },
  markets:      { label: 'Match Markets',  icon: '📊', accent: '#38bdf8', desc: 'Full odds for a single match' },
  live_list:    { label: 'Live List',      icon: '🔴', accent: '#f472b6', desc: 'All currently live matches' },
  live_markets: { label: 'Live Markets',   icon: '⚡', accent: '#fb923c', desc: 'Live odds for a single match' },
};

const VENDOR_LABELS: Record<string, string> = {
  '1xbet-livefeed':      '1xBet / BetWinner / Melbet',
  'betway-generic':      'Betway',
  'sportingbet-generic': 'SportingBet',
};

// ─── Mono style helpers ───────────────────────────────────────────────────────

const M = "'IBM Plex Mono','Fira Code',monospace";

const s = {
  input:  { width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '7px 11px', fontFamily: M, fontSize: 11, outline: 'none', boxSizing: 'border-box' as const },
  mini:   { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '5px 8px', fontFamily: M, fontSize: 10, outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  lbl:    { fontFamily: M, fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 4, display: 'block' } as React.CSSProperties,
  acid:   (a = '#c6f135') => ({ background: a, color: '#0a0a0a', border: 'none', fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 2, padding: '8px 18px', cursor: 'pointer', whiteSpace: 'nowrap' as const }),
  ghost:  { background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: M, fontSize: 9, letterSpacing: 1, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  card:   { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  th:     { fontFamily: M, fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', padding: '6px 8px', textAlign: 'left' as const, borderBottom: '1px solid var(--border-dim)', whiteSpace: 'nowrap' as const },
  td:     { fontFamily: M, fontSize: 8, color: 'var(--text-primary)', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,.04)', verticalAlign: 'top' as const },
};

const pill = (color: string, bg?: string) => ({
  fontFamily: M, fontSize: 7, letterSpacing: 1,
  padding: '1px 6px', color,
  background: bg ?? `${color}12`,
  border: `1px solid ${color}44`,
  display: 'inline-block',
});

// ─── Poll hooks ───────────────────────────────────────────────────────────────

function usePollState(sessionId: string | null, intervalMs = 2000) {
  const [state, setState] = useState<SessionState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetchWithAuth(`/playwright/sessions/${sessionId}/state`).then((r: Response) => r.json());
      if (res.ok) { setState(res as SessionState); setPollError(null); }
      else setPollError(res.error || 'poll error');
    } catch (e: any) { setPollError(e.message); }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) { setState(null); return; }
    fetch_();
    const id = setInterval(fetch_, intervalMs);
    return () => clearInterval(id);
  }, [sessionId, fetch_, intervalMs]);

  return { state, pollError, refresh: fetch_ };
}

function usePollCandidates(sessionId: string | null, phase: Phase, intervalMs = 2000) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  useEffect(() => {
    if (!sessionId) return;
    const load = async () => {
      try {
        const res = await fetchWithAuth(
          `/playwright/sessions/${sessionId}/candidates?phase=${phase}`
        ).then((r: Response) => r.json());
        if (res.ok) setCandidates(res.candidates || []);
      } catch {}
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [sessionId, phase, intervalMs]);
  return candidates;
}

// ─── Country Modal ────────────────────────────────────────────────────────────

function CountryModal({ onSelect }: { onSelect: (c: Country) => void }) {
  const [countries, setCountries] = useState<Country[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    fetchWithAuth('/playwright/countries').then((r: Response) => r.json())
      .then((d: any) => d.ok && setCountries(d.countries)).catch(() => {});
  }, []);
  const regions = [...new Set(countries.map(c => c.region))];
  const filtered = countries.filter(c =>
    !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.code.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}>
      <div style={{ width: 520, maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)', border: '1px solid rgba(198,241,53,.3)', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--border-dim)' }}>
          <div style={{ fontFamily: M, fontSize: 10, letterSpacing: 3, color: '#c6f135', marginBottom: 6 }}>SELECT YOUR LOCATION</div>
        </div>
        <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--border-dim)' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search country…" autoFocus style={{ ...s.input, fontSize: 12 }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {regions.map(region => {
            const rc = filtered.filter(c => c.region === region);
            if (!rc.length) return null;
            return (
              <div key={region}>
                <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 3, color: 'var(--text-muted)', padding: '10px 24px 4px' }}>{region.toUpperCase()}</div>
                {rc.map(c => (
                  <div key={c.code} onClick={() => onSelect(c)}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 24px', cursor: 'pointer', borderLeft: '3px solid transparent', transition: 'all .1s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(198,241,53,.06)'; e.currentTarget.style.borderLeftColor = '#c6f135'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent'; }}
                  >
                    <span style={{ fontSize: 22 }}>{c.flag}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: M, fontSize: 11, color: 'var(--text-primary)' }}>{c.name}</div>
                      <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', marginTop: 2 }}>{c.currency} · {c.timezone}</div>
                    </div>
                    <span style={{ fontFamily: M, fontSize: 9, color: 'var(--text-muted)' }}>{c.code}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Phase Stepper ────────────────────────────────────────────────────────────

function PhaseStepper({ currentPhase, phaseDone, capCounts, onSelect }: {
  currentPhase: string; phaseDone: Record<string, boolean>;
  capCounts: Record<string, number>; onSelect: (p: Phase) => void;
}) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', overflowX: 'auto' }}>
      {PHASES.map((p, i) => {
        const meta  = PHASE_META[p];
        const done  = phaseDone[p];
        const active = currentPhase === p;
        const caps  = capCounts[p] || 0;
        const color = done ? meta.accent : active ? '#06b6d4' : 'var(--text-muted)';
        return (
          <div key={p} onClick={() => onSelect(p)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px',
            background: active ? 'var(--bg-surface)' : 'transparent',
            borderBottom: `2px solid ${active ? '#06b6d4' : done ? meta.accent : 'transparent'}`,
            flexShrink: 0, cursor: 'pointer', transition: 'all .15s',
          }}>
            <div style={{
              width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: done ? meta.accent : active ? 'rgba(6,182,212,.15)' : 'rgba(255,255,255,.06)',
              border: `1px solid ${color}`,
              fontFamily: M, fontSize: 8, fontWeight: 800, color: done ? '#0a0a0a' : color,
            }}>
              {done ? '✓' : i + 1}
            </div>
            <div>
              <div style={{ fontFamily: M, fontSize: 8, letterSpacing: 1, color }}>{meta.icon} {meta.label}</div>
              {caps > 0 && (
                <div style={{ fontFamily: M, fontSize: 7, color: done ? meta.accent : 'rgba(255,255,255,.3)', marginTop: 1 }}>
                  {caps} captured
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Request Table ────────────────────────────────────────────────────────────

function RequestTable({ candidates, chosenUrl, onChoose, accent }: {
  candidates: Candidate[]; chosenUrl: string;
  onChoose: (url: string) => void; accent: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!candidates.length) {
    return (
      <div style={{ padding: '48px 20px', textAlign: 'center', fontFamily: M, fontSize: 9, color: 'var(--text-muted)', lineHeight: 2.2 }}>
        <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.4 }}>📡</div>
        No requests captured yet.<br />
        Navigate in the Chromium browser window.<br />
        <span style={{ color: accent, fontSize: 8 }}>Requests appear here automatically every 2 s.</span>
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' as const }}>
        <colgroup>
          <col style={{ width: 28 }} />
          <col style={{ width: 46 }} />
          <col style={{ width: '40%' }} />
          <col style={{ width: 56 }} />
          <col style={{ width: 52 }} />
          <col style={{ width: 58 }} />
          <col />
          <col style={{ width: 72 }} />
          <col style={{ width: 78 }} />
        </colgroup>
        <thead>
          <tr style={{ background: 'rgba(0,0,0,.3)', position: 'sticky' as const, top: 0, zIndex: 2 }}>
            <th style={s.th}></th>
            <th style={{ ...s.th, textAlign: 'center' as const }}>SCR</th>
            <th style={s.th}>URL</th>
            <th style={s.th}>MTH</th>
            <th style={s.th}>STATUS</th>
            <th style={s.th}>SIZE</th>
            <th style={s.th}>AUTO-PARAMS</th>
            <th style={s.th}>TIME</th>
            <th style={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => {
            const chosen = c.url === chosenUrl;
            const isOpen = expanded === c.url;
            const qidx   = c.url.indexOf('?');
            const baseUrl = qidx >= 0 ? c.url.slice(0, qidx) : c.url;
            const autoParams = Object.entries(c.params_extracted).filter(([k]) => k !== 'base_url');
            return (
              <React.Fragment key={c.url}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : c.url)}
                  style={{
                    background: chosen ? `${accent}09` : isOpen ? 'rgba(255,255,255,.025)' : i % 2 ? 'rgba(255,255,255,.01)' : 'transparent',
                    cursor: 'pointer',
                    borderLeft: `3px solid ${chosen ? accent : 'transparent'}`,
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => { if (!chosen) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,.04)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = chosen ? `${accent}09` : isOpen ? 'rgba(255,255,255,.025)' : i % 2 ? 'rgba(255,255,255,.01)' : 'transparent'; }}
                >
                  <td style={{ ...s.td, textAlign: 'center', color: 'rgba(255,255,255,.2)', fontSize: 9 }}>
                    {isOpen ? '▾' : '▸'}
                  </td>
                  <td style={{ ...s.td, textAlign: 'center' }}>
                    <div style={{
                      width: 32, height: 32, margin: '0 auto',
                      background: `${accent}14`, border: `1px solid ${accent}33`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <span style={{ fontFamily: M, fontSize: 11, fontWeight: 800, color: accent, lineHeight: 1 }}>{Math.round(c.score)}</span>
                    </div>
                  </td>
                  <td style={{ ...s.td, overflow: 'hidden' }}>
                    <div style={{ fontFamily: M, fontSize: 8, color: chosen ? accent : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {baseUrl}
                    </div>
                    {qidx >= 0 && (
                      <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,.25)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        ?{c.url.slice(qidx + 1, qidx + 55)}{c.url.length > qidx + 55 ? '…' : ''}
                      </div>
                    )}
                  </td>
                  <td style={s.td}>
                    <span style={{ ...pill('rgba(255,255,255,.45)'), fontSize: 7 }}>{c.method}</span>
                  </td>
                  <td style={s.td}>
                    <span style={{ ...pill(c.status < 300 ? '#c6f135' : '#ff3d5a') }}>{c.status}</span>
                  </td>
                  <td style={{ ...s.td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {c.body_size >= 1024 ? `${(c.body_size / 1024).toFixed(1)}KB` : `${c.body_size}B`}
                  </td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {autoParams.slice(0, 3).map(([k, v]) => (
                        <span key={k} style={{ ...pill('#38bdf8') }}>{k}={v}</span>
                      ))}
                    </div>
                  </td>
                  <td style={{ ...s.td, color: 'rgba(255,255,255,.2)', whiteSpace: 'nowrap', fontSize: 7 }}>
                    {new Date(c.ts * 1000).toLocaleTimeString('en', { hour12: false })}
                  </td>
                  <td style={{ ...s.td, paddingRight: 10 }}>
                    <button
                      onClick={e => { e.stopPropagation(); onChoose(c.url); }}
                      style={{
                        background: chosen ? accent : 'rgba(255,255,255,.07)',
                        border: `1px solid ${chosen ? accent : 'var(--border-dim)'}`,
                        color: chosen ? '#0a0a0a' : 'var(--text-muted)',
                        fontFamily: M, fontSize: 7, letterSpacing: 1,
                        padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                    >
                      {chosen ? '✓ USE' : 'USE'}
                    </button>
                  </td>
                </tr>

                {isOpen && (
                  <tr style={{ background: 'rgba(0,0,0,.4)' }}>
                    <td colSpan={9} style={{ padding: '0 0 0 31px' }}>
                      <div style={{ borderLeft: `2px solid ${accent}44`, margin: '6px 12px 10px 0', padding: '8px 14px' }}>
                        <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 }}>BODY PREVIEW</div>
                        <pre style={{ margin: 0, fontFamily: M, fontSize: 8, color: 'rgba(167,243,208,.85)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6, maxHeight: 160, overflowY: 'auto' }}>
                          {c.body_preview.slice(0, 700)}
                        </pre>
                        {c.url.includes('?') && (
                          <div style={{ marginTop: 8, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                            {c.url.split('?')[1].split('&').map((p, pi) => {
                              const eq = p.indexOf('=');
                              const k = eq >= 0 ? p.slice(0, eq) : p;
                              const v = eq >= 0 ? p.slice(eq + 1) : '';
                              return (
                                <span key={pi} style={{ fontFamily: M, fontSize: 7, padding: '1px 6px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--border-dim)' }}>
                                  <span style={{ color: 'rgba(130,180,255,.8)' }}>{decodeURIComponent(k)}</span>
                                  {v && <span style={{ color: 'rgba(255,255,255,.3)' }}>={decodeURIComponent(v)}</span>}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Phase Panel ──────────────────────────────────────────────────────────────

function PhasePanel({ sessionId, phase, chosenUrl, phaseResult, onChoose, onConfirm, onSkip, onRecapture }: {
  sessionId: string; phase: Phase; chosenUrl: string;
  phaseResult: PhaseResult | undefined;
  onChoose: (url: string) => void;
  onConfirm: () => void; onSkip: () => void; onRecapture: () => void;
}) {
  const meta       = PHASE_META[phase];
  const candidates = usePollCandidates(sessionId, phase);
  const [view, setView] = useState<'table' | 'extraction'>('table');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Phase header */}
      <div style={{ padding: '10px 14px', background: `${meta.accent}08`, border: `1px solid ${meta.accent}22`, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{ fontSize: 20 }}>{meta.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: M, fontSize: 10, color: meta.accent, fontWeight: 700, letterSpacing: 1 }}>{meta.label}</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', marginTop: 2 }}>{meta.desc}</div>
        </div>
        {phaseResult?.confirmed && <span style={{ ...pill(meta.accent), fontSize: 8 }}>✓ CONFIRMED</span>}
        <span style={{ fontFamily: M, fontSize: 8, color: meta.accent, border: `1px solid ${meta.accent}44`, padding: '2px 8px' }}>
          {candidates.length} captured
        </span>
      </div>

      {/* Tab strip */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
        {(['table', 'extraction'] as const).map(t => (
          <button key={t} onClick={() => setView(t)} style={{
            fontFamily: M, fontSize: 7, letterSpacing: 2, padding: '6px 14px',
            background: 'none', border: 'none',
            borderBottom: `2px solid ${view === t ? meta.accent : 'transparent'}`,
            color: view === t ? meta.accent : 'var(--text-muted)', cursor: 'pointer', marginBottom: -1,
          }}>
            {t === 'table' ? `REQUESTS (${candidates.length})` : `EXTRACTION${phaseResult?.confirmed ? ' ✓' : ''}`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={onRecapture} style={{ ...s.ghost, fontSize: 7, padding: '4px 10px', margin: '3px 6px' }}>↺ CLEAR</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {view === 'table' && (
          <RequestTable candidates={candidates} chosenUrl={chosenUrl} onChoose={onChoose} accent={meta.accent} />
        )}
        {view === 'extraction' && (
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!phaseResult?.confirmed ? (
              <div style={{ padding: '24px', textAlign: 'center', fontFamily: M, fontSize: 9, color: 'var(--text-muted)' }}>
                Select a request above and click CONFIRM to run extraction.
              </div>
            ) : (
              <>
                <div>
                  <label style={s.lbl}>URL TEMPLATE</label>
                  <div style={{ fontFamily: M, fontSize: 9, color: '#c6f135', background: 'var(--bg-base)', padding: '8px 10px', border: '1px solid rgba(198,241,53,.3)', wordBreak: 'break-all', lineHeight: 1.7 }}>
                    {phaseResult.url_template}
                  </div>
                </div>
                {Object.keys(phaseResult.placeholder_map).length > 0 && (
                  <div>
                    <label style={s.lbl}>PLACEHOLDER MAPPINGS</label>
                    {Object.entries(phaseResult.placeholder_map).map(([v, path]) => (
                      <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', background: 'rgba(198,241,53,.04)', border: '1px solid rgba(198,241,53,.2)', marginBottom: 3 }}>
                        <span style={{ fontFamily: M, fontSize: 9, color: '#c6f135', width: 140, flexShrink: 0 }}>{`{{${v}}}`}</span>
                        <span style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)' }}>←</span>
                        <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(167,243,208,.8)' }}>{path}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <label style={s.lbl}>ARRAY PATH</label>
                  <div style={{ fontFamily: M, fontSize: 9, color: '#38bdf8', padding: '4px 8px', background: 'rgba(56,189,248,.06)', border: '1px solid rgba(56,189,248,.2)' }}>
                    {phaseResult.array_path || '(root array)'}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', justifyContent: 'space-between', flexShrink: 0 }}>
        <button onClick={onSkip} style={{ ...s.ghost, fontSize: 8 }}>SKIP →</button>
        <button onClick={onConfirm} disabled={!chosenUrl}
          style={{ ...s.acid(meta.accent), fontSize: 9, opacity: chosenUrl ? 1 : 0.35 }}>
          ✓ CONFIRM &amp; NEXT →
        </button>
      </div>
    </div>
  );
}

// ─── Partner Config ───────────────────────────────────────────────────────────

function PartnerConfigPanel({ sessionId, partnerConfig }: { sessionId: string; partnerConfig: Record<string, string> }) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRows(Object.entries(partnerConfig).map(([key, value]) => ({ key, value })));
  }, [JSON.stringify(partnerConfig)]);

  const save = async () => {
    const config: Record<string, string> = {};
    rows.forEach(r => { if (r.key.trim()) config[r.key.trim()] = r.value; });
    await fetchWithAuth(`/playwright/sessions/${sessionId}/partner`, {
      method: 'POST', body: JSON.stringify({ config }),
    });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        Auto-extracted from captured request URLs. Edit or add manually.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <input value={row.key} onChange={e => setRows(p => p.map((r, j) => j === i ? { ...r, key: e.target.value } : r))} placeholder="key" style={{ ...s.mini, flex: '0 0 38%', color: '#38bdf8' }} />
            <input value={row.value} onChange={e => setRows(p => p.map((r, j) => j === i ? { ...r, value: e.target.value } : r))} placeholder="value" style={{ ...s.mini, flex: 1 }} />
            <button onClick={() => setRows(p => p.filter((_, j) => j !== i))} style={{ background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: M, fontSize: 9, padding: '4px 7px', cursor: 'pointer' }}>✕</button>
          </div>
        ))}
        <button onClick={() => setRows(p => [...p, { key: '', value: '' }])} style={{ background: 'none', border: '1px dashed var(--border-dim)', color: 'var(--text-muted)', fontFamily: M, fontSize: 7, letterSpacing: 2, padding: '3px 10px', cursor: 'pointer', alignSelf: 'flex-start' }}>⊕ ADD ROW</button>
      </div>
      <button onClick={save} style={{ ...s.acid(saved ? 'rgba(198,241,53,.4)' : '#c6f135') }}>{saved ? '✓ SAVED' : 'SAVE CONFIG'}</button>
    </div>
  );
}

// ─── Log Feed ─────────────────────────────────────────────────────────────────

function LogFeed({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs.length]);
  const levelColor: Record<string, string> = {
    INFO:'rgba(255,255,255,.5)', WARN:'rgba(251,146,60,.8)', ERROR:'rgba(255,61,90,.9)',
    DEBUG:'rgba(255,255,255,.2)', SUCCESS:'rgba(198,241,53,.85)', CAPTURE:'rgba(56,189,248,.8)',
  };
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', fontFamily: M, fontSize: 8, background: 'rgba(0,0,0,.3)' }}>
      {logs.slice(-100).map((l, i) => (
        <div key={i} style={{ padding: '2px 10px', borderBottom: '1px solid rgba(255,255,255,.025)', color: levelColor[l.level] || levelColor.INFO, lineHeight: 1.6 }}>
          <span style={{ color: 'rgba(255,255,255,.18)', marginRight: 8 }}>{new Date(l.ts * 1000).toLocaleTimeString('en', { hour12: false })}</span>
          {l.level === 'CAPTURE' && <span style={{ color: '#38bdf8', marginRight: 4 }}>▶</span>}
          {l.msg}
        </div>
      ))}
      {!logs.length && <div style={{ padding: '20px', textAlign: 'center', color: 'rgba(255,255,255,.2)' }}>Logs will appear here…</div>}
    </div>
  );
}

// ─── Vendor Wizard ────────────────────────────────────────────────────────────

function VendorWizardPanel({ vendorSlug, domain, bookmarkerId, partnerConfig, onComplete }: {
  vendorSlug: string | null; domain: string; bookmarkerId: number;
  partnerConfig: Record<string, string>; onComplete: (msg: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [linked, setLinked] = useState(false);
  const doLink = async () => {
    if (!vendorSlug) return; setCreating(true);
    try {
      const vList = await fetchWithAuth('/vendors').then((r: Response) => r.json());
      let vendor = (vList.vendors || []).find((v: any) => v.slug === vendorSlug);
      if (!vendor) {
        const imp = await fetchWithAuth('/vendors/presets/import', { method: 'POST', body: JSON.stringify({ slug: vendorSlug }) }).then((r: Response) => r.json());
        vendor = imp.vendor;
      }
      if (!vendor) { onComplete('✗ Could not find or import vendor'); return; }
      const params: Record<string, string> = {};
      Object.entries(partnerConfig).forEach(([k, v]) => { if (k !== 'base_url') params[k] = v; });
      await fetchWithAuth(`/vendors/${vendor.id}/bookmakers`, { method: 'POST', body: JSON.stringify({ bookmaker_id: bookmarkerId, base_url: `https://${domain}`, params }) });
      setLinked(true); onComplete(`✓ Linked to "${VENDOR_LABELS[vendorSlug] || vendorSlug}"`);
    } catch (e: any) { onComplete(`✗ ${e.message}`); }
    setCreating(false);
  };
  if (!vendorSlug) return (
    <div style={{ padding: '24px', fontFamily: M, fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.8 }}>
      No vendor format detected. Create a VendorTemplate manually from the Vendors page.
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ padding: '10px 14px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.3)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c6f135', flexShrink: 0 }} />
        <div>
          <div style={{ fontFamily: M, fontSize: 10, color: '#c6f135', fontWeight: 700 }}>{VENDOR_LABELS[vendorSlug] || vendorSlug}</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', marginTop: 1 }}>Vendor format detected</div>
        </div>
      </div>
      <div>
        <label style={s.lbl}>PARAMS TO LINK</label>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {Object.entries(partnerConfig).filter(([k]) => k !== 'base_url').map(([k, v]) => (
            <span key={k} style={{ ...pill('#38bdf8'), fontSize: 8 }}>{k}={v}</span>
          ))}
        </div>
      </div>
      <button onClick={doLink} disabled={creating || linked} style={{ ...s.acid(linked ? 'rgba(198,241,53,.3)' : '#c6f135'), width: '100%', opacity: linked ? 0.6 : 1 }}>
        {creating ? '⟳ LINKING…' : linked ? '✓ LINKED' : `LINK TO ${(VENDOR_LABELS[vendorSlug] || vendorSlug).toUpperCase()} →`}
      </button>
    </div>
  );
}

// ─── Complete Summary ─────────────────────────────────────────────────────────

function CompleteSummary({ state, domain, bookmarkerId, onReset }: {
  state: SessionState; domain: string; bookmarkerId: number; onReset: () => void;
}) {
  const [tab, setTab] = useState<'phases' | 'vendor'>('phases');
  const [toast, setToast] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: '16px 18px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.35)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(198,241,53,.15)', border: '1px solid rgba(198,241,53,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#c6f135' }}>✓</div>
        <div>
          <div style={{ fontFamily: M, fontSize: 12, color: '#c6f135', letterSpacing: 2, fontWeight: 700 }}>CAPTURE SESSION COMPLETE</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', marginTop: 3 }}>
            {PHASES.filter(p => state.phases[p]?.confirmed).length}/{PHASES.length} phases · {domain}
            {state.vendor_slug && <span style={{ color: '#c6f135', marginLeft: 8 }}>· {VENDOR_LABELS[state.vendor_slug] || state.vendor_slug}</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)' }}>
        {(['phases', 'vendor'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            fontFamily: M, fontSize: 8, letterSpacing: 2, padding: '7px 16px', background: 'none', border: 'none',
            borderBottom: `2px solid ${tab === t ? '#c6f135' : 'transparent'}`,
            color: tab === t ? '#c6f135' : 'var(--text-muted)', cursor: 'pointer', marginBottom: -1,
          }}>
            {t === 'phases' ? 'CAPTURED PHASES' : 'VENDOR WIZARD'}
          </button>
        ))}
      </div>
      {tab === 'phases' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {PHASES.map(p => {
            const meta = PHASE_META[p]; const result = state.phases[p]; const ok = result?.confirmed;
            return (
              <div key={p} style={{ padding: '12px 14px', background: ok ? `${meta.accent}06` : 'rgba(255,255,255,.02)', border: `1px solid ${ok ? meta.accent + '33' : 'var(--border-dim)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 16 }}>{meta.icon}</span>
                  <span style={{ fontFamily: M, fontSize: 9, color: ok ? meta.accent : 'var(--text-muted)', fontWeight: ok ? 700 : 400 }}>
                    {ok ? '✓' : result?.skipped ? '—' : '○'} {meta.label}
                  </span>
                </div>
                {ok && result?.url_template && (
                  <div style={{ fontFamily: M, fontSize: 7, color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: 1.6 }}>
                    {result.url_template.slice(0, 90)}{result.url_template.length > 90 ? '…' : ''}
                  </div>
                )}
                {ok && Object.keys(result?.placeholder_map ?? {}).length > 0 && (
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}>
                    {Object.keys(result.placeholder_map).map(v => <span key={v} style={{ ...pill(meta.accent), fontSize: 7 }}>{`{{${v}}}`}</span>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {tab === 'vendor' && (
        <VendorWizardPanel vendorSlug={state.vendor_slug} domain={domain} bookmarkerId={bookmarkerId}
          partnerConfig={state.partner_config} onComplete={msg => setToast(msg)} />
      )}
      {toast && (
        <div style={{ padding: '8px 12px', fontFamily: M, fontSize: 9, color: toast.startsWith('✓') ? '#c6f135' : '#ff3d5a', border: `1px solid ${toast.startsWith('✓') ? 'rgba(198,241,53,.3)' : 'rgba(255,61,90,.3)'}` }}>
          {toast}
        </div>
      )}
      <button onClick={onReset} style={{ ...s.ghost, alignSelf: 'flex-start' }}>↺ START NEW SESSION</button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

import React from 'react';

export default function PlaywrightOnboardingPage({ bookmakers }: { bookmakers: BookmakerOption[] }) {
  const [uiPhase,     setUiPhase]     = useState<UiPhase>('country_select');
  const [country,     setCountry]     = useState<Country | null>(null);
  const [domain,      setDomain]      = useState('');
  const [selectedBk,  setSelectedBk]  = useState<number | null>(null);
  const [sessionId,   setSessionId]   = useState<string | null>(null);
  const [activePhase, setActivePhase] = useState<Phase>('list');
  const [chosenUrls,  setChosenUrls]  = useState<Record<Phase, string>>({ list: '', markets: '', live_list: '', live_markets: '' });
  const [launchError, setLaunchError] = useState('');
  const [activeTab,   setActiveTab]   = useState<'phase' | 'partner' | 'log'>('phase');

  const { state, pollError, refresh } = usePollState(sessionId);

  // Sync server state → local UI
  useEffect(() => {
    if (!state) return;
    if (state.status === 'active'   && uiPhase !== 'active')   setUiPhase('active');
    if (state.status === 'complete' && uiPhase !== 'complete') setUiPhase('complete');
    if (state.status === 'error'    && uiPhase !== 'error') {
      setLaunchError(state.error || 'Unknown error'); setUiPhase('error');
    }
    if (state.current_phase && state.current_phase !== activePhase) {
      setActivePhase(state.current_phase as Phase);
    }
  }, [state?.status, state?.current_phase]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const startSession = async () => {
    if (!domain || !selectedBk) return;
    setUiPhase('launching'); setLaunchError('');
    try {
      const res = await fetchWithAuth('/playwright/sessions', {
        method: 'POST',
        body: JSON.stringify({ domain, bookmaker_id: selectedBk, country_code: country?.code || 'KE' }),
      }).then((r: Response) => r.json());
      if (res.ok) setSessionId(res.session_id);
      else { setLaunchError(res.error || 'Failed'); setUiPhase('error'); }
    } catch (e: any) { setLaunchError(e.message); setUiPhase('error'); }
  };

  const confirmPhase = async () => {
    if (!sessionId) return;
    await fetchWithAuth(`/playwright/sessions/${sessionId}/confirm`, {
      method: 'POST', body: JSON.stringify({ phase: activePhase, chosen_url: chosenUrls[activePhase] || undefined }),
    });
    await refresh();
  };

  const skipPhase = async () => {
    if (!sessionId) return;
    await fetchWithAuth(`/playwright/sessions/${sessionId}/skip`, { method: 'POST', body: JSON.stringify({ phase: activePhase }) });
    await refresh();
    const i = PHASES.indexOf(activePhase);
    if (i < PHASES.length - 1) setActivePhase(PHASES[i + 1]);
  };

  const recapturePhase = async () => {
    if (!sessionId) return;
    await fetchWithAuth(`/playwright/sessions/${sessionId}/recapture`, { method: 'POST', body: JSON.stringify({ phase: activePhase }) });
    setChosenUrls(prev => ({ ...prev, [activePhase]: '' }));
    await refresh();
  };

  const stopSession = async () => {
    if (sessionId) await fetchWithAuth(`/playwright/sessions/${sessionId}`, { method: 'DELETE' });
    setSessionId(null); setUiPhase('domain_input');
  };

  const reset = () => {
    setSessionId(null); setUiPhase('domain_input'); setDomain(''); setSelectedBk(null);
    setActivePhase('list'); setChosenUrls({ list: '', markets: '', live_list: '', live_markets: '' });
    setLaunchError('');
  };

  const totalCaptured = state ? Object.values(state.capture_counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', color: 'var(--text-primary)', fontFamily: M }}>
      {uiPhase === 'country_select' && (
        <CountryModal onSelect={c => { setCountry(c); setUiPhase('domain_input'); }} />
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: M, fontSize: 18, fontWeight: 800, letterSpacing: 3, margin: 0, color: '#c6f135' }}>PLAYWRIGHT ONBOARDING</h1>
          <p style={{ fontFamily: M, fontSize: 8, letterSpacing: 3, color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>NAVIGATE · CAPTURE · EXTRACT · VERIFY · SAVE</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: sessionId ? (pollError ? '#ff3d5a' : '#c6f135') : '#444', boxShadow: sessionId && !pollError ? '0 0 5px #c6f13566' : 'none' }} />
            <span style={{ fontFamily: M, fontSize: 7, letterSpacing: 1, color: 'var(--text-muted)' }}>
              {sessionId ? (pollError ? 'POLL ERR' : 'POLLING 2s') : 'IDLE'}
            </span>
          </div>
          {country && (
            <button onClick={() => setUiPhase('country_select')} style={{ ...s.ghost, fontSize: 13 }}>
              {country.flag} {country.name}
            </button>
          )}
          {sessionId && (
            <button onClick={stopSession} style={{ ...s.ghost, borderColor: 'rgba(255,61,90,.3)', color: 'rgba(255,61,90,.8)', fontSize: 8 }}>■ STOP</button>
          )}
        </div>
      </div>

      {/* Launch form */}
      {(uiPhase === 'domain_input' || uiPhase === 'error') && (
        <div style={{ ...s.card, marginBottom: 16 }}>
          <div style={{ fontFamily: M, fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' }}>LAUNCH BROWSER SESSION</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
            <div>
              <label style={s.lbl}>BOOKMAKER</label>
              <select value={selectedBk ?? ''} onChange={e => {
                const bk = bookmakers.find(b => b.id === Number(e.target.value));
                setSelectedBk(Number(e.target.value));
                if (bk?.domain) setDomain(bk.domain);
              }} style={s.input}>
                <option value="">— select bookmaker —</option>
                {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name}{b.domain ? ` (${b.domain})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label style={s.lbl}>DOMAIN</label>
              <input value={domain} onChange={e => setDomain(e.target.value.replace(/^https?:\/\//, '').replace(/\/$/, ''))} placeholder="1xbet.co.ke" style={s.input} />
            </div>
            <button onClick={startSession} disabled={!domain || !selectedBk}
              style={{ ...s.acid(), opacity: domain && selectedBk ? 1 : 0.4, alignSelf: 'flex-end' }}>LAUNCH →</button>
          </div>
          {uiPhase === 'error' && launchError && (
            <div style={{ padding: '8px 12px', background: 'rgba(255,61,90,.04)', border: '1px solid rgba(255,61,90,.3)', fontFamily: M, fontSize: 9, color: '#ff3d5a' }}>✗ {launchError}</div>
          )}
        </div>
      )}

      {/* Launching */}
      {uiPhase === 'launching' && (
        <div style={{ padding: '60px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <div style={{ fontSize: 28, color: '#06b6d4', animation: 'spin 1s linear infinite' }}>⟳</div>
          <div style={{ fontFamily: M, fontSize: 10, color: '#06b6d4', letterSpacing: 3 }}>LAUNCHING CHROMIUM…</div>
          <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)' }}>A browser window will open. State polls every 2 s.</div>
        </div>
      )}

      {/* Complete */}
      {uiPhase === 'complete' && state && (
        <CompleteSummary state={state} domain={domain} bookmarkerId={selectedBk!} onReset={reset} />
      )}

      {/* Active */}
      {uiPhase === 'active' && state && (
        <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', minHeight: 720 }}>
          <PhaseStepper currentPhase={state.current_phase} phaseDone={state.phase_done}
            capCounts={state.capture_counts} onSelect={p => setActivePhase(p)} />

          {/* URL bar */}
          <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elevated)', flexShrink: 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#c6f135', animation: 'pulse 2s infinite', flexShrink: 0 }} />
            <div style={{ flex: 1, fontFamily: M, fontSize: 8, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {state.page_url || `https://${domain}`}
            </div>
            {state.page_title && (
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,.3)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {state.page_title}
              </div>
            )}
            <div style={{ fontFamily: M, fontSize: 7, color: 'rgba(255,255,255,.25)', flexShrink: 0 }}>{totalCaptured} req</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', flex: 1, minHeight: 0 }}>
            {/* Main */}
            <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-dim)', minHeight: 0 }}>
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
                {(['phase', 'partner', 'log'] as const).map(t => (
                  <button key={t} onClick={() => setActiveTab(t)} style={{
                    fontFamily: M, fontSize: 7, letterSpacing: 2, padding: '5px 14px',
                    background: 'none', border: 'none',
                    borderBottom: `2px solid ${activeTab === t ? '#c6f135' : 'transparent'}`,
                    color: activeTab === t ? '#c6f135' : 'var(--text-muted)', cursor: 'pointer', marginBottom: -1,
                  }}>
                    {t === 'phase' ? `${PHASE_META[activePhase].icon} ${PHASE_META[activePhase].label.toUpperCase()}` : t === 'partner' ? 'PARTNER CONFIG' : `LOG (${state.logs.length})`}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: activeTab === 'log' ? 'hidden' : 'auto' }}>
                {activeTab === 'phase' && (
                  <PhasePanel sessionId={sessionId!} phase={activePhase} chosenUrl={chosenUrls[activePhase]}
                    phaseResult={state.phases[activePhase]}
                    onChoose={url => setChosenUrls(prev => ({ ...prev, [activePhase]: url }))}
                    onConfirm={confirmPhase} onSkip={skipPhase} onRecapture={recapturePhase} />
                )}
                {activeTab === 'partner' && <PartnerConfigPanel sessionId={sessionId!} partnerConfig={state.partner_config} />}
                {activeTab === 'log' && (
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 400 }}>
                    <LogFeed logs={state.logs} />
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', overflowY: 'auto' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-dim)', fontFamily: M, fontSize: 7, letterSpacing: 3, color: 'var(--text-muted)' }}>ALL PHASES</div>
              {PHASES.map(p => {
                const meta = PHASE_META[p]; const result = state.phases[p];
                const active = activePhase === p; const caps = state.capture_counts[p] || 0;
                return (
                  <div key={p} onClick={() => { setActivePhase(p); setActiveTab('phase'); }}
                    style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-dim)', cursor: 'pointer', background: active ? `${meta.accent}08` : 'transparent', borderLeft: `3px solid ${result?.confirmed ? meta.accent : active ? '#06b6d4' : 'transparent'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13 }}>{meta.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: M, fontSize: 9, color: result?.confirmed ? meta.accent : active ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: active ? 700 : 400 }}>
                          {result?.confirmed ? '✓ ' : result?.skipped ? '— ' : ''}{meta.label}
                        </div>
                        <div style={{ fontFamily: M, fontSize: 7, color: 'var(--text-muted)', marginTop: 2 }}>
                          {caps} captured{result?.confirmed ? ` · ${result.sample_count} items` : ''}
                        </div>
                      </div>
                    </div>
                    {result?.confirmed && Object.keys(result.placeholder_map || {}).length > 0 && (
                      <div style={{ display: 'flex', gap: 3, marginTop: 5, flexWrap: 'wrap' }}>
                        {Object.keys(result.placeholder_map).map(v => <span key={v} style={{ ...pill(meta.accent), fontSize: 6 }}>{`{{${v}}}`}</span>)}
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border-dim)', marginTop: 'auto' }}>
                <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 5 }}>VENDOR</div>
                {state.vendor_slug ? (
                  <div style={{ fontFamily: M, fontSize: 9, color: '#c6f135' }}>{VENDOR_LABELS[state.vendor_slug] || state.vendor_slug}</div>
                ) : (
                  <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,.2)' }}>detecting…</div>
                )}
              </div>
              {Object.keys(state.partner_config).length > 0 && (
                <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-dim)' }}>
                  <div style={{ fontFamily: M, fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 5 }}>PARTNER CONFIG</div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {Object.entries(state.partner_config).slice(0, 8).map(([k, v]) => <span key={k} style={{ ...pill('#38bdf8'), fontSize: 7 }}>{k}={v}</span>)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom nav */}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderTop: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
            <div style={{ fontFamily: M, fontSize: 8, color: 'var(--text-muted)', alignSelf: 'center' }}>
              {totalCaptured} requests · polling 2 s
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { const i = PHASES.indexOf(activePhase); if (i > 0) setActivePhase(PHASES[i - 1]); }}
                disabled={activePhase === PHASES[0]} style={{ ...s.ghost, opacity: activePhase === PHASES[0] ? 0.3 : 1 }}>← PREV</button>
              <button onClick={() => { const i = PHASES.indexOf(activePhase); if (i < PHASES.length - 1) setActivePhase(PHASES[i + 1]); }}
                disabled={activePhase === PHASES[PHASES.length - 1]} style={{ ...s.acid(), opacity: activePhase === PHASES[PHASES.length - 1] ? 0.3 : 1 }}>NEXT →</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin  { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .4 } }
        * { box-sizing: border-box; }
        input:focus, select:focus { border-color: rgba(198,241,53,.4) !important; outline: none; }
        select option { background: var(--bg-elevated,#0c150c); color: var(--text-primary,#eee); }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 2px; }
      `}</style>
    </div>
  );
}