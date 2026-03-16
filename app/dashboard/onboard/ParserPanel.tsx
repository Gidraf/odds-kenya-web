// parser/ParserPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Full parser panel for one bookmaker workflow.
//
// Layout:
//   ┌─ Toolbar ──────────────────────────────────────────────────────────────┐
//   │  [sport] [wf_type] [REGEN SAMPLE] [REGEN CODE] [TEST ▶] [SAVE PARSER] │
//   ├──────────────────────────────────────────────────────────────────────── ┤
//   │  Required keys strip                                                    │
//   ├─ SplitPane ─────────────────────────────────────────────────────────────┤
//   │  Left: sample JSON textarea   │   Right: CodeEditor (Python)           │
//   ├─────────────────────────────────────────────────────────────────────────┤
//   │  Results: status bar · errors · MarketCoveragePanel · ResultsTable      │
//   └─────────────────────────────────────────────────────────────────────────┘

import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

import { SplitPane }            from './SplitPane';
import { CodeEditor }           from './CodeEditor';
import { MarketCoveragePanel }  from './MarketCoveragePanel';
import { ParserResultsTable }   from './ParserResultsTable';
import {
  REQUIRED_PARSER_KEYS,
  MATCH_LIST_TYPES,
  DEFAULT_PARSER_CODE,
  type ParserState,
  type ParserTestResult,
  type MarketCatalogueResponse,
  mkParserState,
} from './parserTypes';
import {
  buildMergedJson,
  generateDefaultParser,
  tryParseJson,
  fmtMs,
  type DraftStepSlim,
} from './parserUtils';

// ─── API base ────────────────────────────────────────────────────────────────

const BASE = '/research';
const apiFetch = (path: string, opts?: RequestInit) =>
  fetchWithAuth(`${BASE}${path}`, opts).then((r: Response) => r.json());

// ─── Style tokens ─────────────────────────────────────────────────────────────

const s = {
  mono:     { fontFamily: 'var(--font-mono)', fontSize: 9 } as React.CSSProperties,
  label:    { fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)' } as React.CSSProperties,
  btnPrimary: {
    background: 'var(--acid)', color: '#0a0a0a', border: 'none',
    fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
    letterSpacing: 2, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  btnGhost: {
    background: 'transparent', border: '1px solid var(--border-dim)',
    color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    fontSize: 9, letterSpacing: 1, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  btnSm: {
    background: 'none', border: '1px solid var(--border-dim)',
    color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    fontSize: 8, padding: '4px 9px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
    letterSpacing: 1,
  } as React.CSSProperties,
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface ParserPanelProps {
  /** Workflow database ID (null = unsaved) */
  wfId:         number | null;
  /** Steps from the builder — used to generate sample + default code */
  steps:        DraftStepSlim[];
  /** Sport name from workflow context */
  sport:        string | null;
  /** Workflow type e.g. MATCH_LIST, MARKETS_ONLY */
  workflowType: string;
  /** Parser state (lifted up so parent can persist it) */
  state:        ParserState;
  onChange:     (patch: Partial<ParserState>) => void;
}

// ─── Required keys strip ──────────────────────────────────────────────────────

function RequiredKeysStrip({ rows }: { rows: { [k: string]: unknown }[] }) {
  const present = new Set(rows.flatMap(r => Object.keys(r)));
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '5px 10px', background: 'rgba(0,0,0,.25)', borderBottom: '1px solid var(--border-dim)' }}>
      <span style={{ ...s.label, alignSelf: 'center', marginRight: 4 }}>REQUIRED KEYS</span>
      {REQUIRED_PARSER_KEYS.map(k => {
        const ok = present.has(k);
        return (
          <span key={k} style={{
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: .5,
            padding: '2px 7px',
            background: ok ? 'rgba(198,241,53,.07)' : 'rgba(251,146,60,.06)',
            border: `1px solid ${ok ? 'rgba(198,241,53,.25)' : 'rgba(251,146,60,.25)'}`,
            color:  ok ? 'var(--acid)' : '#fb923c',
          }}>
            {ok ? '✓ ' : ''}{k}
          </span>
        );
      })}
    </div>
  );
}

// ─── Test status bar ──────────────────────────────────────────────────────────

function TestStatusBar({ result, status, elapsedMs }: {
  result:    ParserTestResult | null;
  status:    ParserState['testStatus'];
  elapsedMs: number;
}) {
  if (status === 'idle') return null;

  const colors = {
    running:       'rgba(251,146,60,.9)',
    ok:            'var(--acid)',
    error:         'var(--red)',
    coverage_warn: 'rgba(251,146,60,.9)',
    idle:          'var(--text-muted)',
  };
  const icons = { running: '⟳', ok: '✓', error: '✗', coverage_warn: '⚠', idle: '○' };
  const c = colors[status];
  const icon = icons[status];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', background: status === 'ok' ? 'rgba(198,241,53,.04)' : status === 'error' ? 'rgba(255,61,90,.04)' : 'rgba(251,146,60,.04)', borderBottom: '1px solid var(--border-dim)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: c, animation: status === 'running' ? 'spin .7s linear infinite' : 'none', display: 'inline-block' }}>{icon}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: c, letterSpacing: 1, fontWeight: 700 }}>
        {status === 'running' ? 'TESTING…'
          : status === 'ok'      ? `PASS — ${result?.valid_count} VALID ROWS`
          : status === 'coverage_warn' ? `PASS (${result?.valid_count} rows) — COVERAGE WARNING`
          : `FAIL`
        }
      </span>
      {result && status !== 'running' && (
        <>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{result.row_count} rows · {fmtMs(elapsedMs)}</span>
          {result.validation_errors.length > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)' }}>{result.validation_errors.length} validation error{result.validation_errors.length !== 1 ? 's' : ''}</span>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)' }}>{result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}</span>
          )}
        </>
      )}
    </div>
  );
}

// ─── ParserPanel ──────────────────────────────────────────────────────────────

export function ParserPanel({ wfId, steps, sport, workflowType, state, onChange }: ParserPanelProps) {
  const [jsonErr,      setJsonErr]      = useState('');
  const [sampleHeight, setSampleHeight] = useState(320);
  const editorContainerRef              = useRef<HTMLDivElement>(null);

  // ── Regen sample from builder steps ────────────────────────────────────────
  const regenSample = useCallback(() => {
    if (steps.length === 0) { onChange({ sampleJson: '{}' }); return; }
    const merged = buildMergedJson(steps);
    onChange({ sampleJson: JSON.stringify(merged, null, 2) });
  }, [steps, onChange]);

  // ── Regen default parser code ────────────────────────────────────────────
  const regenCode = useCallback(() => {
    const code = generateDefaultParser(steps);
    onChange({ code });
  }, [steps, onChange]);

  // Auto-regen sample when steps change (if sample is still the default {})
  useEffect(() => {
    if (state.sampleJson === '{}' && steps.length > 0) regenSample();
  }, [steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Test parser ────────────────────────────────────────────────────────────
  const runTest = useCallback(async () => {
    const parsed = tryParseJson(state.sampleJson);
    if (!parsed.ok) {
      setJsonErr(parsed.error);
      return;
    }
    setJsonErr('');
    onChange({ testStatus: 'running', testResult: null });

    try {
      const endpoint = wfId
        ? `/workflows/${wfId}/parser/test`
        : '/parser/test';

      const body: Record<string, unknown> = {
        code:        state.code,
        sample_json: parsed.data,
        sport,
        workflow_type:       workflowType,
        coverage_threshold:  50,
      };

      const res: ParserTestResult = await apiFetch(endpoint, {
        method: 'POST',
        body:   JSON.stringify(body),
      });

      // Determine final test status
      let finalStatus: ParserState['testStatus'] = res.ok ? 'ok' : 'error';
      if (res.ok && res.market_coverage && !res.market_coverage.ok) {
        finalStatus = 'error';
      } else if (res.ok && res.market_coverage?.warnings?.length) {
        finalStatus = 'coverage_warn';
      }

      onChange({
        testStatus:  finalStatus,
        testResult:  res,
      });
    } catch (e: unknown) {
      onChange({
        testStatus: 'error',
        testResult: {
          ok: false, rows: [], row_count: 0, valid_count: 0,
          validation_errors: [(e as Error).message],
          error: (e as Error).message,
          elapsed_ms: 0,
        },
      });
    }
  }, [state.code, state.sampleJson, wfId, sport, workflowType, onChange]);

  // ── Save parser ────────────────────────────────────────────────────────────
  const saveParser = useCallback(async () => {
    if (!wfId) return;
    onChange({ saveStatus: 'saving', saveMsg: '' });
    try {
      const res = await apiFetch(`/workflows/${wfId}/parser/save`, {
        method: 'POST',
        body: JSON.stringify({
          code:        state.code,
          test_passed: state.testStatus === 'ok' || state.testStatus === 'coverage_warn',
          sport,
          workflow_type: workflowType,
        }),
      });
      if (res.ok) {
        onChange({ saveStatus: 'saved', saveMsg: `✓ Parser saved to workflow ${wfId}` });
      } else {
        onChange({ saveStatus: 'error', saveMsg: `✗ ${res.error ?? 'Save failed'}` });
      }
    } catch (e: unknown) {
      onChange({ saveStatus: 'error', saveMsg: `✗ ${(e as Error).message}` });
    }
  }, [wfId, state.code, state.testStatus, sport, workflowType, onChange]);

  const result    = state.testResult;
  const coverage  = result?.market_coverage;
  const hasResult = !!result;
  const rows      = result?.rows ?? [];
  const isMatchList = MATCH_LIST_TYPES.has(workflowType);

  // Save button enabled?
  const canSave = !!wfId && (state.testStatus === 'ok' || state.testStatus === 'coverage_warn') && !!state.code.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', flexShrink: 0, flexWrap: 'wrap' as const }}>
        {/* Sport + type chips */}
        {sport && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '2px 8px', background: 'rgba(198,241,53,.08)', border: '1px solid rgba(198,241,53,.2)', color: 'var(--acid)' }}>
            {sport}
          </span>
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '2px 8px', background: isMatchList ? 'rgba(6,182,212,.08)' : 'rgba(251,146,60,.08)', border: `1px solid ${isMatchList ? 'rgba(6,182,212,.2)' : 'rgba(251,146,60,.2)'}`, color: isMatchList ? 'var(--cyan)' : '#fb923c' }}>
          {workflowType}
        </span>

        <div style={{ flex: 1 }} />

        {/* Regen buttons */}
        <button onClick={regenSample} style={s.btnSm} title="Re-generate sample JSON from builder step probes">
          ↺ REGEN SAMPLE
        </button>
        <button onClick={regenCode} style={s.btnSm} title="Re-generate default parser code from detected field roles">
          ↺ REGEN CODE
        </button>

        {/* Test */}
        <button
          onClick={runTest}
          disabled={state.testStatus === 'running'}
          style={{
            ...s.btnPrimary,
            background: state.testStatus === 'running' ? 'rgba(198,241,53,.4)' : 'var(--acid)',
            animation:  state.testStatus === 'running' ? 'pulse 1s ease-in-out infinite' : 'none',
          }}
        >
          {state.testStatus === 'running' ? '⟳ TESTING…' : '▶ TEST'}
          <span style={{ fontSize: 7, opacity: .6, marginLeft: 5 }}>⌃↵</span>
        </button>

        {/* Save */}
        {wfId && (
          <button
            onClick={saveParser}
            disabled={!canSave || state.saveStatus === 'saving'}
            style={{
              background: canSave ? 'rgba(198,241,53,.12)' : 'transparent',
              border: `1px solid ${canSave ? 'var(--acid)' : 'var(--border-dim)'}`,
              color: canSave ? 'var(--acid)' : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: 2, padding: '7px 14px', cursor: canSave ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap' as const, opacity: canSave ? 1 : .4,
            }}
          >
            {state.saveStatus === 'saving' ? '⟳ SAVING…' : state.saveStatus === 'saved' ? '✓ SAVED' : '✓ SAVE PARSER'}
          </button>
        )}
        {!wfId && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.6)' }}>save workflow first to persist parser</span>
        )}
      </div>

      {/* Save msg */}
      {state.saveMsg && (
        <div style={{ padding: '5px 12px', background: state.saveStatus === 'error' ? 'rgba(255,61,90,.06)' : 'rgba(198,241,53,.06)', fontFamily: 'var(--font-mono)', fontSize: 8, color: state.saveStatus === 'error' ? 'var(--red)' : 'var(--acid)' }}>
          {state.saveMsg}
        </div>
      )}

      {/* ── Required keys strip ─────────────────────────────────────────────── */}
      <RequiredKeysStrip rows={rows} />

      {/* ── Split pane: Sample JSON │ Code Editor ──────────────────────────── */}
      <div ref={editorContainerRef} style={{ flex: 1, minHeight: 0, position: 'relative' as const }}>
        <SplitPane
          left={
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: '4px 10px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={s.label}>SAMPLE JSON</span>
                {jsonErr && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)', flex: 1 }}>✗ {jsonErr}</span>}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginLeft: 'auto', opacity: .6 }}>paste or regen ↑</span>
              </div>
              <textarea
                value={state.sampleJson}
                onChange={e => { onChange({ sampleJson: e.target.value }); setJsonErr(''); }}
                spellCheck={false}
                placeholder={'{\n  "events": []\n}'}
                style={{
                  flex: 1,
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  background: '#070d07',
                  color: 'rgba(167,243,208,.85)',
                  padding: '10px 12px',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  lineHeight: '16px',
                  overflowY: 'auto',
                  borderRight: '1px solid var(--border-dim)',
                  borderLeft: jsonErr ? '2px solid rgba(255,61,90,.5)' : 'none',
                }}
              />
            </div>
          }
          right={
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' as const }}>
              <div style={{ padding: '4px 10px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={s.label}>PARSER CODE</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', opacity: .6 }}>Python 3 · def parse_data(raw_data) → list[dict]</span>
                {state.testStatus !== 'idle' && (
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 6px', background: state.testStatus === 'ok' ? 'rgba(198,241,53,.1)' : state.testStatus === 'error' ? 'rgba(255,61,90,.1)' : 'rgba(251,146,60,.1)', border: `1px solid ${state.testStatus === 'ok' ? 'rgba(198,241,53,.3)' : state.testStatus === 'error' ? 'rgba(255,61,90,.3)' : 'rgba(251,146,60,.3)'}`, color: state.testStatus === 'ok' ? 'var(--acid)' : state.testStatus === 'error' ? 'var(--red)' : 'rgba(251,146,60,.9)' }}>
                    {state.testStatus === 'ok' ? '✓ PASS' : state.testStatus === 'coverage_warn' ? '⚠ WARN' : state.testStatus === 'error' ? '✗ FAIL' : '⟳'}
                  </span>
                )}
              </div>
              <CodeEditor
                value={state.code}
                onChange={code => onChange({ code })}
                onRun={runTest}
                height="100%"
              />
            </div>
          }
          defaultSplit={state.splitPct}
          onSplitChange={pct => onChange({ splitPct: pct })}
          height="100%"
        />
      </div>

      {/* ── Results area ─────────────────────────────────────────────────────── */}
      {hasResult && (
        <div style={{ flexShrink: 0, borderTop: '1px solid var(--border-dim)', maxHeight: '50vh', overflowY: 'auto' }}>

          {/* Status bar */}
          <TestStatusBar
            result={result}
            status={state.testStatus}
            elapsedMs={result?.elapsed_ms ?? 0}
          />

          {/* Fatal error */}
          {result.error && (
            <div style={{ padding: '10px 12px', background: 'rgba(255,61,90,.04)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)', borderBottom: '1px solid rgba(255,61,90,.2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.6 }}>
              {result.error}
            </div>
          )}

          {/* Row-level validation errors */}
          {result.validation_errors.length > 0 && (
            <div style={{ padding: '8px 12px', background: 'rgba(255,61,90,.03)', borderBottom: '1px solid rgba(255,61,90,.15)' }}>
              <div style={{ ...s.label, color: 'var(--red)', marginBottom: 5 }}>VALIDATION ERRORS ({result.validation_errors.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 120, overflowY: 'auto' }}>
                {result.validation_errors.map((e, i) => (
                  <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,61,90,.8)' }}>• {e}</div>
                ))}
              </div>
            </div>
          )}

          {/* Warnings */}
          {result.warnings && result.warnings.length > 0 && (
            <div style={{ padding: '8px 12px', background: 'rgba(251,146,60,.03)', borderBottom: '1px solid rgba(251,146,60,.15)' }}>
              {result.warnings.map((w, i) => (
                <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)' }}>⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Market coverage panel */}
          {coverage && (
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-dim)' }}>
              <MarketCoveragePanel
                coverage={coverage}
                sport={sport}
                apiBase={BASE}
              />
            </div>
          )}

          {/* Results table */}
          {rows.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-dim)' }}>
              <ParserResultsTable rows={rows} total={result.row_count} />
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}
