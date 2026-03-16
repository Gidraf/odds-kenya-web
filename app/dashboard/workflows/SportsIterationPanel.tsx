/* ============================================================================
   WorkflowParserPane — UPDATED
   ============================================================================
   Replace the entire existing WorkflowParserPane function in WorkflowExplorer.tsx
   with this one.  Everything else in WorkflowExplorer.tsx stays exactly the same.

   New features:
   ─────────────
   ⚡ GENERATE button  — calls POST /research/workflows/<wid>/parser/generate
                         Creates parse_data() from onboarding field maps.

   ⟳ ITERATE SPORTS   — calls POST /research/workflows/<wid>/parser/iterate-sports
                         Runs the parser against the live API for each configured
                         sport.  Shows per-sport coverage table.

   SportIterationPanel — shows each sport as a row with:
     • Status pill (ok / warn / error)
     • Live item count
     • Row count from parser
     • Market coverage % bar
     • Top 5 missing markets
     • Expandable: full present/missing/extra market lists + sample rows
   ============================================================================ */

// ─── New interfaces (add near the top of WorkflowExplorer.tsx) ───────────────

import React, { useEffect, useState } from "react";
import { CodeEditor } from "../onboard/CodeEditor";
import { MarketCoveragePanel } from "../onboard/MarketCoveragePanel";
import { ParserResultsTable } from "../onboard/ParserResultsTable";
import { DEFAULT_PARSER_CODE, ParserTestStatus, ParserTestResult } from "../onboard/parserTypes";
import { SplitPane } from "../onboard/SplitPane";



interface SportIterResult {
  bk_sport_id:     string;
  sport_name:      string;
  status:          'ok' | 'warn' | 'error';
  item_count:      number;
  row_count:       number;
  coverage_pct:    number;
  present_markets: string[];
  missing_markets: { name: string; slug: string; is_primary: boolean }[];
  extra_markets:   string[];
  expected_count:  number;
  present_count:   number;
  error:           string | null;
  match_samples:   Record<string, unknown>[];
}

interface IterationSummary {
  sports_tested:  number;
  sports_passed:  number;
  total_rows:     number;
  avg_coverage:   number;
}

// ─── SportIterationPanel ──────────────────────────────────────────────────────

function SportIterationPanel({
  results,
  summary,
}: {
  results:  SportIterResult[];
  summary:  IterationSummary;
}) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = React.useState<Record<string, 'missing'|'present'|'extra'|'rows'>>({});

  const toggle = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }));
  const getTab = (id: string): 'missing'|'present'|'extra'|'rows' => activeTab[id] ?? 'missing';
  const setTab = (id: string, t: 'missing'|'present'|'extra'|'rows') =>
    setActiveTab(p => ({ ...p, [id]: t }));

  const statusMeta = (r: SportIterResult) => ({
    ok:    { color: '#c6f135', icon: '✓', bg: 'rgba(198,241,53,.06)',  border: 'rgba(198,241,53,.2)'  },
    warn:  { color: '#fb923c', icon: '⚠', bg: 'rgba(251,146,60,.06)',  border: 'rgba(251,146,60,.2)'  },
    error: { color: '#f87171', icon: '✗', bg: 'rgba(248,113,113,.06)', border: 'rgba(248,113,113,.2)' },
  }[r.status]);

  if (results.length === 0) return null;

  return (
    <div style={{ flexShrink: 0, borderTop: '2px solid rgba(198,241,53,.15)', background: 'rgba(0,0,0,.2)' }}>
      {/* Summary header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: '#c6f135' }}>
          ⟳ SPORT ITERATION RESULTS
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
          color: summary.sports_passed === summary.sports_tested ? '#c6f135' : '#fb923c' }}>
          {summary.sports_passed}/{summary.sports_tested} sports passed
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.6)',
          border: '1px solid rgba(255,255,255,.08)', padding: '1px 7px' }}>
          {summary.total_rows} total rows
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.6)',
          border: '1px solid rgba(255,255,255,.08)', padding: '1px 7px' }}>
          avg {summary.avg_coverage}% coverage
        </span>
      </div>

      {/* Per-sport rows */}
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {results.map(r => {
          const id   = r.bk_sport_id;
          const meta = statusMeta(r);
          const exp  = !!expanded[id];
          const tab  = getTab(id);
          const pct  = Math.min(100, Math.round(r.coverage_pct));

          return (
            <div key={id} style={{ borderBottom: '1px solid rgba(255,255,255,.04)' }}>
              {/* Row header */}
              <div
                onClick={() => toggle(id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                  cursor: 'pointer', background: exp ? meta.bg : 'transparent',
                  border: exp ? `1px solid ${meta.border}` : '1px solid transparent',
                  transition: 'background .1s' }}
              >
                {/* Status icon */}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: meta.color, flexShrink: 0 }}>
                  {meta.icon}
                </span>

                {/* Sport name + bk id */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#e2e8f0', letterSpacing: .5 }}>
                    {r.sport_name}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(100,116,139,.5)', marginTop: 1 }}>
                    bk id: {r.bk_sport_id}
                  </div>
                </div>

                {/* Stats */}
                {r.status !== 'error' ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.6)' }}>
                        {r.item_count} matches · {r.row_count} rows
                      </span>
                      {/* Coverage bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 80, height: 4, background: 'rgba(255,255,255,.07)', position: 'relative', overflow: 'hidden' }}>
                          <div style={{ position: 'absolute', left: 0, top: 0, height: '100%',
                            width: `${pct}%`, background: meta.color, transition: 'width .3s ease' }} />
                        </div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: meta.color }}>
                          {r.coverage_pct.toFixed(1)}%
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(100,116,139,.45)' }}>
                          {r.present_count}/{r.expected_count}
                        </span>
                      </div>
                    </div>
                    {/* Top 3 missing */}
                    {r.missing_markets.slice(0, 3).length > 0 && (
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const, maxWidth: 180, flexShrink: 0 }}>
                        {r.missing_markets.slice(0, 3).map(m => (
                          <span key={m.slug} style={{ fontFamily: 'var(--font-mono)', fontSize: 6,
                            padding: '1px 5px', letterSpacing: .5,
                            background: m.is_primary ? 'rgba(248,113,113,.1)' : 'rgba(100,116,139,.1)',
                            border: `1px solid ${m.is_primary ? 'rgba(248,113,113,.25)' : 'rgba(255,255,255,.08)'}`,
                            color: m.is_primary ? '#f87171' : 'rgba(100,116,139,.7)' }}>
                            {m.slug}
                          </span>
                        ))}
                        {r.missing_markets.length > 3 && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 6,
                            color: 'rgba(100,116,139,.4)', alignSelf: 'center' }}>
                            +{r.missing_markets.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: '#f87171', flex: 1, textAlign: 'right' as const }}>
                    {r.error}
                  </span>
                )}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(100,116,139,.3)', flexShrink: 0 }}>
                  {exp ? '▲' : '▼'}
                </span>
              </div>

              {/* Expanded detail */}
              {exp && (
                <div style={{ background: 'rgba(0,0,0,.2)', borderBottom: `1px solid ${meta.border}` }}>
                  {/* Tab strip */}
                  <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,.05)', padding: '0 14px' }}>
                    {([
                      ['missing', `MISSING (${r.missing_markets.length})`],
                      ['present', `PRESENT (${r.present_markets.length})`],
                      ['extra',   `EXTRA (${r.extra_markets.length})`],
                      ['rows',    `SAMPLE ROWS (${r.match_samples.length})`],
                    ] as ['missing'|'present'|'extra'|'rows', string][]).map(([t, lbl]) => (
                      <button key={t} onClick={() => setTab(id, t)} style={{
                        background: 'none', border: 'none',
                        borderBottom: `2px solid ${tab === t ? meta.color : 'transparent'}`,
                        marginBottom: -1,
                        fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5,
                        padding: '5px 10px', cursor: 'pointer',
                        color: tab === t ? meta.color : 'rgba(100,116,139,.45)',
                      }}>{lbl}</button>
                    ))}
                  </div>

                  {/* Market tag clouds */}
                  <div style={{ padding: '8px 14px', display: 'flex', flexWrap: 'wrap' as const, gap: 3, maxHeight: 140, overflowY: 'auto' }}>
                    {tab === 'missing' && r.missing_markets.map(m => (
                      <span key={m.slug} style={{
                        fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 7px',
                        background: m.is_primary ? 'rgba(248,113,113,.08)' : 'rgba(100,116,139,.06)',
                        border: `1px solid ${m.is_primary ? 'rgba(248,113,113,.25)' : 'rgba(255,255,255,.08)'}`,
                        color: m.is_primary ? '#f87171' : 'rgba(100,116,139,.6)',
                      }}>
                        {m.is_primary && <span style={{ marginRight: 3 }}>⚠</span>}
                        {m.name}
                      </span>
                    ))}
                    {tab === 'present' && r.present_markets.map(m => (
                      <span key={m} style={{
                        fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 7px',
                        background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.18)',
                        color: '#c6f135',
                      }}>{m}</span>
                    ))}
                    {tab === 'extra' && r.extra_markets.length > 0 && r.extra_markets.map(m => (
                      <span key={m} style={{
                        fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 7px',
                        background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.2)',
                        color: '#fb923c',
                      }}>{m}</span>
                    ))}
                    {tab === 'extra' && r.extra_markets.length === 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.35)' }}>
                        No extra markets — all parser output matches the catalogue
                      </span>
                    )}
                    {tab === 'rows' && r.match_samples.length > 0 && (
                      <div style={{ width: '100%', overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                          <thead>
                            <tr>
                              {Object.keys(r.match_samples[0]).map(k => (
                                <th key={k} style={{
                                  fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
                                  padding: '4px 8px', textAlign: 'left' as const,
                                  borderBottom: '1px solid rgba(255,255,255,.07)',
                                  color: 'rgba(100,116,139,.6)', whiteSpace: 'nowrap' as const,
                                }}>{k}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {r.match_samples.map((row, ri) => (
                              <tr key={ri} style={{ borderBottom: '1px solid rgba(255,255,255,.03)' }}>
                                {Object.values(row).map((v, vi) => (
                                  <td key={vi} style={{
                                    fontFamily: '"Fira Code", monospace', fontSize: 8,
                                    padding: '3px 8px', color: '#94a3b8',
                                    maxWidth: 160, overflow: 'hidden',
                                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                                  }}>{String(v ?? '—')}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {tab === 'rows' && r.match_samples.length === 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.35)' }}>
                        No rows — parser returned nothing for this sport
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── WorkflowParserPane (FULL REPLACEMENT) ────────────────────────────────────

function WorkflowParserPane({ workflow, probeData, sampleOverride, onSampleOverrideConsumed }: {
  workflow: Workflow;
  probeData?: Record<number, unknown>;
  sampleOverride?: unknown | null;
  onSampleOverrideConsumed?: () => void;
}) {
  const [code,            setCode]            = useState(DEFAULT_PARSER_CODE);
  const [sampleJson,      setSampleJson]      = useState('{}');
  const [testStatus,      setTestStatus]      = useState<ParserTestStatus>('idle');
  const [testResult,      setTestResult]      = useState<ParserTestResult | null>(null);
  const [splitPct,        setSplitPct]        = useState(36);
  const [jsonTab,         setJsonTab]         = useState<'tree'|'raw'>('tree');
  const [selectMode,      setSelectMode]      = useState(false);
  const [copyFlash,       setCopyFlash]       = useState<string|null>(null);
  const [saveStatus,      setSaveStatus]      = useState<'idle'|'saving'|'saved'|'error'>('idle');
  const [loading,         setLoading]         = useState(true);
  const [liveFlash,       setLiveFlash]       = useState(false);
  const [importOpen,      setImportOpen]      = useState(false);
  const [importMode,      setImportMode]      = useState<'url'|'paste'>('url');
  const [importUrl,       setImportUrl]       = useState('');
  const [importHeaders,   setImportHeaders]   = useState('{}');
  const [importProbing,   setImportProbing]   = useState(false);
  const [importProbeResult, setImportProbeResult] = useState<{ok:boolean;status:number|null;parsed:unknown;latency_ms:number;error:string|null} | null>(null);
  const [importRaw,       setImportRaw]       = useState('');
  const [importError,     setImportError]     = useState('');

  // ── NEW: Sport iteration state ─────────────────────────────────────────────
  const [iterating,       setIterating]       = useState(false);
  const [iterResults,     setIterResults]     = useState<SportIterResult[] | null>(null);
  const [iterSummary,     setIterSummary]     = useState<IterationSummary | null>(null);
  const [iterLimit,       setIterLimit]       = useState(3);
  const [generating,      setGenerating]      = useState(false);

  const copyToClipboard = (val: unknown, label: string) => {
    navigator.clipboard.writeText(JSON.stringify(val, null, 2));
    setCopyFlash(label);
    setTimeout(() => setCopyFlash(null), 1800);
  };

  // On workflow change — load saved code & regenerate sample
  useEffect(() => {
    setLoading(true);
    setTestResult(null);
    setTestStatus('idle');
    setIterResults(null);
    setIterSummary(null);

    const sample = buildSampleFromSteps(workflow.steps);
    setSampleJson(JSON.stringify(sample, null, 2));

    apiFetch(`/workflows/${workflow.id}/parser`)
      .then(res => {
        if (res?.parser_code) setCode(res.parser_code);
        else setCode(generateParserTemplate(workflow.steps));
      })
      .catch(() => setCode(generateParserTemplate(workflow.steps)))
      .finally(() => setLoading(false));
  }, [workflow.id]);

  // Consume direct "use this as sample" override from per-step probe
  useEffect(() => {
    if (sampleOverride == null) return;
    setTimeout(() => {
      setSampleJson(JSON.stringify(sampleOverride, null, 2));
      setLiveFlash(true);
      setJsonTab('tree');
      setTimeout(() => setLiveFlash(false), 4000);
      onSampleOverrideConsumed?.();
    }, 0);
  }, [sampleOverride]);

  // Auto-populate sample from live probe results
  useEffect(() => {
    if (!probeData || Object.keys(probeData).length === 0) return;
    const sorted = [...workflow.steps].sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return;
    const merged: Record<string, unknown> = {};
    sorted.forEach((step, idx) => {
      const raw = probeData[step.position];
      if (raw === undefined) return;
      if (idx === 0) {
        if (Array.isArray(raw)) {
          merged[step.result_array_path || 'events'] = (raw as unknown[]).slice(0, 5);
        } else if (raw && typeof raw === 'object') {
          Object.assign(merged, raw);
        }
      } else {
        const key = `_${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `step${step.position}`}`;
        merged[key] = step.step_type === 'FETCH_PER_ITEM'
          ? (Array.isArray(raw) ? (raw as unknown[]).slice(0, 3) : [raw])
          : raw;
      }
    });
    if (Object.keys(merged).length > 0) {
      setSampleJson(JSON.stringify(merged, null, 2));
      setLiveFlash(true);
      setTimeout(() => setLiveFlash(false), 4000);
    }
  }, [probeData]);

  // ── NEW: Generate parser from onboarding ──────────────────────────────────
  const generateFromOnboarding = async () => {
    setGenerating(true);
    try {
      const res = await apiFetch(`/workflows/${workflow.id}/parser/generate`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setCode(res.code);
        setTestStatus('idle');
        setTestResult(null);
        setIterResults(null);
      }
    } catch { /* swallow */ }
    setGenerating(false);
  };

  // ── NEW: Iterate sports ───────────────────────────────────────────────────
  const iterateSports = async () => {
    if (!code.trim()) return;
    setIterating(true);
    setIterResults(null);
    setIterSummary(null);
    try {
      const res = await apiFetch(`/workflows/${workflow.id}/parser/iterate-sports`, {
        method: 'POST',
        body: JSON.stringify({ code, limit_per_sport: iterLimit }),
      });
      if (res.results) {
        setIterResults(res.results);
        setIterSummary(res.summary);
      }
    } catch { /* swallow */ }
    setIterating(false);
  };

  const probeImport = async () => {
    const url = importUrl.trim();
    if (!url) { setImportError('Enter a URL to probe'); return; }
    let headers: Record<string, string> = {};
    try { headers = JSON.parse(importHeaders || '{}'); } catch { setImportError('Headers must be valid JSON'); return; }
    setImportProbing(true);
    setImportProbeResult(null);
    setImportError('');
    try {
      const res = await apiFetch('/probe', {
        method: 'POST',
        body: JSON.stringify({ url, method: 'GET', headers, params: {} }),
      });
      setImportProbeResult({ ok: res.ok, status: res.status, parsed: res.parsed, latency_ms: res.latency_ms, error: res.error });
      if (!res.ok || res.parsed == null) setImportError(res.error || `HTTP ${res.status} — no parseable JSON`);
    } catch (e: any) {
      setImportError(e.message);
      setImportProbeResult({ ok: false, status: null, parsed: null, latency_ms: 0, error: e.message });
    }
    setImportProbing(false);
  };

  const prefillStepUrl = () => {
    const s1 = [...workflow.steps].sort((a, b) => a.position - b.position)[0];
    if (s1?.url_template && !s1.url_template.includes('{{')) {
      setImportUrl(s1.url_template);
      if (s1.headers && Object.keys(s1.headers).length > 0)
        setImportHeaders(JSON.stringify(s1.headers, null, 2));
    }
  };

  const importJson = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { setImportError('Paste some JSON first'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { setImportError('Invalid JSON'); return; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if ('parsed' in obj && obj.parsed != null) parsed = obj.parsed;
      else if ('response' in obj && obj.response != null) parsed = obj.response;
    }
    setSampleJson(JSON.stringify(parsed, null, 2));
    setLiveFlash(true);
    setTimeout(() => setLiveFlash(false), 4000);
    setImportOpen(false);
    setImportRaw('');
    setImportError('');
    setJsonTab('tree');
  };

  const runTest = async () => {
    setTestStatus('running');
    try {
      const res: ParserTestResult = await apiFetch(`/workflows/${workflow.id}/parser/test`, {
        method: 'POST',
        body: JSON.stringify({ code, sample_json: sampleJson, coverage_threshold: 50 }),
      });
      if (!res.ok) setTestStatus('error');
      else if (res.market_coverage && !res.market_coverage.ok) setTestStatus('coverage_warn');
      else setTestStatus('ok');
      setTestResult(res);
    } catch (e: any) {
      setTestStatus('error');
      setTestResult({ ok: false, rows: [], row_count: 0, valid_count: 0, validation_errors: [], error: e.message, elapsed_ms: 0 });
    }
  };

  const save = async () => {
    setSaveStatus('saving');
    try {
      const res = await apiFetch(`/workflows/${workflow.id}/parser/save`, {
        method: 'POST',
        body: JSON.stringify({ code, test_passed: testStatus === 'ok' || testStatus === 'coverage_warn' }),
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
    } catch { setSaveStatus('error'); }
    setTimeout(() => setSaveStatus('idle'), 2200);
  };

  const statusMeta = {
    idle:         { color: 'rgba(100,116,139,.5)', label: 'READY' },
    running:      { color: '#fb923c',              label: '⟳ TESTING…' },
    ok:           { color: '#c6f135',              label: '✓ PASSED' },
    error:        { color: '#f87171',              label: '✗ FAILED' },
    coverage_warn:{ color: '#fb923c',              label: '⚠ COVERAGE LOW' },
  }[testStatus];

  const canSave    = testStatus === 'ok' || testStatus === 'coverage_warn';
  const sampleData = (() => { try { return JSON.parse(sampleJson); } catch { return null; } })();
  const uniqueMarkets = testResult ? new Set(testResult.rows.map(r => r.market)).size : 0;
  const uniqueMatches = testResult ? new Set(testResult.rows.map(r => r.parent_match_id)).size : 0;

  if (loading) return (
    <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'#080d08' }}>
      <span style={{ fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'rgba(198,241,53,.3)' }}>LOADING PARSER…</span>
    </div>
  );

  // ── Import overlay ─────────────────────────────────────────────────────────
  const importOverlay = importOpen ? (
    <div style={{ position:'absolute', inset:0, zIndex:500, background:'rgba(0,0,0,.85)', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:580, background:'#0c150c', border:'1px solid rgba(198,241,53,.3)', boxShadow:'0 24px 64px rgba(0,0,0,.8)', display:'flex', flexDirection:'column' }}>
        <div style={{ display:'flex', alignItems:'center', padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,.07)' }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, color:'#c6f135' }}>↓ IMPORT SAMPLE JSON</span>
          <div style={{ flex:1 }} />
          <button onClick={() => setImportOpen(false)} style={{ background:'none', border:'none', color:'rgba(100,116,139,.5)', cursor:'pointer', fontSize:18, padding:0, lineHeight:1 }}>✕</button>
        </div>
        <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,.06)' }}>
          {(['url','paste'] as const).map(m => (
            <button key={m} onClick={() => { setImportMode(m); setImportError(''); setImportProbeResult(null); }}
              style={{ background:'none', border:'none', borderBottom:`2px solid ${importMode===m?'#c6f135':'transparent'}`, marginBottom:-1, fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, padding:'9px 16px', cursor:'pointer', color:importMode===m?'#c6f135':'rgba(100,116,139,.5)' }}>
              {m==='url'?'▶ PROBE URL':'⌅ PASTE JSON'}
            </button>
          ))}
        </div>
        {importMode==='url' && (
          <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
            <div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.6)', marginBottom:5 }}>
                URL  <span style={{ color:'rgba(6,182,212,.5)', cursor:'pointer' }} onClick={prefillStepUrl}>— click to pre-fill from step 1</span>
              </div>
              <input autoFocus value={importUrl} onChange={e=>{setImportUrl(e.target.value);setImportError('');setImportProbeResult(null);}} onKeyDown={e=>e.key==='Enter'&&probeImport()} placeholder="https://bookmaker.com/api/events" style={{ ...iS.input, width:'100%', boxSizing:'border-box' as const, fontFamily:'"Fira Code",monospace', fontSize:10 }} />
            </div>
            <div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.6)', marginBottom:5 }}>HEADERS (JSON)</div>
              <textarea value={importHeaders} onChange={e=>{setImportHeaders(e.target.value);setImportError('');}} placeholder='{"Authorization":"Bearer TOKEN"}' spellCheck={false} style={{ width:'100%', height:80, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)', color:'#86efac', fontFamily:'"Fira Code",monospace', fontSize:9, padding:'7px 10px', outline:'none', resize:'vertical' as const, lineHeight:1.5, boxSizing:'border-box' as const }} />
            </div>
            {importProbeResult && (
              <div style={{ border:`1px solid ${importProbeResult.ok?'rgba(198,241,53,.2)':'rgba(248,113,113,.2)'}`, background:'rgba(0,0,0,.3)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderBottom:'1px solid rgba(255,255,255,.05)' }}>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, color:importProbeResult.ok?'#c6f135':'#f87171' }}>{importProbeResult.ok?'✓ GOT RESPONSE':'✗ FAILED'}</span>
                  {importProbeResult.status && <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:importProbeResult.ok?'#c6f135':'#f87171', border:`1px solid ${importProbeResult.ok?'rgba(198,241,53,.3)':'rgba(248,113,113,.3)'}`, padding:'1px 6px' }}>{importProbeResult.status}</span>}
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.5)' }}>{importProbeResult.latency_ms}ms</span>
                </div>
                {importProbeResult.ok && importProbeResult.parsed != null && (
                  <div style={{ maxHeight:120, overflow:'auto', padding:'8px 10px' }}>
                    <JsonNode k={null} v={importProbeResult.parsed} depth={0} onSelect={selected => importJson(JSON.stringify(selected))} onCopy={val => navigator.clipboard.writeText(JSON.stringify(val, null, 2))} />
                  </div>
                )}
              </div>
            )}
            {importError && <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#f87171' }}>✗ {importError}</div>}
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:2 }}>
              <button onClick={()=>setImportOpen(false)} style={iS.cancelBtn}>Cancel</button>
              <button onClick={probeImport} disabled={importProbing||!importUrl.trim()} style={{ padding:'7px 16px', background:'rgba(6,182,212,.08)', border:'1px solid rgba(6,182,212,.4)', color:'#06b6d4', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, cursor:importProbing||!importUrl.trim()?'not-allowed':'pointer', opacity:!importUrl.trim()?0.4:1 }}>{importProbing?'PROBING…':'▶ PROBE'}</button>
              <button onClick={()=>{if(importProbeResult?.parsed!=null)importJson(JSON.stringify(importProbeResult.parsed));}} disabled={!importProbeResult?.ok||importProbeResult?.parsed==null} style={{ padding:'7px 18px', background:(importProbeResult?.ok&&importProbeResult?.parsed!=null)?'#c6f135':'rgba(100,116,139,.1)', color:(importProbeResult?.ok&&importProbeResult?.parsed!=null)?'#0a0a0a':'rgba(100,116,139,.35)', border:'none', fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, letterSpacing:1, cursor:(importProbeResult?.ok&&importProbeResult?.parsed!=null)?'pointer':'not-allowed' }}>↳ USE AS SAMPLE</button>
            </div>
          </div>
        )}
        {importMode==='paste' && (
          <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.6)', lineHeight:1.7 }}>
              Paste raw JSON — probe envelopes are auto-unwrapped.<br/>
              <span style={{ color:'rgba(198,241,53,.5)' }}>Ctrl+Enter to import.</span>
            </div>
            <textarea autoFocus value={importRaw} onChange={e=>{setImportRaw(e.target.value);setImportError('');}} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey))importJson(importRaw);}} placeholder="Paste JSON here…" spellCheck={false} style={{ width:'100%', height:200, background:'rgba(255,255,255,.03)', border:`1px solid ${importError?'rgba(248,113,113,.4)':'rgba(255,255,255,.1)'}`, color:'#86efac', fontFamily:'"Fira Code",monospace', fontSize:10, padding:'10px 12px', outline:'none', resize:'vertical' as const, lineHeight:1.55, boxSizing:'border-box' as const }} />
            {importError && <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#f87171' }}>✗ {importError}</div>}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button onClick={()=>setImportOpen(false)} style={iS.cancelBtn}>Cancel</button>
              <button onClick={()=>importJson(importRaw)} disabled={!importRaw.trim()} style={{ padding:'7px 18px', background:importRaw.trim()?'#c6f135':'rgba(100,116,139,.1)', color:importRaw.trim()?'#0a0a0a':'rgba(100,116,139,.35)', border:'none', fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, letterSpacing:1, cursor:importRaw.trim()?'pointer':'not-allowed' }}>↳ USE AS SAMPLE <span style={{ fontWeight:400, opacity:.6, fontSize:8 }}>Ctrl+Enter</span></button>
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null;

  // ── JSON panel (left — identical to original) ──────────────────────────────
  const jsonPanel = (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#060b06' }}>
      <div style={{ padding:'9px 12px', borderBottom:'1px solid rgba(255,255,255,.06)', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'#06b6d4' }}>SAMPLE JSON</span>
        {liveFlash && <span style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5, padding:'2px 8px', background:'rgba(198,241,53,.1)', border:'1px solid rgba(198,241,53,.4)', color:'#c6f135', animation:'fadeOut 4s forwards' }}>⚡ LIVE DATA</span>}
        {copyFlash && <span style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'2px 8px', background:'rgba(6,182,212,.1)', border:'1px solid rgba(6,182,212,.4)', color:'#67e8f9', animation:'fadeOut 1.8s forwards' }}>⎘ {copyFlash}</span>}
        <div style={{ flex:1 }} />
        {(['tree','raw'] as const).map(t => (
          <button key={t} onClick={()=>setJsonTab(t)} style={{ background:'none', border:'none', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, padding:'2px 8px', cursor:'pointer', color:jsonTab===t?'#06b6d4':'rgba(100,116,139,.45)', borderBottom:`1px solid ${jsonTab===t?'#06b6d4':'transparent'}` }}>{t.toUpperCase()}</button>
        ))}
        <button onClick={()=>{setSelectMode(s=>!s);setJsonTab('tree');}} style={{ background:selectMode?'rgba(198,241,53,.15)':'none', border:`1px solid ${selectMode?'rgba(198,241,53,.6)':'rgba(255,255,255,.1)'}`, color:selectMode?'#c6f135':'rgba(100,116,139,.45)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 8px', cursor:'pointer' }}>{selectMode?'✂ SELECTING…':'✂ SELECT'}</button>
        <button onClick={()=>setSampleJson(JSON.stringify(buildSampleFromSteps(workflow.steps),null,2))} style={{ background:'none', border:'1px solid rgba(6,182,212,.2)', color:'rgba(6,182,212,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 8px', cursor:'pointer' }}>↺ REGEN</button>
        <button onClick={()=>{if(sampleData!==null)copyToClipboard(sampleData,'COPIED');}} disabled={sampleData===null} style={{ background:'none', border:'1px solid rgba(6,182,212,.2)', color:'rgba(6,182,212,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 8px', cursor:'pointer', opacity:sampleData===null?0.3:1 }}>⎘ COPY</button>
        <button onClick={()=>{setImportRaw('');setImportError('');setImportProbeResult(null);const s1=[...workflow.steps].sort((a,b)=>a.position-b.position).find(s=>s.url_template&&!s.url_template.includes('{{'));if(s1){setImportUrl(s1.url_template);if(s1.headers&&Object.keys(s1.headers).length>0)setImportHeaders(JSON.stringify(s1.headers,null,2));}setImportOpen(true);}} style={{ background:'rgba(198,241,53,.06)', border:'1px solid rgba(198,241,53,.3)', color:'#c6f135', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 9px', cursor:'pointer' }}>↓ IMPORT</button>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'10px 12px' }}>
        {selectMode&&jsonTab==='tree'&&(
          <div style={{ marginBottom:8, padding:'6px 10px', background:'rgba(198,241,53,.07)', border:'1px solid rgba(198,241,53,.3)', fontFamily:'var(--font-mono)', fontSize:8, color:'#c6f135', lineHeight:1.6 }}>
            Hover any key → click <strong>↳ USE</strong> to use that subtree as sample.
            <button onClick={()=>setSelectMode(false)} style={{ float:'right', background:'none', border:'none', color:'rgba(100,116,139,.5)', cursor:'pointer', fontSize:11, padding:0, lineHeight:1 }}>✕</button>
          </div>
        )}
        {jsonTab==='tree'?(
          sampleData!==null
            ?<JsonNode k={null} v={sampleData} depth={0}
                onSelect={selectMode?(selected)=>{setSampleJson(JSON.stringify(selected,null,2));setLiveFlash(true);setTimeout(()=>setLiveFlash(false),4000);setSelectMode(false);}:undefined}
                onCopy={(val,path)=>copyToClipboard(val,path?`COPIED .${path}`:'COPIED')} />
            :<div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'#f87171' }}>⚠ Invalid JSON — switch to RAW to fix</div>
        ):(
          <textarea value={sampleJson} onChange={e=>setSampleJson(e.target.value)} style={{ width:'100%', height:'100%', minHeight:200, background:'transparent', border:'none', outline:'none', color:'#86efac', fontFamily:'"Fira Code", monospace', fontSize:10, resize:'none' as const, lineHeight:1.65 }} spellCheck={false} />
        )}
      </div>
      <div style={{ borderTop:'1px solid rgba(255,255,255,.06)', padding:'9px 12px', maxHeight:150, overflowY:'auto', flexShrink:0, background:'rgba(0,0,0,.25)' }}>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.4)', marginBottom:7 }}>FIELD INVENTORY</div>
        {[...workflow.steps].sort((a,b)=>a.position-b.position).map(step=>(
          <div key={step.id} style={{ marginBottom:8 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:STEP_TYPE_META[step.step_type]?.color??'#c6f135', marginBottom:4, display:'flex', alignItems:'center', gap:6 }}>
              <span>{STEP_TYPE_META[step.step_type]?.icon}</span>
              <span style={{ fontWeight:600 }}>Step {step.position}</span>
              <span style={{ color:'rgba(100,116,139,.5)', fontWeight:400 }}>· {step.name}</span>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, paddingLeft:14 }}>
              {step.fields.map((f,fi)=>(
                <span key={fi} title={`path: ${f.path}`} style={{ fontFamily:'var(--font-mono)', fontSize:7, padding:'1px 6px', background:`${roleColor(f.role)}14`, border:`1px solid ${roleColor(f.role)}40`, color:roleColor(f.role) }}>
                  {f.path} <span style={{ opacity:.45 }}>→</span> {f.role}
                </span>
              ))}
              {step.fields.length===0&&<span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.3)', fontStyle:'italic' }}>no fields mapped</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Editor panel (right) ───────────────────────────────────────────────────
  const editorPanel = (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#050a05' }}>
      {/* ── Toolbar ── */}
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 12px', borderBottom:'1px solid rgba(255,255,255,.06)', background:'rgba(0,0,0,.3)', flexShrink:0, flexWrap:'wrap' as const }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'rgba(100,116,139,.6)' }}>PARSE_DATA.PY</span>
        <div style={{ flex:1 }} />
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, color:statusMeta.color, transition:'color .2s' }}>{statusMeta.label}</span>

        {/* ── NEW: Generate from onboarding ── */}
        <button
          onClick={generateFromOnboarding}
          disabled={generating}
          title="Generate parse_data() from onboarding session field maps"
          style={{ background:generating?'rgba(198,241,53,.05)':'rgba(198,241,53,.1)', border:'1px solid rgba(198,241,53,.35)', color:'#c6f135', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5, padding:'4px 9px', cursor:generating?'not-allowed':'pointer' }}
        >{generating?'⟳ GENERATING…':'⚡ GENERATE'}</button>

        <button onClick={()=>{setCode(generateParserTemplate(workflow.steps));setTestStatus('idle');setTestResult(null);}} style={{ background:'none', border:'1px solid rgba(255,255,255,.1)', color:'rgba(100,116,139,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'4px 9px', cursor:'pointer' }}>↺ REGEN</button>
        <button onClick={runTest} disabled={testStatus==='running'} style={{ background:testStatus==='running'?'rgba(251,146,60,.08)':'rgba(198,241,53,.08)', border:`1px solid ${testStatus==='running'?'rgba(251,146,60,.4)':'rgba(198,241,53,.35)'}`, color:testStatus==='running'?'#fb923c':'#c6f135', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1.5, padding:'5px 14px', cursor:testStatus==='running'?'not-allowed':'pointer' }}>▶ TEST</button>
        <button onClick={save} disabled={!canSave||saveStatus==='saving'} style={{ background:canSave?'#c6f135':'rgba(100,116,139,.08)', border:canSave?'none':'1px solid rgba(100,116,139,.2)', color:canSave?'#0a0a0a':'rgba(100,116,139,.35)', fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, letterSpacing:1.5, padding:'5px 14px', cursor:canSave?'pointer':'not-allowed', transition:'all .15s' }}>
          {saveStatus==='saving'?'SAVING…':saveStatus==='saved'?'✓ SAVED':saveStatus==='error'?'✗ ERROR':'SAVE'}
        </button>
      </div>

      {/* ── Code editor ── */}
      <div style={{ flex: testResult ? '0 0 38%' : 1, overflow:'hidden', display:'flex', flexDirection:'column', minHeight: testResult ? 100 : undefined }}>
        <CodeEditor value={code} onChange={v=>{setCode(v);if(testStatus!=='idle')setTestStatus('idle');}} />
      </div>

      {/* ── Test results ── */}
      {testResult && (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderTop:'2px solid rgba(255,255,255,.06)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 12px', flexShrink:0, background:testResult.ok?'rgba(198,241,53,.04)':'rgba(248,113,113,.04)', borderBottom:'1px solid rgba(255,255,255,.05)' }}>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, color:testResult.ok?'#c6f135':'#f87171' }}>
              {testResult.ok?'✓':'✗'} {testResult.ok?`${testResult.row_count} rows · ${testResult.valid_count} valid`:'PARSE ERROR'}
            </span>
            {testResult.ok&&uniqueMarkets>0&&(
              <>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(6,182,212,.7)', border:'1px solid rgba(6,182,212,.2)', padding:'1px 7px' }}>{uniqueMarkets} markets</span>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.6)', border:'1px solid rgba(255,255,255,.08)', padding:'1px 7px' }}>{uniqueMatches} matches</span>
              </>
            )}
            <div style={{ flex:1 }} />
            <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.4)' }}>{testResult.elapsed_ms}ms</span>
          </div>
          {testResult.rows.length>0&&<RequiredKeysStrip rows={testResult.rows} />}
          {testResult.validation_errors.length>0&&(
            <div style={{ padding:'6px 12px', background:'rgba(248,113,113,.04)', borderBottom:'1px solid rgba(248,113,113,.12)', flexShrink:0 }}>
              {testResult.validation_errors.slice(0,4).map((e,i)=><div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#fca5a5', lineHeight:1.6 }}>✗ {e}</div>)}
              {testResult.validation_errors.length>4&&<div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(248,113,113,.4)' }}>… +{testResult.validation_errors.length-4} more</div>}
            </div>
          )}
          {testResult.warnings&&testResult.warnings.length>0&&(
            <div style={{ padding:'5px 12px', background:'rgba(251,146,60,.03)', borderBottom:'1px solid rgba(251,146,60,.1)', flexShrink:0 }}>
              {testResult.warnings.slice(0,2).map((w,i)=><div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#fbbf24' }}>⚠ {w}</div>)}
            </div>
          )}
          {testResult.ok&&testResult.rows.length>0?(
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <ParserResultsTable result={testResult} />
              {testResult.market_coverage&&<MarketCoveragePanel coverage={testResult.market_coverage} />}
            </div>
          ):!testResult.ok&&testResult.error?(
            <div style={{ flex:1, overflow:'auto', padding:'12px 14px', background:'rgba(248,113,113,.03)' }}>
              <pre style={{ margin:0, fontFamily:'"Fira Code", monospace', fontSize:10, color:'#fca5a5', whiteSpace:'pre-wrap', lineHeight:1.55 }}>{testResult.error}</pre>
            </div>
          ):(
            <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'rgba(100,116,139,.35)' }}>Parser returned 0 rows</span>
            </div>
          )}
        </div>
      )}

      {/* ── NEW: Sport iteration controls ── */}
      <div style={{ flexShrink:0, borderTop:'1px solid rgba(255,255,255,.06)', background:'rgba(0,0,0,.2)', padding:'8px 12px', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' as const }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.5)' }}>LIVE SPORT ITERATION</span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.35)' }}>Probe each configured sport against the live API</span>
        <div style={{ flex:1 }} />
        <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.4)' }}>matches/sport:</span>
        <input type="number" min={1} max={10} value={iterLimit} onChange={e=>setIterLimit(Math.max(1,Math.min(10,Number(e.target.value))))}
          style={{ background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.1)', color:'#e2e8f0', fontFamily:'var(--font-mono)', fontSize:9, padding:'3px 7px', width:44, outline:'none' }} />
        <button
          onClick={iterateSports}
          disabled={iterating||!code.trim()}
          style={{ background:iterating?'rgba(6,182,212,.05)':'rgba(6,182,212,.1)', border:`1px solid ${iterating?'rgba(6,182,212,.2)':'rgba(6,182,212,.4)'}`, color:'#06b6d4', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, padding:'6px 14px', cursor:iterating||!code.trim()?'not-allowed':'pointer', opacity:!code.trim()?0.4:1 }}
        >
          {iterating?'⟳ ITERATING…':'⟳ ITERATE ALL SPORTS'}
        </button>
      </div>

      {/* ── Sport iteration results panel ── */}
      {iterResults && iterSummary && (
        <SportIterationPanel results={iterResults} summary={iterSummary} />
      )}
    </div>
  );

  return (
    <div style={{ position:'relative', display:'flex', flex:1, overflow:'hidden' }}>
      {importOverlay}
      <SplitPane left={jsonPanel} right={editorPanel} splitPct={splitPct} onDrag={setSplitPct} />
    </div>
  );
}

// ─── IMPORTANT: Also add this import at the top of WorkflowExplorer.tsx ───────
//
//   import React from 'react';
//
// The SportIterationPanel uses React.useState directly —
// it should be fine since you already import { useState } from 'react',
// but the React.useState in SportIterationPanel needs React in scope.
// If you already have `import React from 'react'` it's fine.
// Otherwise change React.useState to useState throughout SportIterationPanel.