'use client';
/**
 * WorkflowExplorer  —  /dashboard/workflows
 * ==========================================
 * Visual tree of all bookmaker harvest workflows.
 *
 * Layout
 * ──────
 *   LEFT RAIL   — bookmakers accordion, click bookmaker → loads its workflows
 *   MAIN CANVAS — STEPS tab: vertical step chain with inline-editable fields
 *                 PARSER tab: split-pane JSON viewer + code editor + validator
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FieldDescriptor {
  path:  string;
  role:  string;
  label: string;
  store?: boolean;
}

interface WorkflowStep {
  id:                number;
  position:          number;
  name:              string;
  step_type:         'FETCH_LIST' | 'FETCH_PER_ITEM' | 'FETCH_ONCE';
  url_template:      string;
  method:            string;
  headers:           Record<string, string>;
  params:            Record<string, string>;
  body_template:     string | null;
  result_array_path: string;
  fields:            FieldDescriptor[];
  depends_on_pos:    number | null;
  field_mappings:    Record<string, string>;
  enabled:           boolean;
  notes:             string;
  template_vars:     string[];
  parser_code?:      string | null;
  parser_test_passed?: boolean;
}

interface Workflow {
  parser_code: any;
  parser_test_passed: any;
  id:            number;
  bookmaker_id:  number;
  bookmaker_name:string | null;
  name:          string;
  description:   string;
  is_active:     boolean;
  created_at:    string | null;
  updated_at:    string | null;
  steps:         WorkflowStep[];
}

interface BookmakerNode {
  bookmaker_id:   number;
  bookmaker_name: string;
  domain:         string;
  workflow_count: number;
  workflows:      Workflow[];
}

interface FieldRole {
  role:        string;
  group:       string;
  label:       string;
  description: string;
}

// ─── Parser types ─────────────────────────────────────────────────────────────

const REQUIRED_PARSER_KEYS = [
  'parent_match_id','home_team','away_team','start_time',
  'sport','competition','market','selection','price','specifier',
] as const;
type RequiredParserKey = typeof REQUIRED_PARSER_KEYS[number];
type ParserTestStatus = 'idle' | 'running' | 'ok' | 'error' | 'coverage_warn';

interface ParsedRow {
  parent_match_id?: string;
  home_team?: string; away_team?: string;
  start_time?: string | null; sport?: string | null; competition?: string | null;
  market?: string; selection?: string; price?: number; specifier?: string | null;
  [key: string]: unknown;
}
interface MarketCoverageResult {
  ok: boolean; workflow_type: string; sport: string | null;
  coverage_pct: number; present_markets: string[];
  missing_markets: ({ name: string; slug: string } | string)[];
  extra_markets: string[]; expected_count: number; present_count: number;
  error: string | null; warnings: string[];
}
interface ParserTestResult {
  ok: boolean; rows: ParsedRow[]; row_count: number; valid_count: number;
  validation_errors: string[]; error: string | null; elapsed_ms: number;
  warnings?: string[]; market_coverage?: MarketCoverageResult | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE    = '/research';
const apiFetch = (path: string, opts?: RequestInit) =>
  fetchWithAuth(`${BASE}${path}`, opts).then(r => r.json());

const STEP_TYPE_META: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  FETCH_LIST:     { color: '#c6f135', bg: 'rgba(198,241,53,.08)',  icon: '▤', label: 'FETCH LIST' },
  FETCH_PER_ITEM: { color: '#06b6d4', bg: 'rgba(6,182,212,.08)',   icon: '⟳', label: 'PER ITEM' },
  FETCH_ONCE:     { color: '#fb923c', bg: 'rgba(251,146,60,.08)',   icon: '◉', label: 'FETCH ONCE' },
};

const ROLE_COLORS: Record<string, string> = {
  match_id:'#c6f135', parent_match_id:'#a3e635',
  home_team:'#34d399', away_team:'#34d399',
  start_time:'#94a3b8', sport:'#94a3b8', competition:'#94a3b8',
  market_name:'#06b6d4', specifier:'#06b6d4',
  selection_name:'#38bdf8', selection_price:'#38bdf8',
  home_lineup:'#f472b6', away_lineup:'#f472b6',
  home_form:'#fb923c', away_form:'#fb923c',
  match_status:'#e2e8f0', score_home:'#e2e8f0', score_away:'#e2e8f0',
  lineup_confirmed:'#c084fc', kickoff_in_mins:'#c084fc',
  custom:'#64748b',
};

const METHOD_COLORS: Record<string, string> = {
  GET:'#4ade80', POST:'#fb923c', PUT:'#38bdf8', PATCH:'#a78bfa', DELETE:'#f87171',
};

const DEFAULT_PARSER_CODE = `def parse_data(raw_data):
    """
    Convert raw bookmaker JSON into unified match rows.

    Required keys per row:
      parent_match_id, home_team, away_team, market,
      selection, price (float > 1.0), specifier (str|None)

    Optional: start_time, sport, competition
    """
    rows = []

    events = raw_data if isinstance(raw_data, list) else raw_data.get('events', [])

    for event in events:
        base = {
            'parent_match_id': str(event.get('id', '')),
            'home_team':       event.get('home_team', ''),
            'away_team':       event.get('away_team', ''),
            'start_time':      event.get('start_time', None),
            'sport':           event.get('sport', None),
            'competition':     event.get('competition', None),
        }
        markets = event.get('markets', [])
        for market in markets:
            market_name = market.get('name', '')
            specifier   = market.get('specifier', None)
            for selection in market.get('selections', []):
                rows.append({
                    **base,
                    'market':    market_name,
                    'selection': selection.get('name', ''),
                    'price':     float(selection.get('price', 0)),
                    'specifier': specifier,
                })

    return rows
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const roleColor = (role: string) => ROLE_COLORS[role] ?? '#64748b';

function parseTemplateVars(tmpl: string): string[] {
  return [...new Set([...(tmpl.matchAll(/\{\{(\w+)\}\}/g))].map(m => m[1]))];
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (!path || obj == null) return obj;
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function extractArray(data: unknown, arrayPath: string): unknown[] {
  const root = arrayPath ? getNestedValue(data, arrayPath) : data;
  if (Array.isArray(root)) return root;
  if (root && typeof root === 'object') {
    for (const v of Object.values(root as Record<string, unknown>)) {
      if (Array.isArray(v) && (v as unknown[]).length > 0) return v as unknown[];
    }
  }
  return [];
}

function resolveUrlTemplate(
  urlTemplate: string, params: Record<string, string>,
  fieldMappings: Record<string, string>, sourceItem: Record<string, unknown>,
): { url: string; params: Record<string, string> } {
  const resolveVar = (v: string): string => {
    const srcPath = fieldMappings?.[v];
    if (srcPath) { const val = getNestedValue(sourceItem, srcPath); if (val != null) return String(val); }
    if (sourceItem[v] != null) return String(sourceItem[v]);
    return `<${v}>`;
  };
  const url = urlTemplate.replace(/\{\{(\w+)\}\}/g, (_, v) => resolveVar(v));
  const rp: Record<string, string> = {};
  Object.entries(params ?? {}).forEach(([k, val]) => { rp[k] = val.replace(/\{\{(\w+)\}\}/g, (_, v) => resolveVar(v)); });
  return { url, params: rp };
}

function extractFields(item: unknown, fields: FieldDescriptor[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!item || typeof item !== 'object') return out;
  (fields ?? []).forEach(f => {
    const v = getNestedValue(item, f.path);
    if (v != null) out[f.label || f.role || f.path] = String(v);
  });
  return out;
}

const fmtMs  = (ms: number | null) => ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const fmtKb  = (b: number) => b > 0 ? `${(b / 1024).toFixed(1)} KB` : '';

// ─── Parser utils ─────────────────────────────────────────────────────────────

const ROLE_SAMPLES: Record<string, unknown> = {
  match_id: 12345, parent_match_id: 12345,
  home_team: 'Arsenal', away_team: 'Chelsea',
  start_time: '2025-01-15T15:00:00Z',
  sport: 'Football', competition: 'Premier League',
  market_name: '1X2', market: '1X2', specifier: null,
  selection_name: 'Home', selection: 'Home',
  selection_price: 2.10, price: 2.10,
  match_status: 'NOT_STARTED', score_home: 0, score_away: 0,
  custom: 'value',
};

function buildSampleFromSteps(steps: WorkflowStep[]): Record<string, unknown> {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const merged: Record<string, unknown> = {};

  sorted.forEach((step, idx) => {
    const item: Record<string, unknown> = {};
    if (step.fields.length > 0) {
      step.fields.forEach(f => {
        const key = f.path.split('.').pop()!;
        item[key] = ROLE_SAMPLES[f.role] ?? f.label ?? 'value';
      });
    } else {
      item['id'] = 12345; item['name'] = 'sample_event';
    }

    if (idx === 0) {
      Object.assign(merged, item);
    } else {
      const key = `_${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g,'') || `step${step.position}`}`;
      merged[key] = step.step_type === 'FETCH_PER_ITEM' ? [item] : item;
    }
  });

  return Object.keys(merged).length > 0 ? merged : {
    events: [{ id: 1, home_team: 'Arsenal', away_team: 'Chelsea', start_time: '2025-01-15T15:00:00Z', sport: 'Football', competition: 'Premier League', markets: [{ name: '1X2', specifier: null, selections: [{ name: 'Home', price: 2.10 }, { name: 'Draw', price: 3.40 }, { name: 'Away', price: 3.20 }] }] }]
  };
}

function generateParserTemplate(steps: WorkflowStep[]): string {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const step1 = sorted[0];
  const step2 = sorted[1];
  if (!step1) return DEFAULT_PARSER_CODE;

  const ff = (fields: FieldDescriptor[], role: string) => fields.find(f => f.role === role);
  const pg = (path: string, obj: string, fallback = '') => {
    const p = path.split('.');
    return p.length === 1 ? `${obj}.get('${p[0]}', '${fallback}')` : `${obj}.get('${p[0]}', {}).get('${p.slice(1).join("', {}).get('")}', '${fallback}')`;
  };

  const s1 = step1.fields;
  const matchId = ff(s1,'match_id') || ff(s1,'parent_match_id');
  const home    = ff(s1,'home_team');
  const away    = ff(s1,'away_team');
  const time    = ff(s1,'start_time');
  const sport   = ff(s1,'sport');
  const comp    = ff(s1,'competition');
  const evPath  = step1.result_array_path
    ? `raw_data.get('${step1.result_array_path}', [])`
    : `raw_data if isinstance(raw_data, list) else raw_data.get('events', [])`;

  if (step2 && step2.step_type === 'FETCH_PER_ITEM') {
    const s2    = step2.fields;
    const mkt   = ff(s2,'market_name') || ff(s2,'market');
    const sel   = ff(s2,'selection_name') || ff(s2,'selection');
    const price = ff(s2,'selection_price') || ff(s2,'price');
    const spec  = ff(s2,'specifier');
    const s2key = `_${step2.name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || `step${step2.position}`}`;

    return `def parse_data(raw_data):
    """
    Multi-step parser — Step ${step1.position}: match list, Step ${step2.position}: market data.
    raw_data is the merged output from both steps.
    """
    rows = []

    # ── Base match fields from step ${step1.position} ──────────────────────────
    base = {
        'parent_match_id': str(${matchId ? pg(matchId.path,'raw_data') : "raw_data.get('id', '')"}),
        'home_team':       ${home  ? pg(home.path,'raw_data') : "raw_data.get('home_team', '')"},
        'away_team':       ${away  ? pg(away.path,'raw_data') : "raw_data.get('away_team', '')"},
        'start_time':      ${time  ? `raw_data.get('${time.path}', None)` : "raw_data.get('start_time', None)"},
        'sport':           ${sport ? `raw_data.get('${sport.path}', None)` : "raw_data.get('sport', None)"},
        'competition':     ${comp  ? `raw_data.get('${comp.path}', None)` : "raw_data.get('competition', None)"},
    }

    # ── Market rows from step ${step2.position} ────────────────────────────────
    market_data = raw_data.get('${s2key}', [])
    if isinstance(market_data, dict):
        market_data = [market_data]

    for mkt in market_data:
        market_name = ${mkt ? `mkt.get('${mkt.path.split('.').pop()}', '')` : "mkt.get('market', mkt.get('name', ''))"}
        specifier   = ${spec ? `mkt.get('${spec.path.split('.').pop()}', None)` : "mkt.get('specifier', None)"}
        selections  = mkt.get('selections', [mkt])
        for sel in selections:
            try:
                price = float(${price ? `sel.get('${price.path.split('.').pop()}', 0)` : "sel.get('price', 0)"} or 0)
            except (TypeError, ValueError):
                price = 0.0
            rows.append({
                **base,
                'market':    market_name,
                'selection': ${sel ? `sel.get('${sel.path.split('.').pop()}', '')` : "sel.get('name', sel.get('selection', ''))"},
                'price':     price,
                'specifier': specifier,
            })

    return rows
`;
  }

  return `def parse_data(raw_data):
    """
    Single-step parser: events with embedded markets.
    Adapt paths to match your bookmaker's actual JSON shape.
    """
    rows = []
    events = ${evPath}

    for event in events:
        base = {
            'parent_match_id': str(${matchId ? pg(matchId.path,'event') : "event.get('id', '')"}),
            'home_team':       ${home  ? pg(home.path,'event') : "event.get('home_team', '')"},
            'away_team':       ${away  ? pg(away.path,'event') : "event.get('away_team', '')"},
            'start_time':      ${time  ? `event.get('${time.path}', None)` : "event.get('start_time', None)"},
            'sport':           ${sport ? `event.get('${sport.path}', None)` : "event.get('sport', None)"},
            'competition':     ${comp  ? `event.get('${comp.path}', None)` : "event.get('competition', None)"},
        }
        markets = event.get('markets', [])
        for mkt in markets:
            for sel in mkt.get('selections', []):
                rows.append({
                    **base,
                    'market':    mkt.get('name', ''),
                    'selection': sel.get('name', ''),
                    'price':     float(sel.get('price', 0) or 0),
                    'specifier': mkt.get('specifier', None),
                })

    return rows
`;
}

// ─── JsonNode ─────────────────────────────────────────────────────────────────

function JsonNode({ k, v, depth, onSelect, onCopy, path = '' }: {
  k: string | null; v: unknown; depth: number;
  onSelect?: (v: unknown, path: string) => void;
  onCopy?:   (v: unknown, path: string) => void;
  path?: string;
}) {
  const isArr  = Array.isArray(v);
  const isObj  = v !== null && typeof v === 'object';
  const entries: [string, unknown][] = isObj
    ? (isArr ? (v as unknown[]).map((item, i) => [String(i), item]) : Object.entries(v as Record<string, unknown>))
    : [];
  const [open,    setOpen]    = useState(depth < 2);
  const [hovered, setHovered] = useState(false);

  const kColor = depth === 0 ? '#c6f135' : depth === 1 ? '#67e8f9' : depth === 2 ? '#a5b4fc' : '#94a3b8';
  const vColor = typeof v === 'number' ? '#fb923c' : typeof v === 'boolean' ? '#c084fc' : v === null ? '#64748b' : '#86efac';
  const bracket = isArr ? ['[', `${entries.length}]`] : ['{', `${entries.length}}`];
  const nodeLabel = isArr ? `[${entries.length}]` : isObj ? `{${entries.length}}` : JSON.stringify(v);
  const selectActive = !!onSelect || !!onCopy;

  return (
    <div
      style={{ paddingLeft: depth > 0 ? 14 : 0, lineHeight: '18px', position: 'relative' }}
      onMouseEnter={() => selectActive && setHovered(true)}
      onMouseLeave={() => selectActive && setHovered(false)}
    >
      {/* Select highlight bar */}
      {selectActive && hovered && (
        <div style={{ position:'absolute', left:-6, top:0, bottom:0, width:2, background:'rgba(198,241,53,.6)', borderRadius:1 }} />
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap', background: selectActive && hovered ? 'rgba(198,241,53,.04)' : 'transparent', borderRadius: 2 }}>
        {isObj && entries.length > 0 ? (
          <span onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', color: '#c6f135', fontSize: 9, width: 10, flexShrink: 0, userSelect: 'none' }}>
            {open ? '▾' : '▸'}
          </span>
        ) : <span style={{ width: 10, flexShrink: 0 }} />}

        {k !== null && (
          <span style={{ fontFamily: '"Fira Code", monospace', fontSize: 10, color: kColor, flexShrink: 0 }}>
            {k}:<span style={{ color: 'rgba(255,255,255,.2)' }}> </span>
          </span>
        )}

        {isObj ? (
          <span style={{ fontFamily: '"Fira Code", monospace', fontSize: 10, color: 'rgba(100,116,139,.6)' }}>
            {bracket[0]}
            {!open && (
              <span style={{ color: 'rgba(100,116,139,.4)', cursor: 'pointer' }} onClick={() => setOpen(true)}>
                … {bracket[1]}
              </span>
            )}
            {open && entries.length === 0 && bracket[1]}
          </span>
        ) : (
          <span style={{ fontFamily: '"Fira Code", monospace', fontSize: 10, color: vColor }}>
            {v === null ? 'null' : JSON.stringify(v)}
          </span>
        )}

        {/* USE + COPY buttons — appear on hover in select mode */}
        {selectActive && hovered && (
          <>
            <button
              onClick={e => { e.stopPropagation(); onSelect!(v, path); }}
              style={{
                marginLeft: 6, padding: '0px 7px', background: '#c6f135', border: 'none',
                color: '#0a0a0a', fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
                letterSpacing: 1, cursor: 'pointer', lineHeight: '16px', flexShrink: 0,
              }}
              title={`Use ${path || 'root'} as sample (${nodeLabel})`}
            >↳ USE</button>
            <button
              onClick={e => {
                e.stopPropagation();
                if (onCopy) onCopy(v, path);
                else navigator.clipboard.writeText(JSON.stringify(v, null, 2));
              }}
              style={{
                padding: '0px 7px', background: 'rgba(6,182,212,.15)', border: '1px solid rgba(6,182,212,.4)',
                color: '#67e8f9', fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
                letterSpacing: 1, cursor: 'pointer', lineHeight: '16px', flexShrink: 0,
              }}
              title={`Copy ${path || 'root'} to clipboard (full value, even if collapsed)`}
            >⎘ COPY</button>
          </>
        )}
      </div>

      {isObj && open && entries.length > 0 && (
        <div>
          {entries.map(([ek, ev]) => (
            <JsonNode
              key={ek} k={ek} v={ev} depth={depth + 1}
              onSelect={onSelect}
              onCopy={onCopy}
              path={path ? `${path}.${ek}` : ek}
            />
          ))}
          <div style={{ paddingLeft: 10, fontFamily: '"Fira Code", monospace', fontSize: 10, color: 'rgba(100,116,139,.5)' }}>
            {isArr ? ']' : '}'}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CodeEditor ───────────────────────────────────────────────────────────────

function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const taRef   = useRef<HTMLTextAreaElement>(null);
  const lnRef   = useRef<HTMLDivElement>(null);
  const lines   = value.split('\n');

  const syncScroll = () => {
    if (taRef.current && lnRef.current) lnRef.current.scrollTop = taRef.current.scrollTop;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = e.currentTarget;
      onChange(value.slice(0, s) + '    ' + value.slice(end));
      setTimeout(() => { if (taRef.current) { taRef.current.selectionStart = taRef.current.selectionEnd = s + 4; } }, 0);
    }
  };

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', fontSize: 11, lineHeight: '17px' }}>
      {/* Line numbers */}
      <div ref={lnRef} style={{
        width: 38, flexShrink: 0, overflowY: 'hidden', background: 'rgba(0,0,0,.35)',
        borderRight: '1px solid rgba(255,255,255,.06)', padding: '10px 0',
        userSelect: 'none', color: 'rgba(100,116,139,.35)', textAlign: 'right',
      }}>
        {lines.map((_, i) => (
          <div key={i} style={{ padding: '0 8px 0 0', fontFamily: '"Fira Code", monospace', fontSize: 10 }}>{i + 1}</div>
        ))}
      </div>
      {/* Editor */}
      <textarea
        ref={taRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        spellCheck={false}
        style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: '#e2e8f0', fontFamily: '"Fira Code", monospace', fontSize: 11,
          lineHeight: '17px', padding: '10px 14px', resize: 'none',
          whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto',
          caretColor: '#c6f135',
        }}
      />
    </div>
  );
}

// ─── SplitPane ────────────────────────────────────────────────────────────────

function SplitPane({ left, right, splitPct, onDrag }: {
  left: React.ReactNode; right: React.ReactNode;
  splitPct: number; onDrag: (p: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging     = useRef(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const move = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      onDrag(Math.min(72, Math.max(18, ((ev.clientX - rect.left) / rect.width) * 100)));
    };
    const up = () => { dragging.current = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ width: `${splitPct}%`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>{left}</div>
      <div
        onMouseDown={onMouseDown}
        style={{ width: 4, flexShrink: 0, background: 'rgba(198,241,53,.07)', cursor: 'col-resize', transition: 'background .1s' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(198,241,53,.3)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(198,241,53,.07)')}
      />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>{right}</div>
    </div>
  );
}

// ─── RequiredKeysStrip ────────────────────────────────────────────────────────

function RequiredKeysStrip({ rows }: { rows: ParsedRow[] }) {
  const present = new Set<string>();
  rows.slice(0, 20).forEach(r => REQUIRED_PARSER_KEYS.forEach(k => { if (r[k] != null) present.add(k); }));
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '7px 12px', background: 'rgba(0,0,0,.2)', borderBottom: '1px solid rgba(255,255,255,.06)', flexShrink: 0 }}>
      {REQUIRED_PARSER_KEYS.map(k => {
        const ok = present.has(k);
        return (
          <span key={k} style={{
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: .5,
            padding: '2px 7px',
            background: ok ? 'rgba(198,241,53,.07)' : 'rgba(248,113,113,.07)',
            border: `1px solid ${ok ? 'rgba(198,241,53,.25)' : 'rgba(248,113,113,.25)'}`,
            color: ok ? '#c6f135' : '#f87171',
          }}>
            {ok ? '✓' : '✗'} {k}
          </span>
        );
      })}
    </div>
  );
}

// ─── MarketCoveragePanel ──────────────────────────────────────────────────────

function MarketCoveragePanel({ coverage }: { coverage: MarketCoverageResult }) {
  const [tab, setTab] = useState<'missing'|'present'|'extra'>('missing');
  const pct = Math.round(coverage.coverage_pct);
  const ok  = coverage.ok;

  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,.06)', background: 'rgba(0,0,0,.15)' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: ok ? '#c6f135' : '#f87171' }}>MARKET COVERAGE</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: ok ? '#c6f135' : '#fb923c' }}>{coverage.coverage_pct.toFixed(1)}%</span>
        {/* Bar */}
        <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,.07)', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: ok ? '#c6f135' : '#fb923c', transition: 'width .4s ease' }} />
          <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: 1, background: 'rgba(255,255,255,.25)' }} />
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.5)' }}>
          {coverage.present_count}/{coverage.expected_count}
        </span>
        {coverage.sport && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(100,116,139,.4)', letterSpacing: 1 }}>{coverage.sport}</span>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,.05)' }}>
        {([['missing', coverage.missing_markets.length], ['present', coverage.present_markets.length], ['extra', coverage.extra_markets.length]] as const).map(([t, count]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? '#c6f135' : 'transparent'}`,
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5,
            padding: '5px 10px', cursor: 'pointer',
            color: tab === t ? '#c6f135' : 'rgba(100,116,139,.45)',
          }}>{t.toUpperCase()} ({count})</button>
        ))}
        {coverage.warnings.length > 0 && (
          <div style={{ marginLeft: 'auto', padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 7, color: '#fb923c', display: 'flex', alignItems: 'center' }}>
            ⚠ {coverage.warnings.length} warn
          </div>
        )}
      </div>

      {/* Tag cloud */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '6px 12px 8px', maxHeight: 72, overflowY: 'auto' }}>
        {tab === 'missing' && coverage.missing_markets.map((m, i) => {
          const slug = typeof m === 'string' ? m : m.slug;
          return <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 6px', background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.2)', color: '#fca5a5' }}>{slug}</span>;
        })}
        {tab === 'present' && coverage.present_markets.map((m, i) => (
          <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 6px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.18)', color: '#c6f135' }}>{m}</span>
        ))}
        {tab === 'extra' && coverage.extra_markets.map((m, i) => (
          <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 6px', background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.2)', color: '#fb923c' }}>{m}</span>
        ))}
        {((tab === 'missing' && !coverage.missing_markets.length) ||
          (tab === 'present' && !coverage.present_markets.length) ||
          (tab === 'extra'   && !coverage.extra_markets.length)) && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(100,116,139,.35)' }}>none</span>
        )}
      </div>
    </div>
  );
}

// ─── ParserResultsTable ───────────────────────────────────────────────────────

const thS: React.CSSProperties = {
  fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5,
  padding:'6px 10px', textAlign:'left', borderBottom:'1px solid rgba(255,255,255,.08)',
  whiteSpace:'nowrap', fontWeight:400, position:'sticky', top:0, background:'#0a0f0a',
};
const tdS: React.CSSProperties = {
  fontFamily:'"Fira Code", monospace', fontSize:9,
  padding:'4px 10px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
};

function ParserResultsTable({ result }: { result: ParserTestResult }) {
  const rows       = result.rows.slice(0, 60);
  const allKeys    = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const reqKeys    = REQUIRED_PARSER_KEYS.filter(k => allKeys.includes(k));
  const extraKeys  = allKeys.filter(k => !(REQUIRED_PARSER_KEYS as readonly string[]).includes(k));
  const displayKeys = [...reqKeys, ...extraKeys];

  const colColor = (k: string) => {
    if (['home_team','away_team'].includes(k)) return '#34d399';
    if (['market','market_name'].includes(k))  return '#06b6d4';
    if (['selection','selection_name'].includes(k)) return '#38bdf8';
    if (k === 'price')   return '#fb923c';
    if (['parent_match_id','match_id'].includes(k)) return '#c6f135';
    if (k === 'start_time') return '#94a3b8';
    if (['sport','competition'].includes(k)) return '#8b5cf6';
    if (k === 'specifier') return '#64748b';
    return '#94a3b8';
  };

  if (rows.length === 0) return (
    <div style={{ padding:20, textAlign:'center', fontFamily:'var(--font-mono)', fontSize:9, color:'rgba(100,116,139,.35)' }}>No rows returned</div>
  );

  return (
    <div style={{ flex:1, overflow:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...thS, color:'rgba(100,116,139,.35)' }}>#</th>
            {displayKeys.map(k => <th key={k} style={{ ...thS, color: colColor(k) }}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}
              style={{ borderBottom:'1px solid rgba(255,255,255,.025)' }}
              onMouseEnter={e => (e.currentTarget.style.background='rgba(255,255,255,.02)')}
              onMouseLeave={e => (e.currentTarget.style.background='transparent')}
            >
              <td style={{ ...tdS, color:'rgba(100,116,139,.3)' }}>{i + 1}</td>
              {displayKeys.map(k => {
                const v = row[k];
                return (
                  <td key={k} style={{ ...tdS, color: typeof v === 'number' ? '#fb923c' : '#cbd5e1', maxWidth:180 }} title={String(v ?? '')}>
                    {v == null ? <span style={{ color:'rgba(100,116,139,.3)' }}>—</span> : String(v).slice(0,45)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > 60 && (
        <div style={{ padding:'6px 12px', fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.4)', textAlign:'center', borderTop:'1px solid rgba(255,255,255,.04)' }}>
          … and {result.rows.length - 60} more rows
        </div>
      )}
    </div>
  );
}

// ─── WorkflowParserPane ───────────────────────────────────────────────────────

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

  const copyToClipboard = (val: unknown, label: string) => {
    navigator.clipboard.writeText(JSON.stringify(val, null, 2));
    setCopyFlash(label);
    setTimeout(() => setCopyFlash(null), 1800);
  };
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

  // On workflow change — load saved code & regenerate sample
  useEffect(() => {
    setLoading(true);
    setTestResult(null);
    setTestStatus('idle');

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

  // Consume direct "use this as sample" override from a per-step probe
  useEffect(() => {
    if (sampleOverride == null) return;
    setSampleJson(JSON.stringify(sampleOverride, null, 2));
    setLiveFlash(true);
    setTimeout(() => setLiveFlash(false), 4000);
    setJsonTab('tree');
    onSampleOverrideConsumed?.();
  }, [sampleOverride]);

  // Auto-populate sampleJson from live probe results
  useEffect(() => {
    if (!probeData || Object.keys(probeData).length === 0) return;

    const sorted = [...workflow.steps].sort((a, b) => a.position - b.position);

    if (sorted.length === 0) return;

    // Build merged sample using actual probe responses, mirroring buildSampleFromSteps shape
    const merged: Record<string, unknown> = {};
    sorted.forEach((step, idx) => {
      const raw = probeData[step.position];
      if (raw === undefined) return;
      if (idx === 0) {
        // First step: merge its response at root
        if (Array.isArray(raw)) {
          // If the response is an array, wrap it under the result_array_path key or "events"
          const key = step.result_array_path || 'events';
          merged[key] = raw.slice(0, 5);
        } else if (raw && typeof raw === 'object') {
          Object.assign(merged, raw);
        }
      } else {
        // Subsequent steps: nest under a key derived from step name
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
      if (!res.ok || res.parsed == null) {
        setImportError(res.error || `HTTP ${res.status} — no parseable JSON returned`);
      }
    } catch (e: any) {
      setImportError(e.message);
      setImportProbeResult({ ok: false, status: null, parsed: null, latency_ms: 0, error: e.message });
    }
    setImportProbing(false);
  };

  // Pre-fill URL from step 1 of current workflow
  const prefillStepUrl = () => {
    const s1 = [...workflow.steps].sort((a, b) => a.position - b.position)[0];
    if (s1?.url_template && !s1.url_template.includes('{{')) {
      setImportUrl(s1.url_template);
      // Pre-fill headers from step
      if (s1.headers && Object.keys(s1.headers).length > 0)
        setImportHeaders(JSON.stringify(s1.headers, null, 2));
    }
  };

  const importJson = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { setImportError('Paste some JSON first'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch {
      setImportError('Invalid JSON — check for syntax errors');
      return;
    }
    // If the pasted text looks like a probe response object, unwrap it
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Research endpoint probe returns { ok, parsed, response_raw, … }
      if ('parsed' in obj && obj.parsed !== null && obj.parsed !== undefined) {
        parsed = obj.parsed;
      } else if ('response' in obj && obj.response !== null) {
        parsed = obj.response;
      }
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

  const canSave  = testStatus === 'ok' || testStatus === 'coverage_warn';
  const sampleData = (() => { try { return JSON.parse(sampleJson); } catch { return null; } })();
  const uniqueMarkets  = testResult ? new Set(testResult.rows.map(r => r.market)).size : 0;
  const uniqueMatches  = testResult ? new Set(testResult.rows.map(r => r.parent_match_id)).size : 0;

  if (loading) return (
    <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'#080d08' }}>
      <span style={{ fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'rgba(198,241,53,.3)' }}>LOADING PARSER…</span>
    </div>
  );

  // ── Import overlay ─────────────────────────────────────────────────────────
  const importOverlay = importOpen ? (
    <div style={{
      position:'absolute', inset:0, zIndex:500,
      background:'rgba(0,0,0,.85)', display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      <div style={{ width:580, background:'#0c150c', border:'1px solid rgba(198,241,53,.3)', boxShadow:'0 24px 64px rgba(0,0,0,.8)', display:'flex', flexDirection:'column' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,.07)' }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, color:'#c6f135' }}>↓ IMPORT SAMPLE JSON</span>
          <div style={{ flex:1 }} />
          <button onClick={() => setImportOpen(false)} style={{ background:'none', border:'none', color:'rgba(100,116,139,.5)', cursor:'pointer', fontSize:18, padding:0, lineHeight:1 }}>✕</button>
        </div>

        {/* Mode tabs */}
        <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,.06)' }}>
          {(['url', 'paste'] as const).map(m => (
            <button key={m} onClick={() => { setImportMode(m); setImportError(''); setImportProbeResult(null); }}
              style={{
                background:'none', border:'none',
                borderBottom:`2px solid ${importMode===m?'#c6f135':'transparent'}`,
                marginBottom:-1, fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2,
                padding:'9px 16px', cursor:'pointer',
                color: importMode===m?'#c6f135':'rgba(100,116,139,.5)',
              }}
            >
              {m==='url'?'▶ PROBE URL':'⌅ PASTE JSON'}
            </button>
          ))}
        </div>

        {/* ── URL probe mode ───────────────────────────────────────────── */}
        {importMode==='url' && (
          <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
            <div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.6)', marginBottom:5 }}>
                URL  <span style={{ color:'rgba(6,182,212,.5)', cursor:'pointer' }} onClick={prefillStepUrl}>— click to pre-fill from step 1</span>
              </div>
              <input
                autoFocus
                value={importUrl}
                onChange={e => { setImportUrl(e.target.value); setImportError(''); setImportProbeResult(null); }}
                onKeyDown={e => e.key==='Enter' && probeImport()}
                placeholder="https://bookmaker.com/api/events?count=10&partner=61"
                style={{
                  ...iS.input, width:'100%', boxSizing:'border-box',
                  fontFamily:'"Fira Code",monospace', fontSize:10,
                  border:`1px solid ${importError?'rgba(248,113,113,.4)':'rgba(255,255,255,.1)'}`,
                }}
              />
            </div>
            <div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.6)', marginBottom:5 }}>HEADERS (JSON) — include auth tokens, x-hd, etc.</div>
              <textarea
                value={importHeaders}
                onChange={e => { setImportHeaders(e.target.value); setImportError(''); }}
                placeholder='{"x-hd":"…","x-app-n":"…"}'
                spellCheck={false}
                style={{
                  width:'100%', height:80, background:'rgba(255,255,255,.03)',
                  border:'1px solid rgba(255,255,255,.08)',
                  color:'#86efac', fontFamily:'"Fira Code",monospace', fontSize:9,
                  padding:'7px 10px', outline:'none', resize:'vertical', lineHeight:1.5, boxSizing:'border-box',
                }}
              />
            </div>

            {/* Probe result preview */}
            {importProbeResult && (
              <div style={{ border:`1px solid ${importProbeResult.ok?'rgba(198,241,53,.2)':'rgba(248,113,113,.2)'}`, background:'rgba(0,0,0,.3)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderBottom:'1px solid rgba(255,255,255,.05)' }}>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, color:importProbeResult.ok?'#c6f135':'#f87171' }}>
                    {importProbeResult.ok?'✓ GOT RESPONSE':'✗ FAILED'}
                  </span>
                  {importProbeResult.status && (
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:importProbeResult.ok?'#c6f135':'#f87171', border:`1px solid ${importProbeResult.ok?'rgba(198,241,53,.3)':'rgba(248,113,113,.3)'}`, padding:'1px 6px' }}>
                      {importProbeResult.status}
                    </span>
                  )}
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.5)' }}>{importProbeResult.latency_ms}ms</span>
                  {importProbeResult.ok && importProbeResult.parsed != null && (
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(198,241,53,.6)', marginLeft:'auto' }}>
                      {Array.isArray(importProbeResult.parsed)
                        ? `${(importProbeResult.parsed as unknown[]).length} items`
                        : typeof importProbeResult.parsed==='object'?'object':''}
                    </span>
                  )}
                </div>
                {importProbeResult.ok && importProbeResult.parsed != null && (
                  <div style={{ maxHeight:120, overflow:'auto', padding:'8px 10px' }}>
                    <JsonNode
                      k={null} v={importProbeResult.parsed} depth={0}
                      onSelect={(selected) => {
                        importJson(JSON.stringify(selected));
                      }}
                      onCopy={(val, path) => {
                        navigator.clipboard.writeText(JSON.stringify(val, null, 2));
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {importError && (
              <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#f87171' }}>✗ {importError}</div>
            )}

            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:2 }}>
              <button onClick={() => setImportOpen(false)} style={iS.cancelBtn}>Cancel</button>
              <button
                onClick={probeImport}
                disabled={importProbing || !importUrl.trim()}
                style={{
                  padding:'7px 16px', background:'rgba(6,182,212,.08)', border:'1px solid rgba(6,182,212,.4)',
                  color:'#06b6d4', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1,
                  cursor: importProbing||!importUrl.trim()?'not-allowed':'pointer',
                  opacity: !importUrl.trim()?0.4:1,
                }}
              >
                {importProbing?'PROBING…':'▶ PROBE'}
              </button>
              <button
                onClick={() => { if (importProbeResult?.parsed != null) importJson(JSON.stringify(importProbeResult.parsed)); }}
                disabled={!importProbeResult?.ok || importProbeResult?.parsed == null}
                style={{
                  padding:'7px 18px',
                  background: (importProbeResult?.ok && importProbeResult?.parsed != null)?'#c6f135':'rgba(100,116,139,.1)',
                  color: (importProbeResult?.ok && importProbeResult?.parsed != null)?'#0a0a0a':'rgba(100,116,139,.35)',
                  border:'none', fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, letterSpacing:1,
                  cursor: (importProbeResult?.ok && importProbeResult?.parsed != null)?'pointer':'not-allowed',
                }}
              >
                ↳ USE AS SAMPLE
              </button>
            </div>
          </div>
        )}

        {/* ── Paste mode ───────────────────────────────────────────────── */}
        {importMode==='paste' && (
          <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.6)', lineHeight:1.7 }}>
              Paste raw JSON — from Research endpoint tester, curl, or browser devtools.<br/>
              <span style={{ color:'rgba(198,241,53,.5)' }}>Probe envelopes are auto-unwrapped to extract the data.</span>
            </div>
            <textarea
              autoFocus
              value={importRaw}
              onChange={e => { setImportRaw(e.target.value); setImportError(''); }}
              onKeyDown={e => { if (e.key==='Enter' && (e.metaKey||e.ctrlKey)) importJson(importRaw); }}
              placeholder="Paste JSON here…"
              spellCheck={false}
              style={{
                width:'100%', height:200, background:'rgba(255,255,255,.03)',
                border:`1px solid ${importError?'rgba(248,113,113,.4)':'rgba(255,255,255,.1)'}`,
                color:'#86efac', fontFamily:'"Fira Code",monospace', fontSize:10,
                padding:'10px 12px', outline:'none', resize:'vertical', lineHeight:1.55, boxSizing:'border-box',
              }}
            />
            {importError && (
              <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#f87171' }}>✗ {importError}</div>
            )}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button onClick={() => setImportOpen(false)} style={iS.cancelBtn}>Cancel</button>
              <button
                onClick={() => importJson(importRaw)}
                disabled={!importRaw.trim()}
                style={{ padding:'7px 18px', background:importRaw.trim()?'#c6f135':'rgba(100,116,139,.1)', color:importRaw.trim()?'#0a0a0a':'rgba(100,116,139,.35)', border:'none', fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, letterSpacing:1, cursor:importRaw.trim()?'pointer':'not-allowed' }}
              >
                ↳ USE AS SAMPLE  <span style={{ fontWeight:400, opacity:.6, fontSize:8 }}>Ctrl+Enter</span>
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  ) : null;

  // ── JSON panel (left) ───────────────────────────────────────────────────────
  const jsonPanel = (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#060b06' }}>
      {/* Header */}
      <div style={{ padding:'9px 12px', borderBottom:'1px solid rgba(255,255,255,.06)', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'#06b6d4' }}>SAMPLE JSON</span>
        {liveFlash && (
          <span style={{
            fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5,
            padding:'2px 8px', background:'rgba(198,241,53,.1)',
            border:'1px solid rgba(198,241,53,.4)', color:'#c6f135',
            animation:'fadeOut 4s forwards',
          }}>
            ⚡ LIVE DATA
          </span>
        )}
        {copyFlash && (
          <span style={{
            fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1,
            padding:'2px 8px', background:'rgba(6,182,212,.1)',
            border:'1px solid rgba(6,182,212,.4)', color:'#67e8f9',
            animation:'fadeOut 1.8s forwards',
          }}>
            ⎘ {copyFlash}
          </span>
        )}
        <div style={{ flex:1 }} />
        {(['tree','raw'] as const).map(t => (
          <button key={t} onClick={() => setJsonTab(t)} style={{
            background:'none', border:'none', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2,
            padding:'2px 8px', cursor:'pointer',
            color: jsonTab === t ? '#06b6d4' : 'rgba(100,116,139,.45)',
            borderBottom: `1px solid ${jsonTab === t ? '#06b6d4' : 'transparent'}`,
          }}>{t.toUpperCase()}</button>
        ))}
        {/* Select-subtree toggle */}
        <button
          onClick={() => { setSelectMode(s => !s); setJsonTab('tree'); }}
          title="Toggle select mode — hover any node and click ↳ USE to use that subtree as sample"
          style={{
            background: selectMode ? 'rgba(198,241,53,.15)' : 'none',
            border: `1px solid ${selectMode ? 'rgba(198,241,53,.6)' : 'rgba(255,255,255,.1)'}`,
            color: selectMode ? '#c6f135' : 'rgba(100,116,139,.45)',
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
            padding: '3px 8px', cursor: 'pointer',
            transition: 'all .15s',
          }}
        >{selectMode ? '✂ SELECTING…' : '✂ SELECT'}</button>
        <button
          onClick={() => setSampleJson(JSON.stringify(buildSampleFromSteps(workflow.steps), null, 2))}
          style={{ background:'none', border:'1px solid rgba(6,182,212,.2)', color:'rgba(6,182,212,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 8px', cursor:'pointer' }}
          title="Regenerate sample from step field definitions"
        >↺ REGEN</button>
        <button
          onClick={() => { if (sampleData !== null) copyToClipboard(sampleData, 'COPIED'); }}
          disabled={sampleData === null}
          style={{ background:'none', border:'1px solid rgba(6,182,212,.2)', color:'rgba(6,182,212,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 8px', cursor:'pointer', opacity: sampleData===null?0.3:1 }}
          title="Copy full sample JSON to clipboard"
        >⎘ COPY</button>
        <button
          onClick={() => {
            setImportRaw(''); setImportError(''); setImportProbeResult(null);
            // pre-fill URL from first step that has no template vars
            const s1 = [...workflow.steps].sort((a,b)=>a.position-b.position).find(s=>s.url_template&&!s.url_template.includes('{{'));
            if (s1) { setImportUrl(s1.url_template); if (s1.headers&&Object.keys(s1.headers).length>0) setImportHeaders(JSON.stringify(s1.headers,null,2)); }
            setImportOpen(true);
          }}
          style={{ background:'rgba(198,241,53,.06)', border:'1px solid rgba(198,241,53,.3)', color:'#c6f135', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'3px 9px', cursor:'pointer' }}
          title="Paste JSON from research endpoint, curl, or devtools"
        >↓ IMPORT</button>
      </div>

      {/* JSON content */}
      <div style={{ flex:1, overflow:'auto', padding:'10px 12px' }}>
        {/* Select mode instruction banner */}
        {selectMode && jsonTab === 'tree' && (
          <div style={{
            marginBottom: 8, padding: '6px 10px',
            background: 'rgba(198,241,53,.07)', border: '1px solid rgba(198,241,53,.3)',
            fontFamily: 'var(--font-mono)', fontSize: 8, color: '#c6f135', lineHeight: 1.6,
          }}>
            Hover any key or value → click <strong>↳ USE</strong> to use that subtree as sample.
            <button onClick={() => setSelectMode(false)} style={{ float:'right', background:'none', border:'none', color:'rgba(100,116,139,.5)', cursor:'pointer', fontSize:11, padding:0, lineHeight:1 }}>✕</button>
          </div>
        )}
        {jsonTab === 'tree' ? (
          sampleData !== null
            ? <JsonNode
                k={null} v={sampleData} depth={0}
                onSelect={selectMode ? (selected, path) => {
                  setSampleJson(JSON.stringify(selected, null, 2));
                  setLiveFlash(true);
                  setTimeout(() => setLiveFlash(false), 4000);
                  setSelectMode(false);
                } : undefined}
                onCopy={(val, path) => copyToClipboard(val, path ? `COPIED .${path}` : 'COPIED')}
              />
            : <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'#f87171' }}>⚠ Invalid JSON — switch to RAW to fix</div>
        ) : (
          <textarea
            value={sampleJson}
            onChange={e => setSampleJson(e.target.value)}
            style={{
              width:'100%', height:'100%', minHeight:200, background:'transparent',
              border:'none', outline:'none', color:'#86efac',
              fontFamily:'"Fira Code", monospace', fontSize:10, resize:'none', lineHeight:1.65,
            }}
            spellCheck={false}
          />
        )}
      </div>

      {/* Field inventory */}
      <div style={{ borderTop:'1px solid rgba(255,255,255,.06)', padding:'9px 12px', maxHeight:150, overflowY:'auto', flexShrink:0, background:'rgba(0,0,0,.25)' }}>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(100,116,139,.4)', marginBottom:7 }}>FIELD INVENTORY</div>
        {workflow.steps.length === 0 && (
          <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.3)' }}>No steps — add steps in the STEPS tab</div>
        )}
        {[...workflow.steps].sort((a,b) => a.position - b.position).map(step => (
          <div key={step.id} style={{ marginBottom:8 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color: STEP_TYPE_META[step.step_type]?.color ?? '#c6f135', marginBottom:4, display:'flex', alignItems:'center', gap:6 }}>
              <span>{STEP_TYPE_META[step.step_type]?.icon}</span>
              <span style={{ fontWeight:600 }}>Step {step.position}</span>
              <span style={{ color:'rgba(100,116,139,.5)', fontWeight:400 }}>· {step.name}</span>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, paddingLeft:14 }}>
              {step.fields.map((f, fi) => (
                <span key={fi} title={`path: ${f.path}`} style={{
                  fontFamily:'var(--font-mono)', fontSize:7, padding:'1px 6px',
                  background: `${roleColor(f.role)}14`,
                  border: `1px solid ${roleColor(f.role)}40`,
                  color: roleColor(f.role),
                }}>
                  {f.path} <span style={{ opacity:.45 }}>→</span> {f.role}
                </span>
              ))}
              {step.fields.length === 0 && (
                <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'rgba(100,116,139,.3)', fontStyle:'italic' }}>no fields mapped</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Editor panel (right) ────────────────────────────────────────────────────
  const editorPanel = (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#050a05' }}>
      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', borderBottom:'1px solid rgba(255,255,255,.06)', background:'rgba(0,0,0,.3)', flexShrink:0 }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'rgba(100,116,139,.6)' }}>PARSE_DATA.PY</span>
        <div style={{ flex:1 }} />
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, color: statusMeta.color, transition:'color .2s' }}>
          {statusMeta.label}
        </span>
        <button
          onClick={() => { setCode(generateParserTemplate(workflow.steps)); setTestStatus('idle'); setTestResult(null); }}
          title="Regenerate parser template from step field roles"
          style={{ background:'none', border:'1px solid rgba(255,255,255,.1)', color:'rgba(100,116,139,.55)', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, padding:'4px 9px', cursor:'pointer' }}
        >↺ REGEN</button>
        <button
          onClick={runTest}
          disabled={testStatus === 'running'}
          style={{
            background: testStatus === 'running' ? 'rgba(251,146,60,.08)' : 'rgba(198,241,53,.08)',
            border:`1px solid ${testStatus === 'running' ? 'rgba(251,146,60,.4)' : 'rgba(198,241,53,.35)'}`,
            color: testStatus === 'running' ? '#fb923c' : '#c6f135',
            fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1.5,
            padding:'5px 14px', cursor: testStatus === 'running' ? 'not-allowed' : 'pointer',
          }}
        >▶ TEST</button>
        <button
          onClick={save}
          disabled={!canSave || saveStatus === 'saving'}
          title={!canSave ? 'Run test first — must pass to save' : 'Save parser code'}
          style={{
            background: canSave ? '#c6f135' : 'rgba(100,116,139,.08)',
            border: canSave ? 'none' : '1px solid rgba(100,116,139,.2)',
            color: canSave ? '#0a0a0a' : 'rgba(100,116,139,.35)',
            fontFamily:'var(--font-mono)', fontSize:8, fontWeight:700, letterSpacing:1.5,
            padding:'5px 14px', cursor: canSave ? 'pointer' : 'not-allowed', transition:'all .15s',
          }}
        >
          {saveStatus === 'saving' ? 'SAVING…' : saveStatus === 'saved' ? '✓ SAVED' : saveStatus === 'error' ? '✗ ERROR' : 'SAVE'}
        </button>
      </div>

      {/* Code editor */}
      <div style={{
        flex: testResult ? '0 0 42%' : 1,
        overflow:'hidden', display:'flex', flexDirection:'column',
        minHeight: testResult ? 120 : undefined,
      }}>
        <CodeEditor value={code} onChange={v => { setCode(v); if (testStatus !== 'idle') setTestStatus('idle'); }} />
      </div>

      {/* Results panel */}
      {testResult && (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderTop:'2px solid rgba(255,255,255,.06)' }}>
          {/* Summary bar */}
          <div style={{
            display:'flex', alignItems:'center', gap:10, padding:'6px 12px', flexShrink:0,
            background: testResult.ok ? 'rgba(198,241,53,.04)' : 'rgba(248,113,113,.04)',
            borderBottom:'1px solid rgba(255,255,255,.05)',
          }}>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, color: testResult.ok ? '#c6f135' : '#f87171' }}>
              {testResult.ok ? '✓' : '✗'} {testResult.ok ? `${testResult.row_count} rows · ${testResult.valid_count} valid` : 'PARSE ERROR'}
            </span>
            {testResult.ok && uniqueMarkets > 0 && (
              <>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(6,182,212,.7)', border:'1px solid rgba(6,182,212,.2)', padding:'1px 7px' }}>{uniqueMarkets} markets</span>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.6)', border:'1px solid rgba(255,255,255,.08)', padding:'1px 7px' }}>{uniqueMatches} matches</span>
              </>
            )}
            <div style={{ flex:1 }} />
            <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.4)' }}>{testResult.elapsed_ms}ms</span>
          </div>

          {/* Required keys */}
          {testResult.rows.length > 0 && <RequiredKeysStrip rows={testResult.rows} />}

          {/* Validation errors */}
          {testResult.validation_errors.length > 0 && (
            <div style={{ padding:'6px 12px', background:'rgba(248,113,113,.04)', borderBottom:'1px solid rgba(248,113,113,.12)', flexShrink:0 }}>
              {testResult.validation_errors.slice(0,4).map((e, i) => (
                <div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#fca5a5', lineHeight:1.6 }}>✗ {e}</div>
              ))}
              {testResult.validation_errors.length > 4 && (
                <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(248,113,113,.4)' }}>… +{testResult.validation_errors.length - 4} more</div>
              )}
            </div>
          )}

          {/* Warnings */}
          {testResult.warnings && testResult.warnings.length > 0 && (
            <div style={{ padding:'5px 12px', background:'rgba(251,146,60,.03)', borderBottom:'1px solid rgba(251,146,60,.1)', flexShrink:0 }}>
              {testResult.warnings.slice(0,2).map((w, i) => (
                <div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'#fbbf24' }}>⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Content: rows table OR error traceback */}
          {testResult.ok && testResult.rows.length > 0 ? (
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <ParserResultsTable result={testResult} />
              {testResult.market_coverage && <MarketCoveragePanel coverage={testResult.market_coverage} />}
            </div>
          ) : !testResult.ok && testResult.error ? (
            <div style={{ flex:1, overflow:'auto', padding:'12px 14px', background:'rgba(248,113,113,.03)' }}>
              <pre style={{ margin:0, fontFamily:'"Fira Code", monospace', fontSize:10, color:'#fca5a5', whiteSpace:'pre-wrap', lineHeight:1.55 }}>
                {testResult.error}
              </pre>
            </div>
          ) : (
            <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'rgba(100,116,139,.35)' }}>Parser returned 0 rows</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ position:'relative', display:'flex', flex:1, overflow:'hidden' }}>
      {importOverlay}
      <SplitPane
        left={jsonPanel}
        right={editorPanel}
        splitPct={splitPct}
        onDrag={setSplitPct}
      />
    </div>
  );
}

// ─── WorkflowDetail — tabbed wrapper ──────────────────────────────────────────

function WorkflowDetail({ workflow, roles, onUpdated }: {
  workflow: Workflow; roles: FieldRole[]; onUpdated: (wf: Workflow) => void;
}) {
  const [tab, setTab] = useState<'steps'|'parser'>('steps');
  const hasSavedParser = workflow.steps.some(s => s.parser_code);
  const parserPassed   = workflow.steps.some(s => s.parser_test_passed);
  const [probeData,           setProbeData]           = useState<Record<number, unknown>>({});
  const [parserSampleOverride,setParserSampleOverride] = useState<unknown | null>(null);

  const handleProbeComplete = (rawByPos: Record<number, unknown>) => {
    setProbeData(rawByPos);
  };

  const handleUseAsParserSample = (raw: unknown) => {
    setParserSampleOverride(raw);
    setTab('parser');
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* Tab strip */}
      <div style={{ display:'flex', alignItems:'center', borderBottom:'1px solid rgba(255,255,255,.07)', flexShrink:0, background:'#060b06', paddingLeft:28 }}>
        {([
          ['steps',  '◈ STEPS'],
          ['parser', '⟩_ PARSER'],
        ] as const).map(([t, lbl]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background:'none', border:'none',
            borderBottom:`2px solid ${tab === t ? '#c6f135' : 'transparent'}`,
            marginBottom:-1, fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2,
            padding:'11px 18px', cursor:'pointer',
            color: tab === t ? '#c6f135' : 'rgba(100,116,139,.5)',
          }}>{lbl}</button>
        ))}
        <div style={{ flex:1 }} />
        {/* Parser status badge */}
        {hasSavedParser && (
          <span style={{
            fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5,
            padding:'3px 10px', marginRight:16,
            background: parserPassed ? 'rgba(198,241,53,.07)' : 'rgba(251,146,60,.07)',
            border:`1px solid ${parserPassed ? 'rgba(198,241,53,.25)' : 'rgba(251,146,60,.25)'}`,
            color: parserPassed ? '#c6f135' : '#fb923c',
          }}>
            {parserPassed ? '✓ PARSER OK' : '⚠ PARSER SAVED'}
          </span>
        )}
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.3)', letterSpacing:1, paddingRight:20 }}>
          {workflow.steps.length} step{workflow.steps.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Tab content */}
      <div style={{
        flex:1, overflow: tab === 'steps' ? 'auto' : 'hidden',
        display:'flex', flexDirection:'column',
      }}>
        {tab === 'steps' && (
          <div style={{ padding:'28px 36px' }}>
            <WorkflowCanvas workflow={workflow} roles={roles} onUpdated={onUpdated} onProbeComplete={handleProbeComplete} onOpenParserTab={() => setTab('parser')} onUseAsParserSample={handleUseAsParserSample} />
          </div>
        )}
        {tab === 'parser' && <WorkflowParserPane workflow={workflow} probeData={probeData} sampleOverride={parserSampleOverride} onSampleOverrideConsumed={() => setParserSampleOverride(null)} />}
      </div>
    </div>
  );
}

// ─── WorkflowTestPanel ────────────────────────────────────────────────────────

interface StepRun {
  stepId: number; stepPos: number; stepName: string; stepType: string;
  status: 'pending'|'running'|'ok'|'error'|'skipped';
  resolvedUrl: string; httpStatus: number | null; latency_ms: number | null;
  itemCount: number; items: unknown[]; fieldRows: Record<string, string>[];
  error: string | null; rawSize: number; subRuns: SubRun[];
  rawResponse: unknown | null;
}
interface SubRun {
  index: number; resolvedUrl: string; httpStatus: number | null; latency_ms: number | null;
  itemCount: number; item: unknown; fieldRows: Record<string, string>[]; error: string | null;
}

function WorkflowTestPanel({ workflow, onClose, onProbeComplete, onOpenParser }: { workflow: Workflow; onClose: () => void; onProbeComplete?: (rawByPos: Record<number, unknown>) => void; onOpenParser?: () => void }) {
  const sorted = [...workflow.steps].sort((a, b) => a.position - b.position);
  const makeInit = (): StepRun[] => sorted.map(s => ({
    stepId:s.id, stepPos:s.position, stepName:s.name, stepType:s.step_type,
    status:'pending', resolvedUrl:'', httpStatus:null, latency_ms:null,
    itemCount:0, items:[], fieldRows:[], error:null, rawSize:0, subRuns:[],
    rawResponse: null,
  }));

  const [results,  setResults]  = useState<StepRun[]>(makeInit);
  const [running,  setRunning]  = useState(false);
  const [done,     setDone]     = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [activeTab,setActiveTab]= useState<Record<number,'fields'|'raw'|'subs'>>({});
  const [subLimits,setSubLimits]= useState<Record<number, number>>({});
  const abortRef = useRef<AbortController | null>(null);

  const upd      = (pos: number, p: Partial<StepRun>) => setResults(prev => prev.map(r => r.stepPos === pos ? { ...r, ...p } : r));
  const getTab   = (pos: number) => activeTab[pos] ?? 'fields';
  const setTab   = (pos: number, t: 'fields'|'raw'|'subs') => setActiveTab(p => ({ ...p, [pos]: t }));
  const getLimit = (pos: number) => subLimits[pos] ?? 3;

  const run = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setResults(makeInit()); setExpanded({}); setRunning(true); setDone(false);
    const stepItems: Record<number, unknown[]> = {};
    const rawByPos: Record<number, unknown> = {};

    for (const step of sorted) {
      const pos = step.position;
      upd(pos, { status:'running' });
      try {
        if (step.step_type === 'FETCH_LIST' || step.step_type === 'FETCH_ONCE') {
          const t0 = Date.now();
          const res = await apiFetch('/probe', {
            method:'POST', signal:ctrl.signal,
            body:JSON.stringify({ url:step.url_template, method:step.method, headers:step.headers??{}, params:step.params??{}, body:step.body_template||null }),
          });
          const ms = Date.now() - t0;
          if (!res.ok) { upd(pos,{ status:'error', error:res.error??'Probe failed', latency_ms:ms }); break; }
          const items     = extractArray(res.response, step.result_array_path??'');
          const fieldRows = items.slice(0,8).map(it => extractFields(it, step.fields));
          stepItems[pos]  = items;
          rawByPos[pos]   = res.response;
          upd(pos,{ status:'ok', resolvedUrl:step.url_template, httpStatus:res.status, latency_ms:ms, itemCount:items.length, items:items.slice(0,8), fieldRows, rawSize:res.size_bytes??0, rawResponse:res.response });
          setExpanded(p => ({ ...p, [pos]:true }));
        } else if (step.step_type === 'FETCH_PER_ITEM') {
          const parentItems = step.depends_on_pos != null ? (stepItems[step.depends_on_pos]??[]) : [];
          const limit = getLimit(pos);
          const toRun = parentItems.slice(0, limit);
          if (toRun.length === 0) { upd(pos,{ status:'error', error:`No items from step ${step.depends_on_pos}` }); break; }
          const subRuns: SubRun[] = [];
          let totalItems = 0;
          const allFieldRows: Record<string,string>[] = [];
          const allItems: unknown[] = [];
          for (let i = 0; i < toRun.length; i++) {
            const src = toRun[i] as Record<string,unknown>;
            const { url:rUrl, params:rParams } = resolveUrlTemplate(step.url_template, step.params??{}, step.field_mappings??{}, src);
            const t0 = Date.now();
            const res = await apiFetch('/probe', {
              method:'POST', signal:ctrl.signal,
              body:JSON.stringify({ url:rUrl, method:step.method, headers:step.headers??{}, params:rParams, body:step.body_template||null }),
            });
            const ms = Date.now() - t0;
            if (!res.ok) { subRuns.push({ index:i, resolvedUrl:rUrl, httpStatus:res.status, latency_ms:ms, itemCount:0, item:null, fieldRows:[], error:res.error??'Failed' }); continue; }
            const items     = extractArray(res.response, step.result_array_path??'');
            const fieldRows = items.slice(0,3).map(it => extractFields(it, step.fields));
            totalItems += items.length;
            allItems.push(...items.slice(0,3));
            allFieldRows.push(...fieldRows);
            subRuns.push({ index:i, resolvedUrl:rUrl, httpStatus:res.status, latency_ms:ms, itemCount:items.length, item:items[0]??null, fieldRows, error:null });
          }
          stepItems[pos] = allItems;
          // Store first successful sub-response as representative raw sample
          const firstOkSub = subRuns.find(sr => !sr.error);
          if (firstOkSub?.item !== undefined) rawByPos[pos] = firstOkSub.item;
          const anyFailed = subRuns.some(sr => sr.error);
          upd(pos,{ status:anyFailed?'error':'ok', resolvedUrl:`${toRun.length}× sub-requests`, httpStatus:null, latency_ms:subRuns.reduce((a,sr)=>a+(sr.latency_ms??0),0), itemCount:totalItems, items:allItems.slice(0,5), fieldRows:allFieldRows.slice(0,10), error:anyFailed?`${subRuns.filter(sr=>sr.error).length} sub-request(s) failed`:null, rawSize:0, subRuns, rawResponse:firstOkSub?.item??null });
          setExpanded(p => ({ ...p, [pos]:true }));
          setActiveTab(p => ({ ...p, [pos]:'subs' }));
        }
      } catch (e: any) {
        if (e.name === 'AbortError') { upd(pos,{ status:'skipped', error:'Aborted' }); break; }
        upd(pos,{ status:'error', error:e.message }); break;
      }
    }
    setRunning(false); setDone(true);
    if (Object.keys(rawByPos).length > 0) onProbeComplete?.(rawByPos);
  };

  const totalRows = results.reduce((a,r) => a + r.fieldRows.length, 0);
  const allOk     = done && results.filter(r => r.status !== 'pending').every(r => r.status === 'ok');
  const sm = (s: StepRun['status']) => ({ pending:{c:'#475569',icon:'○'}, running:{c:'#fb923c',icon:'⟳'}, ok:{c:'#c6f135',icon:'✓'}, error:{c:'#f87171',icon:'✗'}, skipped:{c:'#475569',icon:'—'} }[s]);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:2000, background:'rgba(0,0,0,.88)', display:'flex', flexDirection:'column' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 24px', background:'#060b06', borderBottom:'1px solid rgba(255,255,255,.08)', flexShrink:0 }}>
        <div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:3, color:'#c6f135' }}>▶ TEST WORKFLOW</div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.6)', marginTop:2, letterSpacing:1 }}>
            {workflow.name} · {sorted.length} step{sorted.length!==1?'s':''} · runs exactly as the harvest agent
          </div>
        </div>
        <div style={{ flex:1 }} />
        {done && (
          <>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, padding:'4px 12px', border:`1px solid ${allOk?'rgba(198,241,53,.4)':'rgba(248,113,113,.4)'}`, color:allOk?'#c6f135':'#f87171' }}>
              {allOk?`✓ ALL STEPS PASSED · ${totalRows} ROWS`:'✗ ERRORS DETECTED'}
            </span>
            {allOk && onOpenParser && (
              <button
                onClick={() => { onProbeComplete && void 0; onClose(); onOpenParser(); }}
                style={{ background:'rgba(198,241,53,.1)', border:'1px solid rgba(198,241,53,.5)', color:'#c6f135', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, padding:'6px 14px', cursor:'pointer' }}
                title="Close test panel and open the Parser tab (sample JSON will be auto-populated)"
              >⚡ OPEN PARSER</button>
            )}
          </>
        )}
        {!running
          ? <button onClick={run} style={{ background:'#c6f135', color:'#0a0a0a', border:'none', fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, letterSpacing:2, padding:'8px 22px', cursor:'pointer' }}>▶ {done?'RE-RUN':'RUN'}</button>
          : <button onClick={() => abortRef.current?.abort()} style={{ background:'transparent', border:'1px solid rgba(248,113,113,.4)', color:'#f87171', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'8px 20px', cursor:'pointer' }}>■ ABORT</button>
        }
        <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(100,116,139,.5)', cursor:'pointer', fontSize:22, padding:'0 4px', lineHeight:1 }}>✕</button>
      </div>

      {/* Body */}
      <div style={{ flex:1, overflowY:'auto', padding:'24px 28px', display:'flex', flexDirection:'column', gap:0 }}>
        {!running && !done && (
          <div style={{ padding:'48px', border:'1px dashed rgba(255,255,255,.07)', display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:36, color:'rgba(198,241,53,.12)' }}>▶</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:3, color:'rgba(100,116,139,.45)' }}>READY TO TEST</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'rgba(100,116,139,.3)', letterSpacing:1, textAlign:'center' as const }}>
              Will execute all {sorted.length} steps in sequence
            </span>
          </div>
        )}

        {(running||done) && results.map((r, idx) => {
          const stm = STEP_TYPE_META[r.stepType] ?? STEP_TYPE_META.FETCH_LIST;
          const exp = !!expanded[r.stepPos];
          const tab = getTab(r.stepPos);
          const headers = r.fieldRows[0] ? Object.keys(r.fieldRows[0]) : [];
          return (
            <div key={r.stepId}>
              {idx > 0 && <div style={{ paddingLeft:28, height:24 }}><div style={{ width:1, height:'100%', background: r.status==='ok'?'rgba(198,241,53,.2)':'rgba(255,255,255,.06)' }} /></div>}
              <div style={{ border:`1px solid ${r.status==='ok'?stm.color+'44':r.status==='error'?'rgba(248,113,113,.3)':'rgba(255,255,255,.07)'}`, background:'#0c150c' }}>
                <div onClick={() => r.status!=='pending' && setExpanded(p=>({...p,[r.stepPos]:!p[r.stepPos]}))}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', cursor:r.status!=='pending'?'pointer':'default', borderBottom:exp?'1px solid rgba(255,255,255,.06)':'none', background:r.status==='running'?'rgba(251,146,60,.04)':'transparent' }}>
                  <div style={{ width:26,height:26,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:`${stm.color}20`,border:`1px solid ${stm.color}55`,fontFamily:'var(--font-mono)',fontSize:10,fontWeight:800,color:stm.color }}>{r.stepPos}</div>
                  <span style={{ fontSize:14,color:sm(r.status).c,fontFamily:'var(--font-mono)',flexShrink:0,display:'inline-block',animation:r.status==='running'?'spin .7s linear infinite':'none' }}>{sm(r.status).icon}</span>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontFamily:'var(--font-mono)',fontSize:11,color:'#e2e8f0' }}>{r.stepName}</div>
                    <div style={{ fontFamily:'var(--font-mono)',fontSize:7,color:stm.color,letterSpacing:1.5,marginTop:1 }}>{stm.icon} {r.stepType}</div>
                  </div>
                  {r.resolvedUrl && <div style={{ fontFamily:'"Fira Code",monospace',fontSize:8,color:'rgba(100,116,139,.6)',maxWidth:320,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }} title={r.resolvedUrl}>{r.resolvedUrl}</div>}
                  {r.status==='ok' && (
                    <div style={{ display:'flex',gap:5,flexShrink:0 }}>
                      {r.httpStatus!=null && <span style={{ fontFamily:'var(--font-mono)',fontSize:8,fontWeight:700,color:'#c6f135',border:'1px solid rgba(198,241,53,.3)',padding:'1px 7px' }}>{r.httpStatus}</span>}
                      <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.7)',border:'1px solid rgba(255,255,255,.09)',padding:'1px 7px' }}>{r.itemCount} items</span>
                      <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.5)',border:'1px solid rgba(255,255,255,.07)',padding:'1px 7px' }}>{fmtMs(r.latency_ms)}</span>
                      {r.rawSize>0 && <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.4)',border:'1px solid rgba(255,255,255,.06)',padding:'1px 7px' }}>{fmtKb(r.rawSize)}</span>}
                    </div>
                  )}
                  {r.status==='error' && <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'#f87171',flex:1,textAlign:'right' as const }}>{r.error}</span>}
                  {r.status==='running' && <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'#fb923c',animation:'pulse 1s ease-in-out infinite' }}>executing…</span>}
                  {r.status!=='pending' && <span style={{ fontFamily:'var(--font-mono)',fontSize:10,color:'rgba(100,116,139,.35)',flexShrink:0 }}>{exp?'▲':'▼'}</span>}
                </div>

                {exp && (
                  <div>
                    <div style={{ display:'flex',alignItems:'center',borderBottom:'1px solid rgba(255,255,255,.06)',padding:'0 14px',background:'rgba(0,0,0,.15)' }}>
                      {([['fields',`FIELDS (${r.fieldRows.length})`],['raw',`RAW (${r.items.length})`],...(r.stepType==='FETCH_PER_ITEM'?[['subs',`SUB-REQ (${r.subRuns.length})`]]:[])]).map(([t,lbl]: any) => (
                        <button key={t} onClick={() => setTab(r.stepPos,t)} style={{ background:'none',border:'none',borderBottom:`2px solid ${tab===t?stm.color:'transparent'}`,marginBottom:-1,fontFamily:'var(--font-mono)',fontSize:7,letterSpacing:2,padding:'7px 14px',cursor:'pointer',color:tab===t?stm.color:'rgba(100,116,139,.5)',whiteSpace:'nowrap' as const }}>{lbl}</button>
                      ))}
                      {r.stepType==='FETCH_PER_ITEM' && (
                        <div style={{ marginLeft:'auto',display:'flex',alignItems:'center',gap:6,paddingRight:4 }}>
                          <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.4)' }}>iterate first</span>
                          <input type="number" min={1} max={10} value={getLimit(r.stepPos)} onChange={e=>setSubLimits(p=>({...p,[r.stepPos]:Math.max(1,Math.min(10,Number(e.target.value)))}))} style={{ background:'rgba(255,255,255,.05)',border:'1px solid rgba(255,255,255,.1)',color:'#e2e8f0',fontFamily:'var(--font-mono)',fontSize:9,padding:'2px 6px',width:40,outline:'none' }} />
                          <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.4)' }}>items</span>
                        </div>
                      )}
                    </div>

                    {tab==='fields' && (
                      r.fieldRows.length===0
                        ? <div style={{ padding:'18px',fontFamily:'var(--font-mono)',fontSize:9,color:'rgba(100,116,139,.4)',textAlign:'center' as const }}>No field mappings defined</div>
                        : <div style={{ overflowX:'auto',maxHeight:240 }}>
                            <table style={{ width:'100%',borderCollapse:'collapse' as const }}>
                              <thead><tr style={{ background:'rgba(255,255,255,.025)' }}>
                                <th style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.4)',padding:'5px 10px',textAlign:'left' as const,borderBottom:'1px solid rgba(255,255,255,.05)',letterSpacing:1 }}>#</th>
                                {headers.map(h => <th key={h} style={{ fontFamily:'var(--font-mono)',fontSize:7,color:roleColor(h),padding:'5px 10px',textAlign:'left' as const,borderBottom:'1px solid rgba(255,255,255,.05)',whiteSpace:'nowrap' as const,letterSpacing:1 }}>{h}</th>)}
                              </tr></thead>
                              <tbody>
                                {r.fieldRows.map((row,i) => (
                                  <tr key={i} style={{ borderBottom:'1px solid rgba(255,255,255,.03)' }}>
                                    <td style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.35)',padding:'4px 10px' }}>{i+1}</td>
                                    {headers.map(h => <td key={h} style={{ fontFamily:'var(--font-mono)',fontSize:9,color:'#cbd5e1',padding:'4px 10px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }} title={row[h]??''}>{row[h]??''}</td>)}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                    )}

                    {tab==='raw' && (
                      <div style={{ maxHeight:260,overflowY:'auto',padding:'10px 14px',background:'rgba(4,8,4,.95)' }}>
                        <pre style={{ margin:0,fontFamily:'"Fira Code",monospace',fontSize:9,color:'rgba(167,243,208,.7)',whiteSpace:'pre-wrap',wordBreak:'break-all' as const,lineHeight:1.6 }}>{JSON.stringify(r.items,null,2)}</pre>
                      </div>
                    )}

                    {tab==='subs' && r.stepType==='FETCH_PER_ITEM' && (
                      <div style={{ maxHeight:380,overflowY:'auto' }}>
                        {r.subRuns.map((sr,si) => (
                          <div key={si} style={{ borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                            <div style={{ display:'flex',alignItems:'center',gap:9,padding:'7px 14px',background:'rgba(6,182,212,.03)' }}>
                              <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(6,182,212,.5)',letterSpacing:2,flexShrink:0 }}>#{si+1}</span>
                              {sr.httpStatus!=null && <span style={{ fontFamily:'var(--font-mono)',fontSize:8,fontWeight:700,color:sr.error?'#f87171':'#c6f135',border:`1px solid ${sr.error?'rgba(248,113,113,.3)':'rgba(198,241,53,.3)'}`,padding:'1px 6px',flexShrink:0 }}>{sr.httpStatus}</span>}
                              <span style={{ fontFamily:'"Fira Code",monospace',fontSize:8,color:'rgba(100,116,139,.6)',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }}>{sr.resolvedUrl}</span>
                              <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.45)',flexShrink:0 }}>{sr.itemCount} items · {fmtMs(sr.latency_ms)}</span>
                              {sr.error && <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'#f87171',flexShrink:0 }}>✗ {sr.error}</span>}
                            </div>
                            {sr.fieldRows[0] && (
                              <div style={{ padding:'5px 14px 5px 36px',display:'flex',gap:14,flexWrap:'wrap' as const,background:'rgba(0,0,0,.1)' }}>
                                {Object.entries(sr.fieldRows[0]).map(([k,v]) => (
                                  <div key={k} style={{ display:'flex',gap:5,alignItems:'center' }}>
                                    <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:roleColor(k),letterSpacing:1 }}>{k}</span>
                                    <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'#94a3b8',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }}>{v}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {done && (
          <div style={{ marginTop:20,padding:'14px 20px',background:allOk?'rgba(198,241,53,.04)':'rgba(248,113,113,.04)',border:`1px solid ${allOk?'rgba(198,241,53,.2)':'rgba(248,113,113,.2)'}`,display:'flex',alignItems:'center',gap:16 }}>
            <span style={{ fontFamily:'var(--font-mono)',fontSize:12,letterSpacing:2,color:allOk?'#c6f135':'#f87171' }}>{allOk?'✓ RUN COMPLETE':'✗ FINISHED WITH ERRORS'}</span>
            <div style={{ flex:1 }} />
            {results.map(r => (
              <div key={r.stepPos} style={{ display:'flex',flexDirection:'column',alignItems:'center',gap:2 }}>
                <span style={{ fontFamily:'var(--font-mono)',fontSize:10,color:sm(r.status).c }}>{sm(r.status).icon}</span>
                <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.4)' }}>S{r.stepPos}</span>
                <span style={{ fontFamily:'var(--font-mono)',fontSize:11,fontWeight:700,color:sm(r.status).c }}>{r.itemCount}</span>
                <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.35)' }}>rows</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding:'10px 24px',background:'#060b06',borderTop:'1px solid rgba(255,255,255,.06)',display:'flex',alignItems:'center',gap:12,flexShrink:0 }}>
        <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.35)',letterSpacing:1 }}>FETCH_PER_ITEM iterates N items from parent — adjust limit then re-run</span>
        <div style={{ flex:1 }} />
        <button onClick={onClose} style={{ background:'transparent',border:'1px solid rgba(255,255,255,.1)',color:'rgba(100,116,139,.6)',fontFamily:'var(--font-mono)',fontSize:9,letterSpacing:1,padding:'7px 16px',cursor:'pointer' }}>CLOSE</button>
        {!running
          ? <button onClick={run} style={{ background:'#c6f135',color:'#0a0a0a',border:'none',fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:2,padding:'8px 24px',cursor:'pointer' }}>▶ {done?'RE-RUN':'RUN WORKFLOW'}</button>
          : <button onClick={() => abortRef.current?.abort()} style={{ background:'transparent',border:'1px solid rgba(248,113,113,.4)',color:'#f87171',fontFamily:'var(--font-mono)',fontSize:9,letterSpacing:2,padding:'8px 22px',cursor:'pointer' }}>■ ABORT</button>
        }
      </div>
      <style>{`
        @keyframes spin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes fadeOut { 0%{opacity:1} 70%{opacity:1} 100%{opacity:0} }
      `}</style>
    </div>
  );
}

// ─── InlineEdit ───────────────────────────────────────────────────────────────

function InlineEdit({ value, onSave, mono = true, placeholder = '…', dim = false, wide = false }: {
  value: string; onSave: (v: string) => void; mono?: boolean;
  placeholder?: string; dim?: boolean; wide?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [local,   setLocal]   = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => { setEditing(false); if (local.trim() !== value) onSave(local.trim()); };
  if (editing) return (
    <input ref={inputRef} value={local} onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key==='Enter') commit(); if (e.key==='Escape') { setLocal(value); setEditing(false); } }}
      style={{ background:'rgba(198,241,53,.07)', border:'1px solid rgba(198,241,53,.4)', color:'#e2e8f0', outline:'none', padding:'2px 7px', fontFamily:mono?'"Fira Code",monospace':'inherit', fontSize:11, minWidth:wide?320:120, width:wide?'100%':undefined, boxSizing:'border-box' }}
    />
  );
  return (
    <span title="Click to edit" onClick={() => setEditing(true)}
      style={{ cursor:'text', fontFamily:mono?'"Fira Code",monospace':'inherit', fontSize:11, color:dim?'var(--text-muted)':'#e2e8f0', borderBottom:'1px dashed rgba(198,241,53,.25)', padding:'1px 2px', wordBreak:'break-all' as const }}>
      {value || <span style={{ color:'rgba(100,116,139,.6)', fontStyle:'italic' }}>{placeholder}</span>}
    </span>
  );
}

// ─── RolePicker ───────────────────────────────────────────────────────────────

function RolePicker({ value, roles, onSave }: { value: string; roles: FieldRole[]; onSave: (r: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const groups = Array.from(new Set(roles.map(r => r.group)));
  const color  = roleColor(value);
  return (
    <div ref={ref} style={{ position:'relative', display:'inline-block' }}>
      <span onClick={() => setOpen(o=>!o)} title="Click to change role"
        style={{ cursor:'pointer', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:1, padding:'1px 6px', background:color+'18', border:`1px solid ${color}55`, color, display:'inline-block' }}>
        {value}
      </span>
      {open && (
        <div style={{ position:'absolute', top:'100%', left:0, zIndex:200, background:'#0f1810', border:'1px solid rgba(198,241,53,.25)', boxShadow:'0 8px 32px rgba(0,0,0,.7)', minWidth:200, maxHeight:320, overflowY:'auto' }}>
          {groups.map(group => (
            <div key={group}>
              <div style={{ padding:'5px 10px', fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'rgba(198,241,53,.5)', borderBottom:'1px solid rgba(255,255,255,.05)' }}>{group.toUpperCase()}</div>
              {roles.filter(r => r.group===group).map(r => (
                <div key={r.role} onClick={() => { onSave(r.role); setOpen(false); }} title={r.description}
                  style={{ padding:'6px 12px', cursor:'pointer', display:'flex', gap:8, alignItems:'center', background:r.role===value?'rgba(198,241,53,.07)':'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background='rgba(255,255,255,.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background=r.role===value?'rgba(198,241,53,.07)':'transparent')}
                >
                  <div style={{ width:8, height:8, borderRadius:'50%', background:roleColor(r.role), flexShrink:0 }} />
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'#cbd5e1' }}>{r.role}</span>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', marginLeft:'auto' }}>{r.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VarChip({ v }: { v: string }) {
  return <span style={{ fontFamily:'"Fira Code",monospace', fontSize:9, padding:'1px 7px', background:'rgba(6,182,212,.12)', border:'1px solid rgba(6,182,212,.3)', color:'#67e8f9' }}>{'{{'}{v}{'}}'}</span>;
}

function StepConnector({ fromVars, toStep }: { fromVars: string[]; toStep: WorkflowStep }) {
  const depColor = STEP_TYPE_META[toStep.step_type]?.color ?? '#c6f135';
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'4px 0', position:'relative' }}>
      <div style={{ width:1, height:20, background:`linear-gradient(to bottom, rgba(100,116,139,.3), ${depColor}55)` }} />
      {fromVars.length > 0 && (
        <div style={{ display:'flex', gap:4, padding:'2px 0', flexWrap:'wrap', justifyContent:'center' }}>
          {fromVars.map(v => <VarChip key={v} v={v} />)}
        </div>
      )}
      <div style={{ width:1, height:10, background:`${depColor}55` }} />
      <div style={{ width:0, height:0, borderLeft:'5px solid transparent', borderRight:'5px solid transparent', borderTop:`6px solid ${depColor}88` }} />
    </div>
  );
}

// ─── FieldRow ─────────────────────────────────────────────────────────────────

function FieldRow({ field, idx, stepPos, wfId, roles, onStepUpdated, onDelete }: {
  field: FieldDescriptor; idx: number; stepPos: number; wfId: number;
  roles: FieldRole[]; onStepUpdated: (step: WorkflowStep) => void; onDelete: () => void;
}) {
  const patchField = async (patch: Partial<FieldDescriptor>) => {
    const res = await apiFetch(`/workflows/${wfId}/field-path`, { method:'PUT', body:JSON.stringify({ step_position:stepPos, field_index:idx, ...patch }) });
    if (res.ok) onStepUpdated(res.step);
  };
  const color = roleColor(field.role);
  return (
    <div style={{ display:'grid', gridTemplateColumns:'16px 1fr 140px 20px', gap:6, alignItems:'center', padding:'4px 8px', borderBottom:'1px solid rgba(255,255,255,.04)', transition:'background .1s' }}
      onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,.03)')}
      onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
    >
      <div style={{ width:7,height:7,borderRadius:'50%',background:color,flexShrink:0 }} />
      <InlineEdit value={field.path} onSave={path=>patchField({path})} placeholder="dot.path" wide />
      <RolePicker value={field.role} roles={roles} onSave={role=>patchField({role})} />
      <button onClick={onDelete} title="Remove field" style={{ background:'none',border:'none',color:'rgba(248,113,113,.4)',cursor:'pointer',padding:0,fontSize:12,lineHeight:1 }}
        onMouseEnter={e=>(e.currentTarget.style.color='#f87171')}
        onMouseLeave={e=>(e.currentTarget.style.color='rgba(248,113,113,.4)')}
      >×</button>
    </div>
  );
}

// ─── AddFieldRow ──────────────────────────────────────────────────────────────

function AddFieldRow({ stepPos, wfId, roles, onStepUpdated }: {
  stepPos: number; wfId: number; roles: FieldRole[]; onStepUpdated: (step: WorkflowStep) => void;
}) {
  const [open,  setOpen]  = useState(false);
  const [path,  setPath]  = useState('');
  const [role,  setRole]  = useState('custom');
  const [label, setLabel] = useState('');

  const submit = async () => {
    if (!path.trim()) return;
    const res = await apiFetch(`/workflows/${wfId}/step/${stepPos}/add-field`, { method:'POST', body:JSON.stringify({ path:path.trim(), role, label:label.trim()||path.trim() }) });
    if (res.ok) { onStepUpdated(res.step); setPath(''); setRole('custom'); setLabel(''); setOpen(false); }
  };

  if (!open) return (
    <button onClick={() => setOpen(true)}
      style={{ width:'100%',background:'none',border:'1px dashed rgba(198,241,53,.15)',color:'rgba(198,241,53,.4)',fontFamily:'var(--font-mono)',fontSize:9,letterSpacing:2,padding:'5px 0',cursor:'pointer',marginTop:4,transition:'all .15s' }}
      onMouseEnter={e=>{e.currentTarget.style.borderColor='rgba(198,241,53,.4)';e.currentTarget.style.color='rgba(198,241,53,.8)'}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor='rgba(198,241,53,.15)';e.currentTarget.style.color='rgba(198,241,53,.4)'}}
    >⊕ ADD FIELD</button>
  );

  return (
    <div style={{ padding:'8px',background:'rgba(198,241,53,.03)',border:'1px solid rgba(198,241,53,.15)',marginTop:4,display:'flex',flexDirection:'column',gap:6 }}>
      <div style={{ display:'grid',gridTemplateColumns:'1fr 140px',gap:6 }}>
        <input value={path} onChange={e=>setPath(e.target.value)} placeholder="e.g. teams.home.name" onKeyDown={e=>e.key==='Enter'&&submit()} style={{ ...iS.input,fontFamily:'"Fira Code",monospace',fontSize:10 }} autoFocus />
        <select value={role} onChange={e=>setRole(e.target.value)} style={iS.input}>{roles.map(r=><option key={r.role} value={r.role}>{r.role}</option>)}</select>
      </div>
      <input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Display label (optional)" style={iS.input} />
      <div style={{ display:'flex',gap:6,justifyContent:'flex-end' }}>
        <button onClick={()=>setOpen(false)} style={iS.cancelBtn}>Cancel</button>
        <button onClick={submit} disabled={!path.trim()} style={{ ...iS.saveBtn,opacity:path.trim()?1:.4 }}>Add</button>
      </div>
    </div>
  );
}

// ─── StepCard ─────────────────────────────────────────────────────────────────

function StepCard({ step, wfId, roles, onWorkflowUpdated, onDelete, onUseAsParserSample }: {
  step: WorkflowStep; wfId: number; roles: FieldRole[];
  onWorkflowUpdated: (wf: Workflow) => void; onDelete: () => void; isLast: boolean;
  onUseAsParserSample?: (raw: unknown) => void;
}) {
  const [expanded,   setExpanded]   = useState(true);
  const [probing,    setProbing]    = useState(false);
  const [probeResult,setProbeResult]= useState<{ok:boolean;status:number|null;parsed:unknown;error:string|null;latency_ms:number|null} | null>(null);
  const meta = STEP_TYPE_META[step.step_type] ?? STEP_TYPE_META.FETCH_LIST;
  const vars = parseTemplateVars(step.url_template);

  const patchStep = async (patch: Record<string, unknown>) => {
    const res = await apiFetch(`/workflows/${wfId}/step/${step.position}/full-update`, { method:'PUT', body:JSON.stringify(patch) });
    if (res.ok) onWorkflowUpdated(res.workflow);
  };

  const deleteField = async (idx: number) => {
    const res = await apiFetch(`/workflows/${wfId}/step/${step.position}/field/${idx}`, { method:'DELETE' });
    if (res.ok) onWorkflowUpdated(res.workflow);
  };

  // Probe this step using its saved headers (bypasses 406 missing-header issues)
  const probeStep = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!step.url_template.trim() || step.url_template.includes('{{')) return;
    setProbing(true);
    setProbeResult(null);
    const t0 = Date.now();
    try {
      const res = await apiFetch('/probe', {
        method: 'POST',
        body: JSON.stringify({
          url:     step.url_template,
          method:  step.method,
          headers: step.headers ?? {},
          params:  step.params  ?? {},
          body:    step.body_template || null,
        }),
      });
      const ms = Date.now() - t0;
      setProbeResult({ ok: res.ok, status: res.status ?? null, parsed: res.parsed ?? res.response ?? null, error: res.error ?? null, latency_ms: ms });
    } catch (err: any) {
      setProbeResult({ ok: false, status: null, parsed: null, error: err.message, latency_ms: Date.now() - t0 });
    }
    setProbing(false);
  };

  return (
    <div style={{ background:'#0c150c', border:`1px solid ${meta.color}33`, boxShadow:`0 2px 16px rgba(0,0,0,.4), inset 0 0 0 1px ${meta.color}08` }}>
      <div style={{ display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:meta.bg,borderBottom:expanded?`1px solid ${meta.color}22`:'none',cursor:'pointer' }}
        onClick={() => setExpanded(e=>!e)}>
        <div style={{ width:22,height:22,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:meta.color,color:'#0a0a0a',fontFamily:'var(--font-mono)',fontSize:9,fontWeight:800 }}>{step.position}</div>
        <span style={{ fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:1.5,padding:'2px 8px',background:`${meta.color}18`,border:`1px solid ${meta.color}44`,color:meta.color,flexShrink:0 }}>{meta.icon} {meta.label}</span>
        <div onClick={e=>e.stopPropagation()} style={{ flex:1 }}>
          <InlineEdit value={step.name} onSave={name=>patchStep({name})} mono={false} placeholder="Step name" />
        </div>
        <span style={{ fontFamily:'var(--font-mono)',fontSize:8,fontWeight:700,letterSpacing:1,padding:'2px 7px',color:METHOD_COLORS[step.method]??'#e2e8f0',border:`1px solid ${(METHOD_COLORS[step.method]??'#e2e8f0')+'44'}` }}>{step.method}</span>
        <button onClick={e=>{e.stopPropagation();patchStep({enabled:!step.enabled});}} style={{ background:'none',border:`1px solid ${step.enabled?'rgba(198,241,53,.3)':'rgba(100,116,139,.3)'}`,color:step.enabled?'#c6f135':'#475569',fontFamily:'var(--font-mono)',fontSize:8,padding:'2px 7px',cursor:'pointer',flexShrink:0,letterSpacing:1 }}>{step.enabled?'ON':'OFF'}</button>
        <button
          onClick={probeStep}
          disabled={probing || !step.url_template.trim() || step.url_template.includes('{{')}
          title={step.url_template.includes('{{')?'URL has template vars — use full TEST instead':'Probe this step with its saved headers'}
          style={{
            background: probing?'rgba(251,146,60,.08)':'rgba(6,182,212,.08)',
            border:`1px solid ${probing?'rgba(251,146,60,.4)':probeResult?.ok?'rgba(198,241,53,.4)':probeResult?.ok===false?'rgba(248,113,113,.3)':'rgba(6,182,212,.3)'}`,
            color: probing?'#fb923c':probeResult?.ok?'#c6f135':probeResult?.ok===false?'#f87171':'#06b6d4',
            fontFamily:'var(--font-mono)',fontSize:7,letterSpacing:1,padding:'2px 8px',cursor:'pointer',flexShrink:0,
            opacity: (!step.url_template.trim() || step.url_template.includes('{{'))?0.35:1,
          }}
        >
          {probing?'…':(probeResult?.ok?'✓':probeResult?.ok===false?'✗':'▶')} PROBE
        </button>
        <button onClick={e=>{e.stopPropagation();onDelete();}} style={{ background:'none',border:'none',color:'rgba(248,113,113,.3)',cursor:'pointer',fontSize:14,padding:'0 4px',flexShrink:0 }}
          onMouseEnter={e=>(e.currentTarget.style.color='#f87171')} onMouseLeave={e=>(e.currentTarget.style.color='rgba(248,113,113,.3)')}>⊗</button>
        <span style={{ color:'var(--text-muted)',fontSize:12,flexShrink:0 }}>{expanded?'▲':'▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding:'12px 14px',display:'flex',flexDirection:'column',gap:10 }}>
          <div>
            <div style={{ display:'flex',alignItems:'center',gap:8 }}>
              <span style={iS.fieldLabel}>URL TEMPLATE</span>
              {vars.length>0 && <div style={{ display:'flex',gap:4,flexWrap:'wrap' }}>{vars.map(v=><VarChip key={v} v={v} />)}</div>}
            </div>
            <div onClick={e=>e.stopPropagation()} style={{ width:'100%' }}>
              <InlineEdit value={step.url_template} onSave={url_template=>patchStep({url_template})} placeholder="https://api.bookmaker.com/…/{{match_id}}/odds" wide />
            </div>
          </div>

          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:10 }}>
            <div>
              <div style={iS.fieldLabel}>RESULT ARRAY PATH</div>
              <div onClick={e=>e.stopPropagation()}>
                <InlineEdit value={step.result_array_path||''} onSave={result_array_path=>patchStep({result_array_path})} placeholder="e.g. data.events" wide />
              </div>
              <div style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.6)',marginTop:3 }}>dot-path to the array; blank = root</div>
            </div>
            {step.step_type==='FETCH_PER_ITEM' && (
              <div>
                <div style={iS.fieldLabel}>DEPENDS ON STEP</div>
                <div onClick={e=>e.stopPropagation()}>
                  <InlineEdit value={step.depends_on_pos!==null?String(step.depends_on_pos):''} onSave={v=>patchStep({depends_on_pos:v?parseInt(v):null})} placeholder="step position number" />
                </div>
              </div>
            )}
          </div>

          <div>
            <div style={iS.fieldLabel}>NOTES</div>
            <div onClick={e=>e.stopPropagation()}>
              <InlineEdit value={step.notes||''} onSave={notes=>patchStep({notes})} placeholder="e.g. Uses {{match_id}} from step 1" mono={false} dim wide />
            </div>
          </div>

          <div>
            <div style={{ ...iS.fieldLabel,marginBottom:6,display:'flex',alignItems:'center',gap:10 }}>
              FIELDS <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'var(--text-muted)',fontWeight:400 }}>{step.fields.length} mapped</span>
            </div>
            {step.fields.length>0 && (
              <div style={{ display:'grid',gridTemplateColumns:'16px 1fr 140px 20px',gap:6,padding:'3px 8px',fontFamily:'var(--font-mono)',fontSize:7,letterSpacing:2,color:'rgba(100,116,139,.5)',borderBottom:'1px solid rgba(255,255,255,.06)' }}>
                <span/><span>DOT PATH</span><span>ROLE</span><span/>
              </div>
            )}
            {step.fields.map((f,idx) => (
              <FieldRow key={idx} field={f} idx={idx} stepPos={step.position} wfId={wfId} roles={roles}
                onStepUpdated={()=>onWorkflowUpdated({id:wfId} as any)}
                onDelete={()=>deleteField(idx)}
              />
            ))}
            <AddFieldRow stepPos={step.position} wfId={wfId} roles={roles} onStepUpdated={()=>onWorkflowUpdated({id:wfId} as any)} />
          </div>

          {/* ── Probe result strip ─────────────────────────────────────── */}
          {probeResult && (
            <div style={{ marginTop:8, border:`1px solid ${probeResult.ok?'rgba(198,241,53,.2)':'rgba(248,113,113,.2)'}`, background: probeResult.ok?'rgba(198,241,53,.03)':'rgba(248,113,113,.03)'  }}>
              <div style={{ display:'flex',alignItems:'center',gap:8,padding:'6px 10px',borderBottom:'1px solid rgba(255,255,255,.05)' }}>
                <span style={{ fontFamily:'var(--font-mono)',fontSize:8,fontWeight:700,color:probeResult.ok?'#c6f135':'#f87171' }}>
                  {probeResult.ok?'✓ PROBE OK':'✗ PROBE FAILED'}
                </span>
                {probeResult.status!=null && (
                  <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:probeResult.ok?'#c6f135':'#f87171',border:`1px solid ${probeResult.ok?'rgba(198,241,53,.3)':'rgba(248,113,113,.3)'}`,padding:'1px 6px' }}>
                    {probeResult.status}
                  </span>
                )}
                <span style={{ fontFamily:'var(--font-mono)',fontSize:7,color:'rgba(100,116,139,.5)' }}>{probeResult.latency_ms}ms</span>
                <div style={{ flex:1 }} />
                {probeResult.ok && probeResult.parsed !== null && onUseAsParserSample && (
                  <button
                    onClick={e=>{e.stopPropagation();onUseAsParserSample(probeResult.parsed);}}
                    style={{ background:'#c6f135',border:'none',color:'#0a0a0a',fontFamily:'var(--font-mono)',fontSize:7,fontWeight:700,letterSpacing:1.5,padding:'4px 12px',cursor:'pointer' }}
                  >
                    ↳ USE AS PARSER SAMPLE
                  </button>
                )}
                <button onClick={e=>{e.stopPropagation();setProbeResult(null);}} style={{ background:'none',border:'none',color:'rgba(100,116,139,.4)',cursor:'pointer',fontSize:13,padding:'0 2px',lineHeight:1 }}>×</button>
              </div>
              {/* Error message */}
              {probeResult.error && (
                <div style={{ padding:'6px 10px',fontFamily:'"Fira Code",monospace',fontSize:8,color:'#fca5a5',lineHeight:1.55 }}>{probeResult.error}</div>
              )}
              {/* Mini JSON preview */}
              {probeResult.ok && probeResult.parsed !== null && (
                <div style={{ maxHeight:120,overflow:'auto',padding:'8px 10px',background:'rgba(0,0,0,.25)' }}>
                  <JsonNode
                    k={null} v={probeResult.parsed} depth={0}
                    onSelect={onUseAsParserSample ? (selected) => {
                      onUseAsParserSample(selected);
                    } : undefined}
                    onCopy={(val) => navigator.clipboard.writeText(JSON.stringify(val, null, 2))}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── WorkflowCanvas ───────────────────────────────────────────────────────────

function WorkflowCanvas({ workflow, roles, onUpdated, onProbeComplete, onOpenParserTab, onUseAsParserSample }: {
  workflow: Workflow; roles: FieldRole[]; onUpdated: (wf: Workflow) => void;
  onProbeComplete?: (rawByPos: Record<number, unknown>) => void;
  onOpenParserTab?: () => void;
  onUseAsParserSample?: (raw: unknown) => void;
}) {
  const [nameEditing, setNameEditing] = useState(false);
  const [showTest,    setShowTest]    = useState(false);
  const [addingStep,  setAddingStep]  = useState(false);
  const [newStepType, setNewStepType] = useState('FETCH_PER_ITEM');
  const [newStepName, setNewStepName] = useState('');
  const [newStepUrl,  setNewStepUrl]  = useState('');

  const sortedSteps = [...workflow.steps].sort((a, b) => a.position - b.position);

  const patchWorkflow = async (patch: Record<string, unknown>) => {
    const res = await apiFetch(`/workflows/${workflow.id}`, { method:'PATCH', body:JSON.stringify(patch) });
    if (res.ok) onUpdated(res.workflow);
  };

  const handleStepUpdate = useCallback(async (wf: Workflow) => {
    if (wf && !wf.steps) { const full = await apiFetch(`/workflows/${workflow.id}/full`); onUpdated(full); }
    else onUpdated(wf);
  }, [workflow.id, onUpdated]);

  const deleteStep = async (pos: number) => {
    if (!confirm(`Delete step ${pos}?`)) return;
    const res = await apiFetch(`/workflows/${workflow.id}/step/${pos}`, { method:'DELETE' });
    if (res.ok) onUpdated(res.workflow);
  };

  const addStep = async () => {
    const lastPos = sortedSteps.length > 0 ? sortedSteps[sortedSteps.length - 1].position : 0;
    const res = await apiFetch(`/workflows/${workflow.id}/step`, { method:'POST', body:JSON.stringify({ step_type:newStepType, name:newStepName.trim()||`Step ${lastPos+1}`, url_template:newStepUrl.trim(), depends_on_pos:newStepType==='FETCH_PER_ITEM'?lastPos:null }) });
    if (res.ok) { onUpdated(res.workflow); setAddingStep(false); setNewStepName(''); setNewStepUrl(''); }
  };

  return (
    <div style={{ display:'flex',flexDirection:'column',gap:0,minWidth:540,maxWidth:760 }}>
      {showTest && <WorkflowTestPanel workflow={workflow} onClose={()=>setShowTest(false)} onProbeComplete={onProbeComplete} onOpenParser={onOpenParserTab} />}

      {/* Workflow header */}
      <div style={{ display:'flex',alignItems:'center',gap:10,padding:'14px 18px',marginBottom:16,background:'rgba(198,241,53,.04)',border:'1px solid rgba(198,241,53,.15)' }}>
        <div style={{ flex:1 }}>
          {nameEditing
            ? <input autoFocus defaultValue={workflow.name} onBlur={e=>{patchWorkflow({name:e.target.value});setNameEditing(false);}} onKeyDown={e=>{if(e.key==='Enter')(e.target as HTMLInputElement).blur();}} style={{ ...iS.input,fontSize:14,fontWeight:700,width:'100%',boxSizing:'border-box' }} />
            : <div style={{ fontFamily:'var(--font-display)',fontSize:15,fontWeight:700,letterSpacing:1,cursor:'text',color:'#e2e8f0' }} onClick={()=>setNameEditing(true)} title="Click to rename">{workflow.name}</div>
          }
          <div style={{ fontFamily:'var(--font-mono)',fontSize:9,color:'var(--text-muted)',marginTop:3,letterSpacing:1 }}>
            {sortedSteps.length} step{sortedSteps.length!==1?'s':''}
            {workflow.updated_at?` · updated ${new Date(workflow.updated_at).toLocaleDateString()}`:''}
          </div>
        </div>

        <button onClick={()=>setShowTest(true)} disabled={sortedSteps.length===0}
          style={{ background:'rgba(198,241,53,.08)',border:'1px solid rgba(198,241,53,.35)',color:'#c6f135',fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:2,padding:'6px 14px',cursor:sortedSteps.length>0?'pointer':'not-allowed',opacity:sortedSteps.length>0?1:.35 }}
          onMouseEnter={e=>{if(sortedSteps.length>0){e.currentTarget.style.background='rgba(198,241,53,.15)';e.currentTarget.style.borderColor='rgba(198,241,53,.6)';}}}
          onMouseLeave={e=>{e.currentTarget.style.background='rgba(198,241,53,.08)';e.currentTarget.style.borderColor='rgba(198,241,53,.35)'}}
        >▶ TEST</button>

        <button onClick={()=>patchWorkflow({is_active:!workflow.is_active})}
          style={{ background:workflow.is_active?'rgba(198,241,53,.12)':'rgba(100,116,139,.1)',border:`1px solid ${workflow.is_active?'rgba(198,241,53,.4)':'rgba(100,116,139,.3)'}`,color:workflow.is_active?'#c6f135':'#64748b',fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:1.5,padding:'5px 12px',cursor:'pointer' }}>
          {workflow.is_active?'● ACTIVE':'○ INACTIVE'}
        </button>
      </div>

      {sortedSteps.length===0 && (
        <div style={{ padding:'40px',textAlign:'center',fontFamily:'var(--font-mono)',fontSize:10,color:'var(--text-muted)',letterSpacing:2,border:'1px dashed rgba(255,255,255,.1)' }}>NO STEPS — add one below</div>
      )}

      {sortedSteps.map((step,idx) => (
        <div key={step.id}>
          {idx>0 && <StepConnector fromVars={parseTemplateVars(step.url_template)} toStep={step} />}
          <StepCard step={step} wfId={workflow.id} roles={roles} onWorkflowUpdated={handleStepUpdate} onDelete={()=>deleteStep(step.position)} isLast={idx===sortedSteps.length-1} onUseAsParserSample={onUseAsParserSample} />
        </div>
      ))}

      {addingStep ? (
        <div style={{ marginTop:12,padding:'14px',background:'rgba(6,182,212,.04)',border:'1px solid rgba(6,182,212,.2)',display:'flex',flexDirection:'column',gap:8 }}>
          <div style={{ fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:2,color:'#06b6d4' }}>NEW STEP</div>
          <div style={{ display:'grid',gridTemplateColumns:'160px 1fr',gap:8 }}>
            <select value={newStepType} onChange={e=>setNewStepType(e.target.value)} style={iS.input}>
              <option value="FETCH_LIST">FETCH_LIST</option>
              <option value="FETCH_PER_ITEM">FETCH_PER_ITEM</option>
              <option value="FETCH_ONCE">FETCH_ONCE</option>
            </select>
            <input value={newStepName} onChange={e=>setNewStepName(e.target.value)} placeholder="Step name" style={iS.input} />
          </div>
          <input value={newStepUrl} onChange={e=>setNewStepUrl(e.target.value)} placeholder="https://api.bookmaker.com/…/{{match_id}}/odds" style={{ ...iS.input,fontFamily:'"Fira Code",monospace',fontSize:10 }} onKeyDown={e=>e.key==='Enter'&&addStep()} />
          <div style={{ display:'flex',gap:6,justifyContent:'flex-end' }}>
            <button onClick={()=>setAddingStep(false)} style={iS.cancelBtn}>Cancel</button>
            <button onClick={addStep} style={iS.saveBtn}>Add Step</button>
          </div>
        </div>
      ) : (
        <button onClick={()=>setAddingStep(true)}
          style={{ marginTop:12,width:'100%',background:'none',border:'1px dashed rgba(6,182,212,.2)',color:'rgba(6,182,212,.5)',fontFamily:'var(--font-mono)',fontSize:9,letterSpacing:2,padding:'9px 0',cursor:'pointer',transition:'all .15s' }}
          onMouseEnter={e=>{e.currentTarget.style.borderColor='rgba(6,182,212,.5)';e.currentTarget.style.color='#06b6d4'}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor='rgba(6,182,212,.2)';e.currentTarget.style.color='rgba(6,182,212,.5)'}}
        >⊕ ADD STEP</button>
      )}
    </div>
  );
}

// ─── BookmakerRail ────────────────────────────────────────────────────────────

function BookmakerRail({ nodes, selectedWfId, onSelect, onAddWorkflow }: {
  nodes: BookmakerNode[]; selectedWfId: number | null;
  onSelect: (id: number) => void; onAddWorkflow: (id: number) => void;
}) {
  const [expandedBk, setExpandedBk] = useState<Set<number>>(new Set(nodes.map(n => n.bookmaker_id)));
  const [search, setSearch] = useState('');

  const toggleBk = (id: number) => setExpandedBk(prev => { const n = new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const filtered = nodes.map(n => ({ ...n, workflows: n.workflows.filter(w => !search.trim() || w.name.toLowerCase().includes(search.toLowerCase())) })).filter(n => n.workflows.length>0 || !search.trim());

  return (
    <div style={{ width:258,flexShrink:0,borderRight:'1px solid rgba(255,255,255,.06)',display:'flex',flexDirection:'column',overflow:'hidden',background:'#070d07' }}>
      <div style={{ padding:'10px 12px',borderBottom:'1px solid rgba(255,255,255,.06)' }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search workflows…" style={{ ...iS.input,width:'100%',boxSizing:'border-box',fontSize:10 }} />
      </div>

      <div style={{ flex:1,overflowY:'auto' }}>
        {filtered.map(node => (
          <div key={node.bookmaker_id}>
            <div onClick={()=>toggleBk(node.bookmaker_id)}
              style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 12px',cursor:'pointer',borderBottom:'1px solid rgba(255,255,255,.04)',background:'rgba(255,255,255,.02)',transition:'background .1s' }}
              onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,.04)')}
              onMouseLeave={e=>(e.currentTarget.style.background='rgba(255,255,255,.02)')}
            >
              <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'#c6f135',width:12,textAlign:'center',flexShrink:0 }}>
                {expandedBk.has(node.bookmaker_id)?'▾':'▸'}
              </span>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontFamily:'var(--font-mono)',fontSize:11,fontWeight:600,color:'#e2e8f0',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{node.bookmaker_name}</div>
                <div style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'var(--text-muted)' }}>{node.domain} · {node.workflow_count} workflow{node.workflow_count!==1?'s':''}</div>
              </div>
              <button onClick={e=>{e.stopPropagation();onAddWorkflow(node.bookmaker_id);}} title="Add workflow"
                style={{ background:'none',border:'none',color:'rgba(198,241,53,.35)',fontSize:16,cursor:'pointer',padding:'0 2px',flexShrink:0 }}
                onMouseEnter={e=>(e.currentTarget.style.color='#c6f135')}
                onMouseLeave={e=>(e.currentTarget.style.color='rgba(198,241,53,.35)')}
              >+</button>
            </div>

            {expandedBk.has(node.bookmaker_id) && (
              <div>
                {node.workflows.map(wf => {
                  const active   = selectedWfId === wf.id;
                  const stepCount = wf.steps?.length ?? 0;
                  const hasParser = !!wf.parser_code;
                  return (
                    <div key={wf.id} onClick={() => onSelect(wf.id)}
                      style={{ display:'flex',alignItems:'flex-start',gap:8,padding:'8px 12px 8px 28px',cursor:'pointer',background:active?'rgba(198,241,53,.06)':'transparent',borderLeft:`2px solid ${active?'#c6f135':'transparent'}`,borderBottom:'1px solid rgba(255,255,255,.03)',transition:'all .1s' }}
                      onMouseEnter={e=>{if(!active)e.currentTarget.style.background='rgba(255,255,255,.02)'}}
                      onMouseLeave={e=>{if(!active)e.currentTarget.style.background='transparent'}}
                    >
                      <div style={{ width:6,height:6,borderRadius:'50%',marginTop:4,flexShrink:0,background:wf.is_active?'#c6f135':'#475569' }} />
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontFamily:'var(--font-mono)',fontSize:10,color:active?'#c6f135':'#cbd5e1',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{wf.name}</div>
                        <div style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'var(--text-muted)',marginTop:2,display:'flex',alignItems:'center',gap:6 }}>
                          <span>{stepCount} step{stepCount!==1?'s':''}</span>
                          {wf.steps?.map(s => {
                            const m = STEP_TYPE_META[s.step_type];
                            return <span key={s.id} title={s.step_type} style={{ color:m?.color }}>{m?.icon}</span>;
                          })}
                          {hasParser && (
                            <span title="Has parser" style={{ color: wf.parser_test_passed?'#c6f135':'rgba(251,146,60,.6)', fontSize:7 }}>
                              {wf.parser_test_passed?'✓':'⟩_'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {filtered.length===0 && (
          <div style={{ padding:'28px 16px',fontFamily:'var(--font-mono)',fontSize:9,color:'var(--text-muted)',textAlign:'center',letterSpacing:2 }}>NO WORKFLOWS</div>
        )}
      </div>

      {/* Legend */}
      <div style={{ padding:'10px 12px',borderTop:'1px solid rgba(255,255,255,.05)',display:'flex',flexDirection:'column',gap:4 }}>
        {Object.entries(STEP_TYPE_META).map(([type, m]) => (
          <div key={type} style={{ display:'flex',alignItems:'center',gap:6 }}>
            <span style={{ color:m.color,fontSize:10 }}>{m.icon}</span>
            <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.7)',letterSpacing:1 }}>{m.label}</span>
          </div>
        ))}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginTop:2 }}>
          <span style={{ color:'#c6f135',fontSize:9 }}>⟩_</span>
          <span style={{ fontFamily:'var(--font-mono)',fontSize:8,color:'rgba(100,116,139,.7)',letterSpacing:1 }}>PARSER</span>
        </div>
      </div>
    </div>
  );
}

// ─── NewWorkflowModal ─────────────────────────────────────────────────────────

function NewWorkflowModal({ bookmarkerId, bookmarkerName, onSave, onClose }: {
  bookmarkerId: number; bookmarkerName: string;
  onSave: (wf: Workflow) => void; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const res = await apiFetch('/save-workflow', { method:'POST', body:JSON.stringify({ bookmaker_id:bookmarkerId, name:name.trim(), description:desc.trim(), is_active:true, steps:[] }) });
    setBusy(false);
    if (res.ok) { const full = await apiFetch(`/workflows/${res.workflow_id}/full`); onSave(full); }
  };

  return (
    <div style={iS.overlay} onClick={onClose}>
      <div style={{ ...iS.modal,maxWidth:420 }} onClick={e=>e.stopPropagation()}>
        <div style={iS.modalHead}>
          <span style={{ fontFamily:'var(--font-mono)',fontSize:10,letterSpacing:2 }}>NEW WORKFLOW — {bookmarkerName.toUpperCase()}</span>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:18 }}>✕</button>
        </div>
        <div style={{ padding:20,display:'flex',flexDirection:'column',gap:12 }}>
          <div>
            <div style={iS.fieldLabel}>NAME *</div>
            <input value={name} onChange={e=>setName(e.target.value)} autoFocus placeholder="e.g. Match List + Odds" style={{ ...iS.input,width:'100%',boxSizing:'border-box' }} onKeyDown={e=>e.key==='Enter'&&submit()} />
          </div>
          <div>
            <div style={iS.fieldLabel}>DESCRIPTION</div>
            <input value={desc} onChange={e=>setDesc(e.target.value)} style={{ ...iS.input,width:'100%',boxSizing:'border-box' }} />
          </div>
          <div style={{ display:'flex',gap:8,justifyContent:'flex-end',paddingTop:4 }}>
            <button onClick={onClose} style={iS.cancelBtn}>Cancel</button>
            <button onClick={submit} disabled={!name.trim()||busy} style={{ ...iS.saveBtn,opacity:(!name.trim()||busy)?.5:1 }}>{busy?'Creating…':'Create Workflow'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onClear, 3000); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  const err = msg.startsWith('✗');
  return (
    <div style={{ position:'fixed',bottom:24,right:28,zIndex:9999,background:'#0c150c',border:`1px solid ${err?'rgba(248,113,113,.4)':'rgba(198,241,53,.4)'}`,color:err?'#f87171':'#c6f135',padding:'10px 20px',fontFamily:'var(--font-mono)',fontSize:11,boxShadow:'0 8px 32px rgba(0,0,0,.6)',letterSpacing:1 }}>
      {msg}
    </div>
  );
}

// ─── WorkflowExplorer (main) ──────────────────────────────────────────────────

export default function WorkflowExplorer() {
  const [nodes,      setNodes]      = useState<BookmakerNode[]>([]);
  const [roles,      setRoles]      = useState<FieldRole[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [toast,      setToast]      = useState('');
  const [newWfFor,   setNewWfFor]   = useState<{ id: number; name: string } | null>(null);

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const [tree, roleList] = await Promise.all([apiFetch('/workflows/tree'), apiFetch('/field-roles')]);
      setNodes(tree);
      setRoles(roleList);
      if (!selectedId && tree.length>0 && tree[0].workflows.length>0) setSelectedId(tree[0].workflows[0].id);
    } catch { setToast('✗ Could not load workflows'); }
    finally { setLoading(false); }
  }, [selectedId]);

  useEffect(() => { loadTree(); }, []);

  const selectedWorkflow = nodes.flatMap(n => n.workflows).find(w => w.id === selectedId) ?? null;

  const handleWorkflowUpdated = useCallback((updatedWf: Workflow) => {
    setNodes(prev => prev.map(node => ({ ...node, workflows: node.workflows.map(w => w.id===updatedWf.id?updatedWf:w) })));
    setToast('✓ Saved');
  }, []);

  const handleNewWorkflow = (bkId: number) => {
    const node = nodes.find(n => n.bookmaker_id===bkId);
    if (node) setNewWfFor({ id:bkId, name:node.bookmaker_name });
  };

  const handleWorkflowCreated = (wf: Workflow) => {
    setNodes(prev => prev.map(node => node.bookmaker_id===wf.bookmaker_id ? { ...node, workflows:[...node.workflows, wf], workflow_count:node.workflow_count+1 } : node));
    setSelectedId(wf.id);
    setNewWfFor(null);
    setToast(`✓ Created "${wf.name}"`);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#080d08', color:'#e2e8f0' }}>
      <Toast msg={toast} onClear={() => setToast('')} />

      {/* Top bar */}
      <div style={{ display:'flex',alignItems:'center',gap:16,padding:'12px 20px',borderBottom:'1px solid rgba(255,255,255,.07)',background:'#060b06',flexShrink:0 }}>
        <div>
          <h1 style={{ margin:0,fontFamily:'var(--font-display)',fontSize:18,fontWeight:800,letterSpacing:3,color:'#c6f135' }}>WORKFLOW EXPLORER</h1>
          <p style={{ margin:0,fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:3,color:'rgba(100,116,139,.7)',marginTop:2 }}>HARVEST STEP CONFIGURATOR · PARSER EDITOR</p>
        </div>
        <div style={{ flex:1 }} />
        {Object.entries(STEP_TYPE_META).map(([type, m]) => (
          <span key={type} style={{ fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:1,padding:'3px 10px',color:m.color,background:m.bg,border:`1px solid ${m.color}33` }}>{m.icon} {m.label}</span>
        ))}
        <a href="/dashboard/research" style={{ fontFamily:'var(--font-mono)',fontSize:8,letterSpacing:2,padding:'6px 14px',color:'var(--text-muted)',border:'1px solid rgba(255,255,255,.1)',textDecoration:'none' }}>← RESEARCH</a>
        <button onClick={loadTree} style={{ background:'none',border:'1px solid rgba(255,255,255,.1)',color:'var(--text-muted)',fontFamily:'var(--font-mono)',fontSize:9,letterSpacing:1,padding:'6px 12px',cursor:'pointer' }}>↺ REFRESH</button>
      </div>

      {/* Main layout */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {loading ? (
          <div style={{ width:258,display:'flex',alignItems:'center',justifyContent:'center',background:'#070d07',borderRight:'1px solid rgba(255,255,255,.06)' }}>
            <span style={{ fontFamily:'var(--font-mono)',fontSize:9,color:'rgba(198,241,53,.4)',letterSpacing:3 }}>LOADING…</span>
          </div>
        ) : (
          <BookmakerRail nodes={nodes} selectedWfId={selectedId} onSelect={setSelectedId} onAddWorkflow={handleNewWorkflow} />
        )}

        {/* Canvas */}
        <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column', background:'#080d08' }}>
          {!selectedWorkflow ? (
            <div style={{ flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16 }}>
              <div style={{ fontFamily:'var(--font-mono)',fontSize:36,color:'rgba(198,241,53,.1)' }}>◈</div>
              <div style={{ fontFamily:'var(--font-mono)',fontSize:11,letterSpacing:3,color:'rgba(100,116,139,.5)' }}>SELECT A WORKFLOW</div>
              <div style={{ fontFamily:'var(--font-mono)',fontSize:9,color:'rgba(100,116,139,.35)',letterSpacing:2 }}>OR CREATE ONE USING THE + IN THE SIDEBAR</div>
            </div>
          ) : (
            <WorkflowDetail
              key={selectedWorkflow.id}
              workflow={selectedWorkflow}
              roles={roles}
              onUpdated={handleWorkflowUpdated}
            />
          )}
        </div>
      </div>

      {newWfFor && (
        <NewWorkflowModal bookmarkerId={newWfFor.id} bookmarkerName={newWfFor.name} onSave={handleWorkflowCreated} onClose={() => setNewWfFor(null)} />
      )}

      <style>{`
        ::-webkit-scrollbar { width:5px; height:5px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:rgba(198,241,53,.15); border-radius:3px; }
        ::-webkit-scrollbar-thumb:hover { background:rgba(198,241,53,.3); }
        * { box-sizing:border-box; }
        @keyframes spin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes fadeOut { 0%{opacity:1} 70%{opacity:1} 100%{opacity:0} }
      `}</style>
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────────────────────────

const iS: Record<string, React.CSSProperties> = {
  input: { background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.1)', color:'#e2e8f0', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:11, outline:'none' },
  fieldLabel: { fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2.5, color:'rgba(100,116,139,.7)', marginBottom:5, display:'block' },
  saveBtn: { padding:'7px 18px', background:'#c6f135', color:'#0a0a0a', border:'none', fontFamily:'var(--font-mono)', fontSize:10, fontWeight:700, letterSpacing:1, cursor:'pointer' },
  cancelBtn: { padding:'7px 14px', background:'transparent', border:'1px solid rgba(255,255,255,.1)', color:'rgba(100,116,139,.8)', fontFamily:'var(--font-mono)', fontSize:10, cursor:'pointer' },
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 },
  modal: { background:'#0c150c', border:'1px solid rgba(198,241,53,.2)', width:'100%', maxWidth:680, boxShadow:'0 24px 64px rgba(0,0,0,.8)' },
  modalHead: { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,.06)' },
};