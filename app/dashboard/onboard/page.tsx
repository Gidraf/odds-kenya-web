/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

/**
 * EndpointResearch  —  /dashboard/research
 * ==========================================
 * Visual harvest-workflow builder. Zero AI generation.
 *
 * Context bar : BOOKMAKER · SPORT · WORKFLOW TYPE (3-column, mirrors reference)
 * Per step    : IMPORT FROM CURL toggle (auto-parses URL / method / headers /
 *               params / body) · METHOD · URL template · PARAMS / HEADERS / BODY
 *               tabs · ⚡ PROBE · ⟳ PROBE + AUTO-DETECT · field mappings table
 * Between steps: connector arrows showing {{var}} resolution status
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { fetchWithAuth } from '../../lib/api';
import BookmakerOnboarding from './onboarding-page';
import PlaywrightOnboarding from './playwright-onboarding';

// ─── Types ────────────────────────────────────────────────────────────────────

type StepType = 'FETCH_LIST' | 'FETCH_PER_ITEM' | 'FETCH_ONCE';

interface KV { key: string; value: string }

interface FieldDescriptor {
  path:    string;
  role:    string;
  label:   string;
  store?:  boolean;
  sample?: unknown;
}

interface DraftStep {
  localId:           string;
  position:          number;
  name:              string;
  step_type:         StepType;
  url_template:      string;
  method:            string;
  headers:           KV[];
  params:            KV[];
  body:              string;
  result_array_path: string;
  fields:            FieldDescriptor[];
  depends_on_pos:    number | null;
  field_mappings:    Record<string, string>; // {{varName}} → sourcePath from parent step
  enabled:           boolean;
  notes:             string;
  // UI-only
  probeStatus:       'idle' | 'probing' | 'ok' | 'error';
  probeResponse:     unknown;
  probeError:        string;
  probeHttpStatus:   number | null;
  firstItem:         Record<string, unknown> | null;
}

interface BookmakerOption { id: number; name: string; domain?: string }
interface SportOption     { id: number; name: string; slug?:   string }
interface FieldRole       { role: string; group: string; label: string; description: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE      = '/research';
const apiFetch  = (path: string, opts?: RequestInit) =>
  fetchWithAuth(`${BASE}${path}`, opts).then((r: Response) => r.json());

const STEP_TYPES: Record<StepType, { icon: string; desc: string }> = {
  FETCH_LIST:     { icon: '▤', desc: 'Fetches a list (e.g. all matches)' },
  FETCH_PER_ITEM: { icon: '⟳', desc: 'Iterates items from a previous step' },
  FETCH_ONCE:     { icon: '◉', desc: 'Single static request (token, config…)' },
};

// Step type accent colours  — intentionally map to CSS-var-friendly values
const STEP_COLOR: Record<StepType, { fg: string; bg: string; border: string }> = {
  FETCH_LIST:     { fg: 'var(--acid)',  bg: 'rgba(198,241,53,.07)',  border: 'rgba(198,241,53,.25)'  },
  FETCH_PER_ITEM: { fg: 'var(--cyan)',  bg: 'rgba(6,182,212,.07)',   border: 'rgba(6,182,212,.25)'   },
  FETCH_ONCE:     { fg: '#fb923c',      bg: 'rgba(251,146,60,.07)',   border: 'rgba(251,146,60,.25)'  },
};

const ROLE_ACCENT: Record<string, string> = {
  match_id:'var(--acid)', parent_match_id:'#a3e635',
  home_team:'#34d399',    away_team:'#34d399',
  start_time:'var(--text-secondary)', sport:'var(--text-secondary)', competition:'var(--text-secondary)',
  market_name:'var(--cyan)', specifier:'var(--cyan)',
  selection_name:'#38bdf8', selection_price:'#38bdf8',
  home_lineup:'#f472b6', away_lineup:'#f472b6',
  home_form:'#fb923c', away_form:'#fb923c',
  match_status:'var(--text-primary)', score_home:'var(--text-primary)', score_away:'var(--text-primary)',
  lineup_confirmed:'#c084fc', kickoff_in_mins:'#c084fc',
  custom:'var(--text-muted)',
};

const WORKFLOW_TYPES = ['MATCH_LIST','LIVE_MATCHES','MARKETS_ONLY','MATCH_DETAIL','EVENTS','FIXTURE_LIST','GENERIC'];

const blankKV   = (): KV       => ({ key: '', value: '' });
const blankStep = (pos: number): DraftStep => ({
  localId: Math.random().toString(36).slice(2),
  position: pos, name: `Step ${pos}`,
  step_type: pos === 1 ? 'FETCH_LIST' : 'FETCH_PER_ITEM',
  url_template: '', method: 'GET',
  headers: [blankKV()], params: [blankKV()], body: '',
  result_array_path: '', fields: [],
  depends_on_pos: pos > 1 ? pos - 1 : null,
  field_mappings: {},
  enabled: true, notes: '',
  probeStatus: 'idle', probeResponse: null,
  probeError: '', probeHttpStatus: null, firstItem: null,
});

// ─── Utilities ────────────────────────────────────────────────────────────────

const parseVars = (t: string) =>
  [...new Set([...(t.matchAll(/\{\{(\w+)\}\}/g))].map(m => m[1]))];
const roleAccent = (r: string) => ROLE_ACCENT[r] ?? 'var(--text-muted)';
const fmtJson    = (v: unknown) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
const kvToObj    = (pairs: KV[]) =>
  Object.fromEntries(pairs.filter(p => p.key.trim()).map(p => [p.key.trim(), p.value]));
const fmtKb      = (b: number)  => `${(b / 1024).toFixed(1)} KB`;

// ─── flattenObj — recursively flatten a JSON object to { path, value, type }[] ──

function flattenObj(
  obj: Record<string, unknown>,
  prefix = '',
  depth   = 0,
): { path: string; value: string; type: string }[] {
  if (depth > 3) return [];
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (t === 'object' && depth < 2) {
      return flattenObj(v as Record<string, unknown>, p, depth + 1);
    }
    if (t === 'array') {
      const arr = v as unknown[];
      // Include the array itself AND, if items are primitives, include first-item shorthand
      return [{ path: p, value: `[${arr.length}]`, type: 'array' }];
    }
    return [{ path: p, value: String(v ?? ''), type: t }];
  });
}

// ─── getNestedValue — get a value at a dot-path from an object ───────────────

function getNestedValue(obj: unknown, path: string): unknown {
  if (!path || obj === null || obj === undefined) return obj;
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Extract array from response using result_array_path
function extractArray(data: unknown, arrayPath: string): unknown[] {
  const root = arrayPath ? getNestedValue(data, arrayPath) : data;
  if (Array.isArray(root)) return root;
  if (root && typeof root === 'object') {
    // Auto-find first array key
    for (const v of Object.values(root as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > 0) return v;
    }
  }
  return [];
}

// Resolve a URL template using a flat source object + field_mappings
function resolveTemplate(
  urlTemplate: string,
  params:       KV[],
  fieldMappings: Record<string, string>,
  sourceItem:   Record<string, unknown>,
): { url: string; params: Record<string, string> } {
  const resolveVar = (varName: string): string => {
    const srcPath = fieldMappings[varName];
    if (srcPath) {
      const v = getNestedValue(sourceItem, srcPath);
      if (v !== undefined && v !== null) return String(v);
    }
    // fallback: direct key match
    const direct = sourceItem[varName];
    if (direct !== undefined && direct !== null) return String(direct);
    return `<${varName}>`;
  };
  const resolvedUrl = urlTemplate.replace(/\{\{(\w+)\}\}/g, (_, v) => resolveVar(v));
  const resolvedParams: Record<string, string> = {};
  params.filter(p => p.key.trim()).forEach(p => {
    resolvedParams[p.key.trim()] = p.value.replace(/\{\{(\w+)\}\}/g, (_, v) => resolveVar(v));
  });
  return { url: resolvedUrl, params: resolvedParams };
}


function parseCurl(raw: string): Omit<DraftStep, keyof DraftStep> & Pick<DraftStep, 'url_template'|'method'|'headers'|'params'|'body'> {
  const cmd = raw.replace(/\\\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === ' ') { i++; continue; }
    if (cmd[i] === "'") {
      const end = cmd.indexOf("'", i + 1);
      tokens.push(end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end));
      i = end === -1 ? cmd.length : end + 1;
    } else if (cmd[i] === '"') {
      const end = cmd.indexOf('"', i + 1);
      tokens.push(end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end));
      i = end === -1 ? cmd.length : end + 1;
    } else {
      const sp = cmd.indexOf(' ', i);
      tokens.push(sp === -1 ? cmd.slice(i) : cmd.slice(i, sp));
      i = sp === -1 ? cmd.length : sp;
    }
  }
  let url = '', method = 'GET', body = '';
  const rawHeaders: KV[] = [];
  let t = 0;
  if (tokens[0]?.toLowerCase() === 'curl') t = 1;
  while (t < tokens.length) {
    const tok = tokens[t];
    if (tok === '-X' || tok === '--request') {
      method = (tokens[++t] ?? 'GET').toUpperCase();
    } else if (tok === '-H' || tok === '--header') {
      const hdr = tokens[++t] ?? '';
      const col = hdr.indexOf(':');
      if (col !== -1) rawHeaders.push({ key: hdr.slice(0, col).trim(), value: hdr.slice(col + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(tok)) {
      body = tokens[++t] ?? '';
      if (method === 'GET') method = 'POST';
    } else if (['--compressed', '-L', '--location', '-s', '--silent', '-i', '-v', '-k', '--insecure', '-g', '--globoff'].includes(tok)) {
      /* no-arg flags */
    } else if (tok === '--url') {
      url = tokens[++t] ?? '';
    } else if (['-m', '--max-time', '-o', '--output', '-A', '--user-agent', '-x', '--proxy', '-b', '--cookie', '-u', '--user', '-e', '--referer', '-T', '--upload-file', '--retry', '--connect-timeout'].includes(tok)) {
      t++; // skip next arg
    } else if (!tok.startsWith('-') && !url) {
      url = tok;
    }
    t++;
  }
  let cleanUrl = url;
  const parsedParams: KV[] = [];
  try {
    const u = new URL(url);
    u.searchParams.forEach((v, k) => parsedParams.push({ key: k, value: v }));
    u.search = '';
    cleanUrl = u.toString();
  } catch { /* keep */ }
  return {
    url_template: cleanUrl, method,
    headers: rawHeaders.length > 0 ? rawHeaders : [blankKV()],
    params:  parsedParams.length > 0 ? parsedParams : [blankKV()],
    body,
  };
}

// ─── Shared style tokens — mirrors reference file ────────────────────────────

const s: Record<string, React.CSSProperties> = {
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  label:     { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' },
  input: {
    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
    color: 'var(--text-primary)', padding: '7px 11px',
    fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none',
  },
  miniInput: {
    background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
    color: 'var(--text-primary)', padding: '5px 8px',
    fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none',
    width: '100%', boxSizing: 'border-box' as const,
  },
  tabBtn: {
    background: 'none', border: 'none', borderBottom: '2px solid', marginBottom: -1,
    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2,
    padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  iconBtn: {
    background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)', fontSize: 9, padding: '4px 7px', cursor: 'pointer', flexShrink: 0,
  },
  addBtn: {
    background: 'none', border: '1px dashed var(--border-dim)', color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2,
    padding: '3px 10px', cursor: 'pointer', marginTop: 3,
  },
  btnPrimary: {
    background: 'var(--acid)', color: '#0a0a0a', border: 'none',
    fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
    letterSpacing: 2, padding: '8px 16px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  btnGhost: {
    background: 'transparent', border: '1px solid var(--border-dim)',
    color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    fontSize: 9, letterSpacing: 1, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  btnApprove: {
    background: 'rgba(198,241,53,.15)', border: '1px solid var(--acid)',
    color: 'var(--acid)', fontFamily: 'var(--font-mono)',
    fontSize: 9, fontWeight: 700, letterSpacing: 2,
    padding: '8px 18px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
};

// ─── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: number | null }) {
  if (!status) return null;
  const c = status < 300 ? 'var(--acid)' : status < 400 ? 'var(--cyan)' : 'var(--red)';
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: c, border: `1px solid ${c}`, padding: '2px 8px', letterSpacing: 1 }}>
      {status}
    </span>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onClear, 5000);
    return () => clearTimeout(t);
  }, [msg, onClear]);
  if (!msg) return null;
  const err  = msg.startsWith('✗');
  const warn = msg.startsWith('⚠');
  const color = err ? 'rgba(255,61,90,.6)' : warn ? 'rgba(251,146,60,.6)' : 'rgba(198,241,53,.6)';
  const text  = err ? 'var(--red)' : warn ? 'rgba(251,146,60,.9)' : 'var(--acid)';
  return (
    <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 9999, background: 'var(--bg-elevated)', border: `1px solid ${color}`, color: text, padding: '11px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 8px 32px rgba(0,0,0,.7)', letterSpacing: 1, maxWidth: 480 }}>
      {msg}
    </div>
  );
}

// ─── KV Table — same as reference ────────────────────────────────────────────

function KVTable({ rows, onChange, placeholder }: {
  rows: KV[]; onChange: (r: KV[]) => void; placeholder: [string, string];
}) {
  const set = (i: number, k: keyof KV, v: string) =>
    onChange(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  return (
    <div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
          <input value={row.key}   onChange={e => set(i, 'key',   e.target.value)} placeholder={placeholder[0]} style={{ ...s.miniInput, flex: '0 0 36%' }} />
          <input value={row.value} onChange={e => set(i, 'value', e.target.value)} placeholder={placeholder[1]} style={{ ...s.miniInput, flex: 1 }} />
          <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} style={s.iconBtn}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, blankKV()])} style={s.addBtn}>⊕ ADD</button>
    </div>
  );
}

// ─── Smart KV Table — params with {{var}} support and field picker ─────────────
// Params can contain {{varName}} in their values. A {{}} button lets the user
// pick a field from the parent step to auto-insert and wire the variable.

function pathToVarName(path: string, role: string): string {
  if (role && role !== 'custom') return role;
  const seg = path.split('.').pop() ?? path;
  return seg.replace(/[^a-zA-Z0-9]/g, '_');
}

function VarChips({ value }: { value: string }) {
  const vars = parseVars(value);
  if (vars.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
      {vars.map(v => (
        <span key={v} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1, padding: '1px 6px', background: 'rgba(198,241,53,.08)', border: '1px solid rgba(198,241,53,.3)', color: 'var(--acid)' }}>
          {`{{${v}}}`}
        </span>
      ))}
    </div>
  );
}

function SmartKVTable({ rows, onChange, placeholder, parentFlat, parentFields, fieldMappings, onMappingsChange }: {
  rows:             KV[];
  onChange:         (r: KV[]) => void;
  placeholder:      [string, string];
  parentFlat:       { path: string; value: string; type: string }[];
  parentFields:     FieldDescriptor[];
  fieldMappings:    Record<string, string>;
  onMappingsChange: (m: Record<string, string>) => void;
}) {
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const set = (i: number, k: keyof KV, v: string) =>
    onChange(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));

  const insertVar = (rowIdx: number, varName: string, sourcePath: string) => {
    // Insert {{varName}} at cursor or append to value
    const inp = inputRefs.current[rowIdx];
    const cur = rows[rowIdx].value;
    const cursor = inp?.selectionStart ?? cur.length;
    const insertion = `{{${varName}}}`;
    const newVal = cur.slice(0, cursor) + insertion + cur.slice(cursor);
    onChange(rows.map((r, idx) => idx === rowIdx ? { ...r, value: newVal } : r));
    onMappingsChange({ ...fieldMappings, [varName]: sourcePath });
    setPickerRow(null);
    setPickerSearch('');
  };

  const filteredFields = parentFlat.filter(f =>
    !pickerSearch || f.path.toLowerCase().includes(pickerSearch.toLowerCase())
  );

  return (
    <div>
      {rows.map((row, i) => (
        <div key={i} style={{ marginBottom: 5 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              value={row.key}
              onChange={e => set(i, 'key', e.target.value)}
              placeholder={placeholder[0]}
              style={{ ...s.miniInput, flex: '0 0 36%' }}
            />
            <div style={{ flex: 1, position: 'relative' as const }}>
              <input
                ref={el => { inputRefs.current[i] = el; }}
                value={row.value}
                onChange={e => set(i, 'value', e.target.value)}
                placeholder={placeholder[1] + ' or {{var}}'}
                style={{
                  ...s.miniInput, width: '100%',
                  borderColor: parseVars(row.value).length > 0 ? 'rgba(198,241,53,.4)' : undefined,
                }}
              />
            </div>
            {/* {{}} insert button */}
            <button
              onClick={() => { setPickerRow(pickerRow === i ? null : i); setPickerSearch(''); }}
              title="Insert field variable"
              style={{
                ...s.iconBtn,
                borderColor: pickerRow === i ? 'rgba(198,241,53,.5)' : undefined,
                color: pickerRow === i ? 'var(--acid)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 8, letterSpacing: 0, padding: '4px 8px',
                whiteSpace: 'nowrap' as const,
              }}
            >{'{{}}'}</button>
            <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} style={s.iconBtn}>✕</button>
          </div>

          {/* Var chips inline preview */}
          <VarChips value={row.value} />

          {/* Field picker dropdown */}
          {pickerRow === i && (
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(198,241,53,.3)', borderTop: 'none', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: 'var(--acid)', marginBottom: 2 }}>
                PICK FIELD → inserts {'{{varName}}'} + wires field_mapping
              </div>
              {parentFlat.length === 0 ? (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.7)' }}>
                  ⚠ No parent step fields available — probe the parent step first
                </div>
              ) : (
                <>
                  <input
                    value={pickerSearch}
                    onChange={e => setPickerSearch(e.target.value)}
                    placeholder="Search fields…"
                    autoFocus
                    style={{ ...s.miniInput, fontSize: 9 }}
                  />
                  <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {filteredFields.length === 0 && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', padding: '4px 0' }}>No matches</div>
                    )}
                    {filteredFields.map(f => {
                      const pf = parentFields.find(pf => pf.path === f.path);
                      const varName = pathToVarName(f.path, pf?.role ?? 'custom');
                      const alreadyMapped = fieldMappings[varName] === f.path;
                      const typeColor = f.type === 'number' ? 'rgba(251,146,60,.8)' : f.type === 'boolean' ? 'rgba(6,182,212,.7)' : 'rgba(167,243,208,.7)';
                      return (
                        <button
                          key={f.path}
                          onClick={() => insertVar(i, varName, f.path)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                            background: alreadyMapped ? 'rgba(198,241,53,.07)' : 'transparent',
                            border: `1px solid ${alreadyMapped ? 'rgba(198,241,53,.2)' : 'transparent'}`,
                            cursor: 'pointer', textAlign: 'left' as const, width: '100%',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,182,212,.1)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = alreadyMapped ? 'rgba(198,241,53,.07)' : 'transparent'; }}
                        >
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: typeColor, flexShrink: 0 }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', flex: 1 }}>{f.path}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: typeColor, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{f.value.slice(0, 18)}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(198,241,53,.5)', border: '1px solid rgba(198,241,53,.2)', padding: '0 4px', flexShrink: 0 }}>{`{{${varName}}}`}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Or type manually */}
                  <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 5 }}>
                    <ManualVarInsert onInsert={(varName, sourcePath) => insertVar(i, varName, sourcePath)} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      <button onClick={() => onChange([...rows, blankKV()])} style={s.addBtn}>⊕ ADD</button>
    </div>
  );
}

// Mini "type a var name + source path manually" row inside the picker
function ManualVarInsert({ onInsert }: { onInsert: (varName: string, sourcePath: string) => void }) {
  const [vn, setVn] = useState('');
  const [sp, setSp] = useState('');
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', flexShrink: 0 }}>manual:</span>
      <input value={vn} onChange={e => setVn(e.target.value)} placeholder="var_name" style={{ ...s.miniInput, flex: '0 0 90px', fontSize: 8 }} />
      <input value={sp} onChange={e => setSp(e.target.value)} placeholder="source.path" style={{ ...s.miniInput, flex: 1, fontSize: 8 }} />
      <button onClick={() => { if (vn.trim()) { onInsert(vn.trim(), sp.trim()); setVn(''); setSp(''); } }} disabled={!vn.trim()} style={{ ...s.iconBtn, color: vn.trim() ? 'var(--acid)' : undefined, borderColor: vn.trim() ? 'rgba(198,241,53,.4)' : undefined, fontSize: 8 }}>+</button>
    </div>
  );
}

// ─── Multi-Bookmaker Selector ─────────────────────────────────────────────────
// Pill-based selector — choose N bookmakers to save a workflow for each.

function MultiBookmakerSelect({ bookmakers, selected, onChange }: {
  bookmakers: BookmakerOption[];
  selected:   number[];
  onChange:   (ids: number[]) => void;
}) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState('');

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  };

  const filtered = bookmakers.filter(b =>
    !search || b.name.toLowerCase().includes(search.toLowerCase()) || (b.domain ?? '').toLowerCase().includes(search.toLowerCase())
  );
  const available = filtered.filter(b => !selected.includes(b.id));

  return (
    <div style={{ position: 'relative' as const }}>
      <label style={s.label}>BOOKMAKERS <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(workflow saved for each)</span></label>
      <div
        style={{ background: 'var(--bg-base)', border: `1px solid ${open ? 'rgba(198,241,53,.4)' : 'var(--border-dim)'}`, minHeight: 36, padding: '4px 8px', display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}
        onClick={() => setOpen(o => !o)}
      >
        {selected.length === 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>— select bookmakers —</span>
        )}
        {selected.map(id => {
          const bm = bookmakers.find(b => b.id === id);
          if (!bm) return null;
          return (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(198,241,53,.1)', border: '1px solid rgba(198,241,53,.3)', padding: '2px 8px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)' }}>
              {bm.name}
              <button onClick={e => { e.stopPropagation(); toggle(id); }}
                style={{ background: 'none', border: 'none', color: 'rgba(198,241,53,.5)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          );
        })}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: 'var(--bg-elevated)', border: '1px solid rgba(198,241,53,.3)', borderTop: 'none', boxShadow: '0 8px 24px rgba(0,0,0,.7)', maxHeight: 260, overflowY: 'auto' }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-dim)' }}>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search bookmakers…" autoFocus
              onClick={e => e.stopPropagation()}
              style={{ ...s.miniInput, fontSize: 9 }}
            />
          </div>
          {/* Select all / clear */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-dim)' }}>
            <button onClick={e => { e.stopPropagation(); onChange(bookmakers.map(b => b.id)); setOpen(false); }}
              style={{ flex: 1, background: 'none', border: 'none', borderRight: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: 'var(--acid)', padding: '5px 0', cursor: 'pointer' }}>SELECT ALL</button>
            <button onClick={e => { e.stopPropagation(); onChange([]); }}
              style={{ flex: 1, background: 'none', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: 'var(--text-muted)', padding: '5px 0', cursor: 'pointer' }}>CLEAR</button>
          </div>
          {filtered.map(b => {
            const isSel = selected.includes(b.id);
            return (
              <div key={b.id}
                onClick={e => { e.stopPropagation(); toggle(b.id); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', background: isSel ? 'rgba(198,241,53,.06)' : 'transparent', borderBottom: '1px solid rgba(255,255,255,.04)' }}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(6,182,212,.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = isSel ? 'rgba(198,241,53,.06)' : 'transparent'; }}
              >
                <div style={{ width: 14, height: 14, border: `1px solid ${isSel ? 'var(--acid)' : 'var(--border-dim)'}`, background: isSel ? 'var(--acid)' : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {isSel && <span style={{ color: '#0a0a0a', fontSize: 9, fontWeight: 800 }}>✓</span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isSel ? 'var(--acid)' : 'var(--text-primary)' }}>{b.name}</div>
                  {b.domain && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{b.domain}</div>}
                </div>
              </div>
            );
          })}
          {available.length === 0 && filtered.length > 0 && filtered.every(b => selected.includes(b.id)) && (
            <div style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', textAlign: 'center' as const }}>✓ All bookmakers selected</div>
          )}
          <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border-dim)', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={e => { e.stopPropagation(); setOpen(false); }} style={{ ...s.btnGhost, fontSize: 8, padding: '4px 12px' }}>DONE ({selected.length} selected)</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── JSON tree (collapsible) ──────────────────────────────────────────────────

function JsonTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [c, setC] = useState(depth > 2);
  if (data === null)              return <span style={{ color: 'rgba(198,241,53,.45)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>null</span>;
  if (typeof data === 'boolean')  return <span style={{ color: 'rgba(6,182,212,.8)',   fontFamily: 'var(--font-mono)', fontSize: 9 }}>{String(data)}</span>;
  if (typeof data === 'number')   return <span style={{ color: 'rgba(251,146,60,.9)',  fontFamily: 'var(--font-mono)', fontSize: 9 }}>{data}</span>;
  if (typeof data === 'string')   return <span style={{ color: 'rgba(167,243,208,.85)', fontFamily: 'var(--font-mono)', fontSize: 9 }} title={data}>"{data.length > 60 ? data.slice(0, 60) + '…' : data}"</span>;
  if (Array.isArray(data)) {
    if (!data.length) return <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>[]</span>;
    return (
      <span>
        <span onClick={() => setC(x => !x)} style={{ color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9, userSelect: 'none' }}>
          {c ? `▶ [${data.length}]` : '▾ ['}
        </span>
        {!c && (
          <div style={{ marginLeft: depth * 14 + 14 }}>
            {data.slice(0, 30).map((it, i) => (
              <div key={i}>
                <JsonTree data={it} depth={depth + 1} />
                {i < data.length - 1 && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>,</span>}
              </div>
            ))}
            {data.length > 30 && <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>…{data.length - 30} more</div>}
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>]</span>
          </div>
        )}
      </span>
    );
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data as object);
    if (!keys.length) return <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{'{}'}</span>;
    return (
      <span>
        <span onClick={() => setC(x => !x)} style={{ color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9, userSelect: 'none' }}>
          {c ? `▶ {${keys.length}}` : '▾ {'}
        </span>
        {!c && (
          <div style={{ marginLeft: depth * 14 + 14 }}>
            {keys.map((k, i) => (
              <div key={k} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <span style={{ color: 'rgba(130,180,255,.8)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>"{k}"</span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>: </span>
                <JsonTree data={(data as Record<string, unknown>)[k]} depth={depth + 1} />
                {i < keys.length - 1 && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>,</span>}
              </div>
            ))}
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{'}'}</span>
          </div>
        )}
      </span>
    );
  }
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)' }}>{String(data)}</span>;
}

// ─── Role select ──────────────────────────────────────────────────────────────

function RoleSelect({ value, roles, onChange }: {
  value: string; roles: FieldRole[]; onChange: (r: string) => void;
}) {
  const c = roleAccent(value);
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: 'var(--bg-base)', border: `1px solid ${c}55`, color: c, fontFamily: 'var(--font-mono)', fontSize: 9, padding: '3px 6px', outline: 'none', cursor: 'pointer', minWidth: 130 }}>
      {roles.map(r => <option key={r.role} value={r.role} title={r.description}>{r.role}</option>)}
    </select>
  );
}

// ─── Fields table ─────────────────────────────────────────────────────────────

function FieldsTable({ fields, roles, onChange }: {
  fields: FieldDescriptor[]; roles: FieldRole[];
  onChange: (f: FieldDescriptor[]) => void;
}) {
  const [ap, setAp] = useState('');
  const [ar, setAr] = useState('custom');
  const [al, setAl] = useState('');
  const drag = useRef<number | null>(null);

  const upd  = (i: number, p: Partial<FieldDescriptor>) => onChange(fields.map((f, j) => j === i ? { ...f, ...p } : f));
  const rem  = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const drop = (i: number) => {
    if (drag.current === null || drag.current === i) return;
    const a = [...fields]; const [m] = a.splice(drag.current, 1); a.splice(i, 0, m);
    onChange(a); drag.current = null;
  };
  const add = () => {
    if (!ap.trim()) return;
    onChange([...fields, { path: ap.trim(), role: ar, label: al.trim() || ap.trim(), store: true }]);
    setAp(''); setAr('custom'); setAl('');
  };

  const COLS = '16px 1fr 130px 1fr 22px';

  return (
    <div>
      {fields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 6, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-dim)' }}>
          <span /><span>PATH</span><span>ROLE</span><span>LABEL</span><span />
        </div>
      )}
      {fields.map((f, i) => (
        <div key={i} draggable
          onDragStart={() => { drag.current = i; }}
          onDragOver={e => e.preventDefault()}
          onDrop={() => drop(i)}
          style={{ display: 'grid', gridTemplateColumns: COLS, gap: 6, padding: '4px 8px', alignItems: 'center', cursor: 'grab', borderBottom: '1px solid var(--border-dim)', transition: 'background .1s' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.025)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: roleAccent(f.role) }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 8, opacity: .4 }}>⋮⋮</span>
          </div>
          <input value={f.path}  onChange={e => upd(i, { path:  e.target.value })} style={{ ...s.miniInput, padding: '4px 8px' }} />
          <RoleSelect value={f.role} roles={roles} onChange={r => upd(i, { role: r })} />
          <input value={f.label} onChange={e => upd(i, { label: e.target.value })} style={{ ...s.miniInput, padding: '4px 8px' }} />
          <button onClick={() => rem(i)} style={{ background: 'none', border: 'none', color: 'rgba(255,61,90,.35)', cursor: 'pointer', fontSize: 14, padding: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.35)')}
          >×</button>
        </div>
      ))}
      {/* Add row */}
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 6, padding: '5px 8px', alignItems: 'center', borderTop: fields.length > 0 ? '1px solid var(--border-dim)' : 'none' }}>
        <span />
        <input value={ap} onChange={e => setAp(e.target.value)} placeholder="e.g. teams.home.name"
          onKeyDown={e => e.key === 'Enter' && add()} style={{ ...s.miniInput, padding: '4px 8px' }} />
        <select value={ar} onChange={e => setAr(e.target.value)} style={{ ...s.miniInput, padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
          {roles.map(r => <option key={r.role} value={r.role}>{r.role}</option>)}
        </select>
        <input value={al} onChange={e => setAl(e.target.value)} placeholder="Label (opt)" style={{ ...s.miniInput, padding: '4px 8px' }} />
        <button onClick={add} disabled={!ap.trim()}
          style={{ ...s.btnPrimary, padding: '4px 0', width: 22, fontSize: 14, fontWeight: 900, opacity: ap.trim() ? 1 : .3 }}>+</button>
      </div>
    </div>
  );
}

// ─── Endpoint Builder — mirrors reference EndpointBuilder exactly ─────────────
// (adapted: url_template instead of url, adds auto-detect, adds fields table)

function EndpointBuilder({ step, prevStep, allSteps, roles, onChange, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: {
  step:        DraftStep;
  prevStep:    DraftStep | null;
  allSteps:    DraftStep[];
  roles:       FieldRole[];
  onChange:    (p: Partial<DraftStep>) => void;
  onDelete:    () => void;
  onMoveUp:    () => void;
  onMoveDown:  () => void;
  canMoveUp:   boolean;
  canMoveDown: boolean;
}) {
  const sc = STEP_COLOR[step.step_type];
  const vars = parseVars(step.url_template);
  // All {{vars}} across URL, param values, and body
  const allVars = useMemo(() => {
    const urlVars   = parseVars(step.url_template);
    const paramVars = step.params.flatMap(p => parseVars(p.value));
    const bodyVars  = parseVars(step.body);
    return [...new Set([...urlVars, ...paramVars, ...bodyVars])];
  }, [step.url_template, step.params, step.body]);

  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'body'>('params');
  const [showRaw,   setShowRaw]   = useState(false);

  const prevFields  = prevStep?.fields ?? [];
  const parentFlat  = prevStep?.firstItem ? flattenObj(prevStep.firstItem as Record<string, unknown>) : prevFields.map(f => ({ path: f.path, value: String(f.sample ?? ''), type: 'string' }));
  const fieldMaps   = step.field_mappings ?? {};

  const resolvedMap = useMemo(() => {
    const m: Record<string, string> = {};
    // First: use explicit field_mappings → look up sample value from parentFlat
    Object.entries(fieldMaps).forEach(([varName, srcPath]) => {
      const src = parentFlat.find(f => f.path === srcPath);
      if (src && src.value && src.value !== '[…]') m[varName] = src.value;
    });
    // Fallback: role-matched fields from prevStep
    prevFields.forEach(f => { if (f.sample !== undefined && !m[f.role]) m[f.role] = String(f.sample); });
    allVars.forEach(v => { if (!m[v]) m[v] = `<${v}>`; });
    return m;
  }, [prevFields, parentFlat, fieldMaps, allVars]);

  const resolvedUrl = step.url_template.replace(/\{\{(\w+)\}\}/g, (_, v) => resolvedMap[v] ?? `{{${v}}}`);
  const paramCount  = Object.keys(kvToObj(step.params)).length;
  const headerCount = Object.keys(kvToObj(step.headers)).length;
  const hasBody     = !!step.body.trim();

  // Import curl exactly as reference
  const importCurl = (text: string) => {
    if (!text.trim()) return;
    try {
      const p = parseCurl(text);
      onChange(p);
      setCurlOpen(false);
      setCurlText('');
      if (p.params.some(x => x.key)) setActiveTab('params');
      else if (p.headers.some(x => x.key)) setActiveTab('headers');
      else if (p.body) setActiveTab('body');
    } catch { /* */ }
  };

  const doProbe = async (autoDetect: boolean) => {
    if (!step.url_template.trim()) return;
    onChange({ probeStatus: 'probing', probeError: '' });
    try {
      const payload = { url: resolvedUrl, method: step.method, headers: kvToObj(step.headers), params: kvToObj(step.params), body: step.body || null };
      const res = await apiFetch(autoDetect ? '/extract-first-item' : '/probe', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        onChange({
          probeStatus: 'ok', probeResponse: res.response, probeHttpStatus: res.status,
          ...(autoDetect ? {
            firstItem:         res.first_item ?? null,
            result_array_path: res.array_path  ?? step.result_array_path,
            fields:            res.fields      ?? step.fields,
          } : {}),
        });
      } else {
        onChange({ probeStatus: 'error', probeError: res.error ?? 'Probe failed' });
      }
    } catch (e: any) {
      onChange({ probeStatus: 'error', probeError: e.message ?? 'Network error' });
    }
  };

  const reDetect = async () => {
    if (!step.probeResponse) return;
    const res = await apiFetch('/detect-fields', { method: 'POST', body: JSON.stringify({ json: step.probeResponse, array_path: step.result_array_path || null }) });
    if (res.ok) onChange({ result_array_path: res.array_path ?? step.result_array_path, fields: res.fields ?? step.fields, firstItem: res.first_item ?? null });
  };

  const probeStatusColor = { idle: 'var(--text-muted)', probing: 'rgba(251,146,60,.9)', ok: 'var(--acid)', error: 'var(--red)' }[step.probeStatus];

  return (
    <div style={{ border: `1px solid ${sc.border}`, background: 'var(--bg-surface)' }}>

      {/* ── Header — identical layout to reference EndpointBuilder header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: `1px solid ${sc.border}`, background: sc.bg }}>
        {/* Position badge */}
        <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: sc.fg, color: '#060b06', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 800 }}>
          {step.position}
        </div>
        {/* Step type */}
        <select value={step.step_type} onChange={e => onChange({ step_type: e.target.value as StepType })}
          style={{ background: `${sc.fg}15`, border: `1px solid ${sc.fg}44`, color: sc.fg, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1, padding: '3px 7px', outline: 'none', cursor: 'pointer' }}>
          {(Object.keys(STEP_TYPES) as StepType[]).map(t => (
            <option key={t} value={t}>{STEP_TYPES[t].icon} {t}</option>
          ))}
        </select>
        {/* Name */}
        <input value={step.name} onChange={e => onChange({ name: e.target.value })}
          style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-dim)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, outline: 'none', flex: 1, padding: '2px 4px' }}
          placeholder="Step name"
        />
        {/* Probe status */}
        {step.probeResponse && <StatusPill status={step.probeHttpStatus} />}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: probeStatusColor, display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, animation: step.probeStatus === 'probing' ? 'pulse 1s ease-in-out infinite' : 'none' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: probeStatusColor }} />
          {step.probeStatus === 'probing' ? 'PROBING…' : step.probeStatus === 'ok' ? `HTTP ${step.probeHttpStatus ?? '2xx'}` : step.probeStatus === 'error' ? 'ERROR' : 'NOT PROBED'}
        </div>
        {/* Move up / down */}
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={onMoveUp}   disabled={!canMoveUp}   style={{ ...s.btnGhost, padding: '3px 7px', opacity: canMoveUp   ? 1 : .2 }}>▲</button>
          <button onClick={onMoveDown} disabled={!canMoveDown} style={{ ...s.btnGhost, padding: '3px 7px', opacity: canMoveDown ? 1 : .2 }}>▼</button>
        </div>
        {/* Delete */}
        <button onClick={onDelete}
          style={{ background: 'none', border: 'none', color: 'rgba(255,61,90,.35)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.35)')}
        >⊗</button>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* IMPORT FROM CURL — exact same toggle pattern as reference */}
        <button
          onClick={() => setCurlOpen(o => !o)}
          style={{ width: '100%', background: curlOpen ? `${sc.fg}10` : 'transparent', border: `1px solid ${curlOpen ? sc.fg + '55' : 'var(--border-dim)'}`, color: curlOpen ? sc.fg : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '6px 10px', cursor: 'pointer', textAlign: 'left' as const, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>⊕ IMPORT FROM CURL</span>
          <span style={{ opacity: .5 }}>{curlOpen ? '▲' : '▼'}</span>
        </button>

        {curlOpen && (
          <div style={{ border: `1px solid ${sc.fg}22`, borderTop: 'none', background: `${sc.fg}05`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: `${sc.fg}99` }}>
              AUTO-POPULATES URL · METHOD · HEADERS · PARAMS · BODY
            </div>
            <textarea
              value={curlText}
              onChange={e => setCurlText(e.target.value)}
              onPaste={e => {
                setTimeout(() => {
                  const v = e.clipboardData?.getData('text') ?? '';
                  if ((v || curlText).trim().toLowerCase().startsWith('curl')) importCurl(v || curlText);
                }, 80);
              }}
              rows={4}
              placeholder={`curl -X GET 'https://api.bookmaker.com/events' \\\n  -H 'Authorization: Bearer TOKEN' \\\n  -H 'x-api-key: KEY'`}
              spellCheck={false}
              style={{ ...s.miniInput, resize: 'vertical', boxSizing: 'border-box' as const, lineHeight: 1.5, fontSize: 10 }}
            />
            <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
              <button onClick={() => { setCurlOpen(false); setCurlText(''); }} style={s.btnGhost}>CANCEL</button>
              <button onClick={() => importCurl(curlText)} disabled={!curlText.trim()}
                style={{ ...s.btnPrimary, flex: 1, padding: '6px 0', background: sc.fg, fontSize: 8, letterSpacing: 2, opacity: curlText.trim() ? 1 : .4 }}>
                IMPORT & POPULATE
              </button>
            </div>
          </div>
        )}

        {/* FETCH_PER_ITEM: depends-on selector + visual field wirer */}
        {step.step_type === 'FETCH_PER_ITEM' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Which step to iterate */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'rgba(6,182,212,.05)', border: '1px solid rgba(6,182,212,.15)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)', letterSpacing: 1.5, flexShrink: 0 }}>ITERATES STEP</span>
              <select value={step.depends_on_pos ?? ''} onChange={e => onChange({ depends_on_pos: e.target.value ? parseInt(e.target.value) : null, field_mappings: {} })}
                style={{ background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.3)', color: '#67e8f9', fontFamily: 'var(--font-mono)', fontSize: 9, padding: '4px 8px', outline: 'none' }}>
                <option value="">— pick step —</option>
                {allSteps.filter(a => a.position !== step.position).map(a => (
                  <option key={a.localId} value={a.position}>{a.position}. {a.name}</option>
                ))}
              </select>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>items feed URL template vars</span>
            </div>

            {/* Visual field wirer — shown once parent step is known */}
            {prevStep && allVars.length > 0 && (
              <FieldLinkerPanel
                prevStep={prevStep}
                vars={allVars}
                mappings={fieldMaps}
                onChange={m => onChange({ field_mappings: m })}
              />
            )}
          </div>
        )}

        {/* Method + URL — same layout as reference */}
        <div style={{ display: 'flex', gap: 5 }}>
          <select value={step.method} onChange={e => onChange({ method: e.target.value })}
            style={{ ...s.miniInput, flex: '0 0 80px', color: 'var(--cyan)', fontWeight: 700 }}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
          </select>
          <input
            value={step.url_template}
            onChange={e => onChange({ url_template: e.target.value })}
            placeholder="https://api.bookmaker.com/v2/events/{{match_id}}/odds"
            style={{ ...s.miniInput, flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && doProbe(false)}
          />
        </div>

        {/* Resolved preview + var chips — show for URL vars and param vars */}
        {allVars.length > 0 && (
          <>
            {vars.length > 0 && (
              <div style={{ padding: '5px 9px', background: 'var(--bg-base)', border: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                <span style={{ letterSpacing: 1.5, fontSize: 8, opacity: .6 }}>RESOLVED → </span>
                <span style={{ color: 'var(--text-secondary)' }}>{resolvedUrl}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {allVars.map(v => {
                const wired   = !!fieldMaps[v];
                const roleMat = !!prevFields.find(f => f.role === v);
                const ok      = wired || roleMat;
                const inUrl   = vars.includes(v);
                const inParam = step.params.some(p => parseVars(p.value).includes(v));
                const inBody  = parseVars(step.body).includes(v);
                const sources = [inUrl && 'URL', inParam && 'PARAM', inBody && 'BODY'].filter(Boolean).join('+');
                return (
                  <span key={v} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1, padding: '2px 8px', background: ok ? 'rgba(198,241,53,.08)' : 'rgba(251,146,60,.08)', border: `1px solid ${ok ? 'rgba(198,241,53,.35)' : 'rgba(251,146,60,.35)'}`, color: ok ? 'var(--acid)' : '#fb923c' }}>
                    {`{{${v}}}`}
                    <span style={{ opacity: .5, fontSize: 7, marginLeft: 4 }}>{sources}</span>
                    {wired   && <span style={{ marginLeft: 4, opacity: .7 }}>✓ {fieldMaps[v]}</span>}
                    {!wired && roleMat && <span style={{ marginLeft: 4, opacity: .6 }}>✓ role</span>}
                    {!ok     && <span style={{ marginLeft: 4 }}>⚠ unlinked</span>}
                  </span>
                );
              })}
            </div>
          </>
        )}

        {/* Params / Headers / Body tabs — identical to reference */}
        <div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 6 }}>
            {(['params', 'headers', 'body'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                style={{ ...s.tabBtn, fontSize: 7, color: activeTab === tab ? sc.fg : 'var(--text-muted)', borderBottomColor: activeTab === tab ? sc.fg : 'transparent' }}>
                {tab === 'params'  && `PARAMS${paramCount  ? ` (${paramCount})`  : ''}`}
                {tab === 'headers' && `HEADERS${headerCount ? ` (${headerCount})` : ''}`}
                {tab === 'body'    && `BODY${hasBody ? ' ●' : ''}`}
              </button>
            ))}
          </div>
          {activeTab === 'params'  && (
            <SmartKVTable
              rows={step.params}
              onChange={p => onChange({ params: p })}
              placeholder={['param', 'value']}
              parentFlat={parentFlat}
              parentFields={prevFields}
              fieldMappings={fieldMaps}
              onMappingsChange={m => onChange({ field_mappings: m })}
            />
          )}
          {activeTab === 'headers' && <KVTable rows={step.headers} onChange={h => onChange({ headers: h })} placeholder={['Header', 'value']} />}
          {activeTab === 'body'    && (
            <textarea value={step.body} onChange={e => onChange({ body: e.target.value })}
              rows={4} placeholder={'{\n  "key": "value"\n}'} spellCheck={false}
              style={{ ...s.miniInput, width: '100%', resize: 'vertical', boxSizing: 'border-box' as const, lineHeight: 1.5 }} />
          )}
        </div>

        {/* Probe buttons */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <button onClick={() => doProbe(false)} disabled={!step.url_template.trim() || step.probeStatus === 'probing'}
            style={{ ...s.btnPrimary, width: '100%', padding: '8px 0', background: sc.fg, opacity: (step.url_template.trim() && step.probeStatus !== 'probing') ? 1 : .4, fontSize: 8, letterSpacing: 2 }}>
            {step.probeStatus === 'probing' ? '⟳ PROBING…' : `▶ SEND (PROBE)`}
          </button>
          <button onClick={() => doProbe(true)} disabled={!step.url_template.trim() || step.probeStatus === 'probing'}
            style={{ ...s.btnGhost, flex: 1, padding: '6px 0', textAlign: 'center' as const, opacity: step.url_template.trim() ? 1 : .4, borderColor: 'rgba(6,182,212,.4)', color: 'var(--cyan)', fontSize: 8, letterSpacing: 2 }}>
            ⟳ PROBE + AUTO-DETECT FIELDS
          </button>
          {step.probeResponse && (
            <button onClick={reDetect} style={{ ...s.btnGhost, fontSize: 8 }}>↻ RE-DETECT</button>
          )}
          {step.probeResponse && (
            <button onClick={() => setShowRaw(r => !r)} style={{ ...s.btnGhost, fontSize: 8 }}>{showRaw ? 'TREE VIEW' : 'RAW JSON'}</button>
          )}
        </div>

        {/* Error */}
        {step.probeStatus === 'error' && (
          <div style={{ padding: '8px 10px', background: 'rgba(255,61,90,.04)', border: '1px solid rgba(255,61,90,.25)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)' }}>
            ✗ {step.probeError}
          </div>
        )}

        {/* Response panels */}
        {step.probeResponse && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', padding: '4px 8px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                RESPONSE
              </div>
              <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 240, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                {showRaw
                  ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-secondary)', fontSize: 9 }}>{fmtJson(step.probeResponse)}</pre>
                  : <JsonTree data={step.probeResponse} />}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', padding: '4px 8px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', display: 'flex', gap: 6 }}>
                FIRST ITEM
                {step.result_array_path && <span style={{ color: 'var(--acid)' }}>@ {step.result_array_path}</span>}
              </div>
              <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 240, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                {step.firstItem
                  ? <JsonTree data={step.firstItem} />
                  : <span style={{ color: 'var(--text-muted)', fontSize: 8 }}>Click PROBE + AUTO-DETECT to extract first array item</span>
                }
              </div>
            </div>
          </div>
        )}

        {/* Array path + Notes */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={s.fieldWrap}>
            <label style={s.label}>RESULT ARRAY PATH</label>
            <input value={step.result_array_path} onChange={e => onChange({ result_array_path: e.target.value })}
              placeholder="e.g. data.events  (blank = root is array)" style={s.input} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', opacity: .6 }}>dot-path to array; blank = root</span>
          </div>
          <div style={s.fieldWrap}>
            <label style={s.label}>NOTES</label>
            <input value={step.notes} onChange={e => onChange({ notes: e.target.value })}
              placeholder="e.g. requires auth cookie" style={s.input} />
          </div>
        </div>

        {/* Field mappings */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
            <label style={{ ...s.label, marginBottom: 0 }}>FIELD MAPPINGS</label>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>
              {step.fields.length} fields · drag to reorder
            </span>
          </div>
          <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-base)' }}>
            <FieldsTable fields={step.fields} roles={roles} onChange={fields => onChange({ fields })} />
          </div>
        </div>

      </div>
    </div>
  );
}

// Step 1 has no probeResult on DraftStep — add a helper accessor
declare module './EndpointResearch' {}
// (TypeScript helper — probeResult lives as probeResponse/probeHttpStatus on DraftStep)

// ─── Step connector arrow — wire diagram ─────────────────────────────────────

function StepConnector({ from, to }: { from: DraftStep; to: DraftStep }) {
  const vars       = parseVars(to.url_template);
  const mappings   = to.field_mappings ?? {};
  const parentFlat = from.firstItem ? flattenObj(from.firstItem as Record<string, unknown>) : from.fields.map(f => ({ path: f.path, value: String(f.sample ?? ''), type: 'string' }));

  if (vars.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 0' }}>
        <div style={{ width: 1, height: 20, background: 'rgba(198,241,53,.2)' }} />
        <div style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid rgba(198,241,53,.25)' }} />
      </div>
    );
  }

  return (
    <div style={{ margin: '0 0', padding: '10px 16px', background: 'rgba(0,0,0,.25)', borderLeft: '1px solid var(--border-dim)', borderRight: '1px solid var(--border-dim)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'rgba(198,241,53,.4)' }}>STEP {from.position}</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-dim)' }} />
        <span>FIELD WIRING</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-dim)' }} />
        <span style={{ color: 'rgba(6,182,212,.4)' }}>STEP {to.position}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {vars.map(v => {
          const srcPath = mappings[v];
          const srcField = srcPath ? parentFlat.find(f => f.path === srcPath) : null;
          const assigned = !!srcPath;
          return (
            <div key={v} style={{ display: 'grid', gridTemplateColumns: '1fr 36px 1fr', alignItems: 'center', gap: 4 }}>
              {/* Source */}
              <div style={{ padding: '3px 8px', background: assigned ? 'rgba(198,241,53,.07)' : 'rgba(251,146,60,.04)', border: `1px solid ${assigned ? 'rgba(198,241,53,.25)' : 'rgba(251,146,60,.15)'}`, fontFamily: 'var(--font-mono)', fontSize: 8, color: assigned ? 'var(--acid)' : 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                {assigned ? (
                  <>
                    <span style={{ opacity: .6, fontSize: 7 }}>from</span>
                    <span style={{ flex: 1, textAlign: 'center' as const }}>{srcPath}</span>
                    {srcField && <span style={{ opacity: .5, fontSize: 7, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={srcField.value}>{srcField.value}</span>}
                  </>
                ) : (
                  <span style={{ opacity: .4, fontSize: 7, letterSpacing: 1 }}>— not linked —</span>
                )}
              </div>
              {/* Arrow */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 12, color: assigned ? 'var(--acid)' : 'rgba(251,146,60,.4)' }}>→</span>
              </div>
              {/* Target var */}
              <div style={{ padding: '3px 8px', background: assigned ? 'rgba(6,182,212,.07)' : 'rgba(251,146,60,.04)', border: `1px solid ${assigned ? 'rgba(6,182,212,.3)' : 'rgba(251,146,60,.3)'}`, fontFamily: 'var(--font-mono)', fontSize: 8, color: assigned ? 'var(--cyan)' : '#fb923c', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ opacity: .5 }}>{'{{'}</span>{v}<span style={{ opacity: .5 }}>{'}}'}</span>
                {assigned ? <span style={{ marginLeft: 'auto', color: 'var(--acid)', fontSize: 10 }}>✓</span> : <span style={{ marginLeft: 'auto', fontSize: 9 }}>⚠</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Field Linker Panel ───────────────────────────────────────────────────────
// Visual two-column UI: parent step fields (left) → template vars (right)
// Click a field chip on the left to "select" it, then click a var slot to assign.

function FieldLinkerPanel({ prevStep, vars, mappings, onChange }: {
  prevStep:  DraftStep;
  vars:      string[];
  mappings:  Record<string, string>;
  onChange:  (m: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null); // selected source path
  const [activeVar, setActiveVar] = useState<string | null>(null); // actively editing var

  // Build flat field list from prevStep
  const flatFields = useMemo(() => {
    if (prevStep.firstItem) return flattenObj(prevStep.firstItem as Record<string, unknown>);
    return prevStep.fields.map(f => ({ path: f.path, value: String(f.sample ?? ''), type: 'string' }));
  }, [prevStep.firstItem, prevStep.fields]);

  const assign = (varName: string, sourcePath: string) => {
    onChange({ ...mappings, [varName]: sourcePath });
    setSelected(null);
    setActiveVar(null);
  };

  const unassign = (varName: string) => {
    const next = { ...mappings };
    delete next[varName];
    onChange(next);
  };

  const assignedPaths = new Set(Object.values(mappings));
  const allAssigned   = vars.every(v => mappings[v]);

  const typeColor = (t: string) =>
    t === 'number' ? 'rgba(251,146,60,.8)' :
    t === 'boolean'? 'rgba(6,182,212,.7)'  :
    t === 'array'  ? 'rgba(216,180,254,.7)':
    'rgba(167,243,208,.7)';

  if (vars.length === 0) return null;
  if (flatFields.length === 0) {
    return (
      <div style={{ padding: '8px 10px', background: 'rgba(251,146,60,.04)', border: '1px solid rgba(251,146,60,.2)', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.7)' }}>
        ⚠ No fields available from Step {prevStep.position} — probe it first (PROBE + AUTO-DETECT)
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid rgba(6,182,212,.2)', background: 'rgba(6,182,212,.03)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(6,182,212,.15)', background: 'rgba(6,182,212,.05)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--cyan)' }}>⟳ FIELD WIRING</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>
          click a field → click a var to assign
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 7, color: allAssigned ? 'var(--acid)' : 'rgba(251,146,60,.8)', letterSpacing: 1 }}>
          {Object.keys(mappings).length}/{vars.length} WIRED
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>

        {/* Left: source fields from parent step */}
        <div style={{ borderRight: '1px solid rgba(6,182,212,.1)', padding: '8px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 }}>
            STEP {prevStep.position} FIELDS  ({flatFields.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
            {flatFields.map(f => {
              const isSelected   = selected === f.path;
              const isAssigned   = assignedPaths.has(f.path);
              const assignedToVar = isAssigned ? Object.entries(mappings).find(([, v]) => v === f.path)?.[0] : null;
              return (
                <button
                  key={f.path}
                  onClick={() => {
                    if (isSelected) { setSelected(null); return; }
                    setSelected(f.path);
                    // If exactly one unassigned var, auto-assign
                    const unassigned = vars.filter(v => !mappings[v]);
                    if (unassigned.length === 1) assign(unassigned[0], f.path);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                    background: isSelected ? 'rgba(6,182,212,.15)' : isAssigned ? 'rgba(198,241,53,.06)' : 'transparent',
                    border: `1px solid ${isSelected ? 'rgba(6,182,212,.5)' : isAssigned ? 'rgba(198,241,53,.2)' : 'transparent'}`,
                    cursor: 'pointer', textAlign: 'left' as const, width: '100%', transition: 'all .1s',
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(6,182,212,.06)'; }}
                  onMouseLeave={e => { if (!isSelected && !isAssigned) e.currentTarget.style.background = 'transparent'; else if (!isSelected) e.currentTarget.style.background = 'rgba(198,241,53,.06)'; }}
                >
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: typeColor(f.type), flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: isSelected ? 'var(--cyan)' : isAssigned ? 'var(--acid)' : 'var(--text-secondary)', flex: 1, wordBreak: 'break-all' as const }}>{f.path}</span>
                  {f.value && f.value !== '[…]' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: typeColor(f.type), maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, opacity: .7 }} title={f.value}>{f.value.slice(0, 20)}</span>
                  )}
                  {assignedToVar && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(198,241,53,.6)', border: '1px solid rgba(198,241,53,.2)', padding: '0 4px' }}>{`→{{${assignedToVar}}}`}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: template vars + assignment */}
        <div style={{ padding: '8px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 }}>
            ALL TEMPLATE VARS (URL · PARAMS · BODY)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {vars.map(v => {
              const srcPath   = mappings[v];
              const srcField  = srcPath ? flatFields.find(f => f.path === srcPath) : null;
              const isActive  = activeVar === v;
              const isPickMode = selected !== null;

              return (
                <div key={v}>
                  {/* Var slot */}
                  <div
                    onClick={() => {
                      if (selected) { assign(v, selected); return; }
                      setActiveVar(isActive ? null : v);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                      background: isPickMode ? 'rgba(6,182,212,.1)' : srcPath ? 'rgba(198,241,53,.07)' : 'rgba(251,146,60,.05)',
                      border: `1px solid ${isPickMode ? 'rgba(6,182,212,.4)' : srcPath ? 'rgba(198,241,53,.3)' : 'rgba(251,146,60,.3)'}`,
                      cursor: 'pointer', transition: 'all .15s',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isPickMode ? 'var(--cyan)' : srcPath ? 'var(--acid)' : '#fb923c' }}>
                      {'{{'}{v}{'}}'}
                    </span>
                    {isPickMode && !srcPath && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)', letterSpacing: 1, marginLeft: 4 }}>← click to assign</span>
                    )}
                    {isPickMode && srcPath && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)', letterSpacing: 1, marginLeft: 4 }}>← click to reassign</span>
                    )}
                    {srcPath && !isPickMode && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', flex: 1, marginLeft: 4 }}>
                        ← {srcPath}
                        {srcField && <span style={{ opacity: .5, marginLeft: 6 }}>{srcField.value.slice(0, 16)}</span>}
                      </span>
                    )}
                    {!srcPath && !isPickMode && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(251,146,60,.6)', letterSpacing: 1, flex: 1, marginLeft: 4 }}>unassigned</span>
                    )}
                    {srcPath && (
                      <button
                        onClick={e => { e.stopPropagation(); unassign(v); }}
                        style={{ background: 'none', border: 'none', color: 'rgba(255,61,90,.35)', fontSize: 12, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.35)')}
                      >×</button>
                    )}
                  </div>

                  {/* Manual fallback input if var is unassigned */}
                  {isActive && !selected && (
                    <div style={{ padding: '5px 8px', background: 'rgba(0,0,0,.3)', border: '1px solid var(--border-dim)', borderTop: 'none' }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginBottom: 4 }}>ASSIGN PATH MANUALLY or pick from left panel</div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <select
                          value={srcPath ?? ''}
                          onChange={e => { if (e.target.value) assign(v, e.target.value); }}
                          style={{ ...s.miniInput, flex: 1, fontSize: 8 }}
                        >
                          <option value="">— select field —</option>
                          {flatFields.map(f => (
                            <option key={f.path} value={f.path}>{f.path} ({f.value.slice(0, 20)})</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selected && (
            <div style={{ marginTop: 8, padding: '5px 8px', background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.25)', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ opacity: .7 }}>SELECTED:</span>
              <span style={{ flex: 1 }}>{selected}</span>
              <span>← now click a var</span>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Workflow Test Runner types ───────────────────────────────────────────────

interface SubRun {
  index:        number;
  resolvedUrl:  string;
  httpStatus:   number | null;
  latency_ms:   number | null;
  itemCount:    number;
  items:        unknown[];
  fields:       Record<string, unknown>[];  // extracted field rows
  error:        string | null;
  rawSize:      number;
}

interface StepRunResult {
  stepPos:    number;
  stepName:   string;
  stepType:   StepType;
  status:     'pending' | 'running' | 'ok' | 'error' | 'skipped';
  resolvedUrl: string;
  httpStatus:  number | null;
  latency_ms:  number | null;
  itemCount:   number;
  items:       unknown[];   // up to 5 raw items
  fields:      Record<string, unknown>[];  // extracted field rows
  error:       string | null;
  rawSize:     number;
  // FETCH_PER_ITEM only
  subRuns:     SubRun[];
  maxSubRuns:  number;      // how many sub-runs were requested
}

// Extract mapped fields from a single item
function extractFields(item: unknown, fieldDefs: FieldDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!item || typeof item !== 'object') return out;
  fieldDefs.forEach(f => {
    const v = getNestedValue(item, f.path);
    if (v !== undefined) out[f.label || f.role] = v;
  });
  return out;
}

// ─── WorkflowTestPanel ────────────────────────────────────────────────────────

function WorkflowTestPanel({ steps, onClose }: {
  steps:   DraftStep[];
  onClose: () => void;
}) {
  const sorted = [...steps].sort((a, b) => a.position - b.position);

  const initResults = (): StepRunResult[] => sorted.map(s => ({
    stepPos: s.position, stepName: s.name, stepType: s.step_type,
    status: 'pending', resolvedUrl: '', httpStatus: null, latency_ms: null,
    itemCount: 0, items: [], fields: [], error: null, rawSize: 0, subRuns: [], maxSubRuns: 3,
  }));

  const [results,   setResults]   = useState<StepRunResult[]>(initResults);
  const [running,   setRunning]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [expanded,  setExpanded]  = useState<Record<number, boolean>>({});
  const [subLimit,  setSubLimit]  = useState<Record<number, number>>({});  // pos → max items to iterate
  const [activeTab, setActiveTab] = useState<Record<number, 'fields'|'raw'|'subs'>>({});
  const abortRef = useRef<AbortController | null>(null);

  const toggleExpand = (pos: number) => setExpanded(p => ({ ...p, [pos]: !p[pos] }));
  const getTab = (pos: number): 'fields'|'raw'|'subs' => activeTab[pos] ?? 'fields';
  const setTab = (pos: number, t: 'fields'|'raw'|'subs') => setActiveTab(p => ({ ...p, [pos]: t }));
  const getSubLimit = (pos: number) => subLimit[pos] ?? 3;

  const upd = (pos: number, patch: Partial<StepRunResult>) =>
    setResults(prev => prev.map(r => r.stepPos === pos ? { ...r, ...patch } : r));

  // ── Run the full workflow ──────────────────────────────────────────────────

  const run = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setResults(initResults());
    setRunning(true);
    setDone(false);

    // Map: stepPos → extracted items from that step
    const stepItems: Record<number, unknown[]> = {};

    for (const step of sorted) {
      const pos = step.position;
      upd(pos, { status: 'running' });

      try {
        if (step.step_type === 'FETCH_LIST' || step.step_type === 'FETCH_ONCE') {
          // Simple single fetch
          const t0  = Date.now();
          const res = await apiFetch('/probe', {
            method: 'POST', signal: ctrl.signal,
            body: JSON.stringify({
              url:     step.url_template,
              method:  step.method,
              headers: kvToObj(step.headers),
              params:  kvToObj(step.params),
              body:    step.body || null,
            }),
          });
          const ms = Date.now() - t0;
          if (!res.ok) {
            upd(pos, { status: 'error', error: res.error ?? 'Probe failed', latency_ms: ms });
            break;
          }
          const items = extractArray(res.response, step.result_array_path);
          const fields = items.slice(0, 5).map(it => extractFields(it, step.fields));
          stepItems[pos] = items;
          upd(pos, {
            status: 'ok', resolvedUrl: step.url_template,
            httpStatus: res.status, latency_ms: ms,
            itemCount: items.length, items: items.slice(0, 5),
            fields, rawSize: res.size_bytes ?? 0,
          });

        } else if (step.step_type === 'FETCH_PER_ITEM') {
          // Iterate items from parent step
          const parentPos   = step.depends_on_pos;
          const parentItems = parentPos ? (stepItems[parentPos] ?? []) : [];
          const limit       = getSubLimit(pos);
          const toRun       = parentItems.slice(0, limit);

          if (toRun.length === 0) {
            upd(pos, { status: 'error', error: `No items from step ${parentPos} to iterate`, maxSubRuns: limit });
            break;
          }

          const subRuns: SubRun[] = [];
          let totalItems = 0;
          const allFields: Record<string, unknown>[] = [];

          for (let i = 0; i < toRun.length; i++) {
            const parentItem = toRun[i] as Record<string, unknown>;
            const { url: resolvedUrl, params: resolvedParams } =
              resolveTemplate(step.url_template, step.params, step.field_mappings ?? {}, parentItem);

            const t0  = Date.now();
            const res = await apiFetch('/probe', {
              method: 'POST', signal: ctrl.signal,
              body: JSON.stringify({
                url:     resolvedUrl,
                method:  step.method,
                headers: kvToObj(step.headers),
                params:  resolvedParams,
                body:    step.body || null,
              }),
            });
            const ms = Date.now() - t0;

            if (!res.ok) {
              subRuns.push({ index: i, resolvedUrl, httpStatus: res.status, latency_ms: ms, itemCount: 0, items: [], fields: [], error: res.error ?? 'Failed', rawSize: 0 });
              continue;
            }
            const items  = extractArray(res.response, step.result_array_path);
            const fields = items.slice(0, 3).map(it => extractFields(it, step.fields));
            totalItems += items.length;
            allFields.push(...fields);
            subRuns.push({ index: i, resolvedUrl, httpStatus: res.status, latency_ms: ms, itemCount: items.length, items: items.slice(0, 3), fields, error: null, rawSize: res.size_bytes ?? 0 });
          }

          const allSubOk = subRuns.every(sr => !sr.error);
          stepItems[pos] = subRuns.flatMap(sr => sr.items);

          upd(pos, {
            status: allSubOk ? 'ok' : 'error',
            resolvedUrl: `${toRun.length}× requests`,
            httpStatus: null, latency_ms: subRuns.reduce((a, sr) => a + (sr.latency_ms ?? 0), 0),
            itemCount: totalItems, items: stepItems[pos].slice(0, 5),
            fields: allFields.slice(0, 10),
            error: allSubOk ? null : `${subRuns.filter(sr => sr.error).length} sub-request(s) failed`,
            subRuns, maxSubRuns: limit, rawSize: subRuns.reduce((a, sr) => a + sr.rawSize, 0),
          });
        }

      } catch (e: any) {
        if (e.name === 'AbortError') { upd(pos, { status: 'skipped', error: 'Aborted' }); break; }
        upd(pos, { status: 'error', error: e.message });
        break;
      }
    }

    setRunning(false);
    setDone(true);
  };

  const abort = () => { abortRef.current?.abort(); setRunning(false); };

  const totalFields = results.reduce((a, r) => a + r.fields.length, 0);
  const allOk       = results.every(r => r.status === 'ok' || r.status === 'pending');

  // Status colours
  const sc = (status: StepRunResult['status']) => ({
    pending: { fg: 'var(--text-muted)',           icon: '○' },
    running: { fg: 'rgba(251,146,60,.9)',          icon: '⟳' },
    ok:      { fg: 'var(--acid)',                  icon: '✓' },
    error:   { fg: 'var(--red)',                   icon: '✗' },
    skipped: { fg: 'var(--text-muted)',            icon: '—' },
  }[status]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,.85)', display: 'flex', flexDirection: 'column',
    }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 3, color: 'var(--acid)' }}>
          ▶ WORKFLOW TEST RUN
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1 }}>
          {sorted.length} STEP{sorted.length !== 1 ? 'S' : ''} · executes as agent
        </span>
        <div style={{ flex: 1 }} />
        {done && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: allOk ? 'var(--acid)' : 'var(--red)', border: `1px solid ${allOk ? 'rgba(198,241,53,.4)' : 'rgba(255,61,90,.4)'}`, padding: '3px 10px' }}>
            {allOk ? `✓ ALL STEPS PASSED · ${totalFields} ROWS` : '✗ SOME STEPS FAILED'}
          </span>
        )}
        {!running
          ? <button onClick={run} style={{ ...s.btnPrimary, padding: '8px 20px' }}>▶ {done ? 'RE-RUN' : 'RUN'}</button>
          : <button onClick={abort} style={{ ...s.btnGhost, borderColor: 'rgba(255,61,90,.4)', color: 'var(--red)' }}>■ ABORT</button>
        }
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, padding: '0 4px', lineHeight: 1 }}>✕</button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 0 }}>

        {/* Timeline */}
        {results.map((r, idx) => {
          const c     = sc(r.status);
          const stepDef = sorted[idx];
          const exp   = !!expanded[r.stepPos];
          const tab   = getTab(r.stepPos);
          const stc   = STEP_COLOR[r.stepType];

          return (
            <div key={r.stepPos}>
              {/* Connector line */}
              {idx > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 0 23px', gap: 0, height: 28 }}>
                  <div style={{ width: 1, height: '100%', background: r.status === 'ok' ? 'rgba(198,241,53,.3)' : 'var(--border-dim)', marginLeft: 0 }} />
                </div>
              )}

              {/* Step card */}
              <div style={{ border: `1px solid ${r.status === 'ok' ? stc.border : r.status === 'error' ? 'rgba(255,61,90,.3)' : 'var(--border-dim)'}`, background: r.status === 'running' ? 'rgba(251,146,60,.04)' : 'var(--bg-surface)' }}>

                {/* Step header — click to expand */}
                <div
                  onClick={() => r.status !== 'pending' && toggleExpand(r.stepPos)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: r.status !== 'pending' ? 'pointer' : 'default', borderBottom: exp ? '1px solid var(--border-dim)' : 'none' }}
                >
                  {/* Position badge */}
                  <div style={{ width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${stc.fg}20`, border: `1px solid ${stc.fg}55`, fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 800, color: stc.fg, flexShrink: 0 }}>
                    {r.stepPos}
                  </div>

                  {/* Status icon */}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: c.fg, flexShrink: 0, animation: r.status === 'running' ? 'spin .7s linear infinite' : 'none', display: 'inline-block' }}>
                    {c.icon}
                  </span>

                  {/* Name + type */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-primary)', letterSpacing: .5 }}>{r.stepName}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: stc.fg, letterSpacing: 1.5, marginTop: 1 }}>{r.stepType}</div>
                  </div>

                  {/* Resolved URL */}
                  {r.resolvedUrl && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={r.resolvedUrl}>
                      {r.resolvedUrl}
                    </div>
                  )}

                  {/* Stats pills */}
                  {r.status === 'ok' && (
                    <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                      {r.httpStatus && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: 'var(--acid)', border: '1px solid rgba(198,241,53,.3)', padding: '1px 7px' }}>{r.httpStatus}</span>}
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', border: '1px solid var(--border-dim)', padding: '1px 7px' }}>{r.itemCount} items</span>
                      {r.latency_ms !== null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', border: '1px solid var(--border-dim)', padding: '1px 7px' }}>{r.latency_ms}ms</span>}
                      {r.rawSize > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', border: '1px solid var(--border-dim)', padding: '1px 7px' }}>{fmtKb(r.rawSize)}</span>}
                    </div>
                  )}
                  {r.status === 'error' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)', flex: 1, textAlign: 'right' as const }}>{r.error}</span>
                  )}
                  {r.status === 'running' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)', animation: 'pulse 1s ease-in-out infinite' }}>executing…</span>
                  )}

                  {r.status !== 'pending' && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>{exp ? '▲' : '▼'}</span>
                  )}
                </div>

                {/* Expanded body */}
                {exp && r.status !== 'pending' && (
                  <div>
                    {/* Tab bar */}
                    <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', padding: '0 14px' }}>
                      {([
                        ['fields', `FIELDS (${r.fields.length})`],
                        ['raw',    `RAW ITEMS (${r.items.length})`],
                        ...(r.stepType === 'FETCH_PER_ITEM' ? [['subs', `SUB-RUNS (${r.subRuns.length})`]] : []),
                      ] as ['fields'|'raw'|'subs', string][]).map(([t, lbl]) => (
                        <button key={t} onClick={() => setTab(r.stepPos, t)} style={{ ...s.tabBtn, fontSize: 7, color: tab === t ? stc.fg : 'var(--text-muted)', borderBottomColor: tab === t ? stc.fg : 'transparent' }}>{lbl}</button>
                      ))}

                      {/* Sub-run limit control */}
                      {r.stepType === 'FETCH_PER_ITEM' && (
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>iterate</span>
                          <input type="number" min={1} max={10}
                            value={getSubLimit(r.stepPos)}
                            onChange={e => setSubLimit(p => ({ ...p, [r.stepPos]: Math.max(1, Math.min(10, Number(e.target.value))) }))}
                            style={{ ...s.miniInput, width: 44, padding: '2px 6px', fontSize: 9 }}
                          />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>items</span>
                        </div>
                      )}
                    </div>

                    {/* FIELDS tab */}
                    {tab === 'fields' && (
                      <div style={{ padding: '0', maxHeight: 260, overflowY: 'auto' }}>
                        {r.fields.length === 0 ? (
                          <div style={{ padding: '16px', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', textAlign: 'center' as const }}>
                            No field mappings defined — add fields to this step to extract data
                          </div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                            <thead>
                              <tr style={{ background: 'var(--bg-elevated)' }}>
                                {Object.keys(r.fields[0] ?? {}).map(k => (
                                  <th key={k} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: 'var(--text-muted)', padding: '5px 10px', textAlign: 'left' as const, borderBottom: '1px solid var(--border-dim)', whiteSpace: 'nowrap' as const }}>{k}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {r.fields.map((row, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                                  {Object.values(row).map((v, j) => (
                                    <td key={j} style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)', padding: '4px 10px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={String(v ?? '')}>{String(v ?? '')}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}

                    {/* RAW ITEMS tab */}
                    {tab === 'raw' && (
                      <div style={{ maxHeight: 260, overflowY: 'auto', padding: '8px 14px', background: 'rgba(10,14,10,.9)' }}>
                        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(167,243,208,.8)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.6 }}>
                          {JSON.stringify(r.items, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* SUB-RUNS tab */}
                    {tab === 'subs' && r.stepType === 'FETCH_PER_ITEM' && (
                      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                        {r.subRuns.map((sr, si) => (
                          <div key={si} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: 'rgba(6,182,212,.03)' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(6,182,212,.5)', letterSpacing: 1.5 }}>RUN #{si + 1}</span>
                              {sr.httpStatus && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: 'var(--acid)', border: '1px solid rgba(198,241,53,.3)', padding: '1px 6px' }}>{sr.httpStatus}</span>}
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={sr.resolvedUrl}>{sr.resolvedUrl}</span>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', flexShrink: 0 }}>{sr.itemCount} items · {sr.latency_ms}ms</span>
                              {sr.error && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--red)' }}>✗ {sr.error}</span>}
                            </div>
                            {sr.items.length > 0 && (
                              <div style={{ padding: '6px 14px', background: 'rgba(10,14,10,.8)' }}>
                                <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(167,243,208,.7)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, maxHeight: 120, overflow: 'auto' }}>
                                  {JSON.stringify(sr.items[0], null, 2)}
                                </pre>
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

        {/* Summary footer */}
        {done && (
          <div style={{ marginTop: 24, padding: '14px 18px', background: allOk ? 'rgba(198,241,53,.04)' : 'rgba(255,61,90,.04)', border: `1px solid ${allOk ? 'rgba(198,241,53,.2)' : 'rgba(255,61,90,.2)'}`, display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: allOk ? 'var(--acid)' : 'var(--red)', letterSpacing: 2 }}>
              {allOk ? '✓ RUN COMPLETE' : '✗ RUN FINISHED WITH ERRORS'}
            </span>
            <div style={{ flex: 1 }} />
            {results.map(r => (
              <div key={r.stepPos} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: sc(r.status).fg }}>{sc(r.status).icon}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>S{r.stepPos}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: sc(r.status).fg }}>{r.itemCount}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom run button for easy access */}
      <div style={{ padding: '10px 24px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-dim)', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', alignSelf: 'center', letterSpacing: 1 }}>
          FETCH_PER_ITEM uses first N items from parent step — adjust in sub-runs tab
        </span>
        <button onClick={onClose} style={s.btnGhost}>CLOSE</button>
        {!running
          ? <button onClick={run} style={{ ...s.btnPrimary, padding: '9px 24px' }}>▶ {done ? 'RE-RUN WORKFLOW' : 'RUN WORKFLOW'}</button>
          : <button onClick={abort} style={{ ...s.btnGhost, borderColor: 'rgba(255,61,90,.4)', color: 'var(--red)', padding: '9px 24px' }}>■ ABORT RUN</button>
        }
      </div>
    </div>
  );
}

// ─── Quick-start panel (shown when no steps exist) ────────────────────────────

function QuickStart({ onAddBlank, onAddFromCurl }: {
  onAddBlank:    () => void;
  onAddFromCurl: (patch: Partial<DraftStep>) => void;
}) {
  const [curlText, setCurlText]   = useState('');
  const [detected, setDetected]   = useState(false);
  const [parseErr, setParseErr]   = useState('');

  const tryImport = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith('curl')) { setParseErr('Paste a valid curl command'); setDetected(false); return; }
    try {
      const p = parseCurl(trimmed);
      setDetected(true);
      setParseErr('');
      // Determine active tab hint
      const activeTab: 'params'|'headers'|'body' =
        p.params.some(x => x.key) ? 'params' :
        p.headers.some(x => x.key) ? 'headers' :
        p.body ? 'body' : 'params';
      onAddFromCurl({ ...p, step_type: 'FETCH_LIST', name: 'Step 1' });
    } catch {
      setParseErr('Could not parse curl command');
      setDetected(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    setTimeout(() => {
      const v = e.clipboardData?.getData('text') ?? curlText;
      if (v.trim().toLowerCase().startsWith('curl')) tryImport(v || curlText);
    }, 80);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '28px 0' }}>

      {/* ── CURL QUICK-START ── */}
      <div style={{ border: '1px solid rgba(198,241,53,.25)', background: 'rgba(198,241,53,.03)', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, color: 'var(--acid)' }}>⚡ QUICK START — PASTE A CURL</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5 }}>AUTO-POPULATES URL · METHOD · PARAMS · HEADERS · BODY</span>
        </div>
        <textarea
          value={curlText}
          onChange={e => { setCurlText(e.target.value); if (detected) setDetected(false); setParseErr(''); }}
          onPaste={onPaste}
          rows={5}
          spellCheck={false}
          placeholder={`curl -X GET 'https://api.bookmaker.com/v2/events?sport=soccer&market=1x2' \\
  -H 'Authorization: Bearer TOKEN' \\
  -H 'x-api-key: YOUR_KEY'

→ Paste any curl command — fields populate instantly`}
          style={{
            ...s.miniInput,
            width: '100%', resize: 'vertical', lineHeight: 1.6, fontSize: 10,
            background: curlText.trim().toLowerCase().startsWith('curl') ? 'rgba(198,241,53,.04)' : 'var(--bg-base)',
            border: `1px solid ${parseErr ? 'rgba(255,61,90,.4)' : curlText.trim() ? 'rgba(198,241,53,.3)' : 'var(--border-dim)'}`,
            color: 'var(--text-primary)',
          }}
        />
        {parseErr && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)' }}>✗ {parseErr}</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => tryImport(curlText)}
            disabled={!curlText.trim()}
            style={{ ...s.btnPrimary, flex: 1, padding: '10px 0', background: curlText.trim() ? 'var(--acid)' : 'var(--border-dim)', color: curlText.trim() ? '#0a0a0a' : 'var(--text-muted)', fontSize: 9, letterSpacing: 2, opacity: curlText.trim() ? 1 : .5 }}>
            ⊕ CREATE FIRST STEP FROM CURL
          </button>
        </div>
        {detected && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', letterSpacing: 1 }}>
            ✓ Parsed — step created! Scroll down to see it.
          </div>
        )}
      </div>

      {/* ── OR ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-dim)' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 2 }}>OR BUILD MANUALLY</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-dim)' }} />
      </div>

      {/* ── Step type buttons ── */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' as const }}>
        {(Object.entries(STEP_TYPES) as [StepType, typeof STEP_TYPES[StepType]][]).map(([t, m]) => {
          const sc = STEP_COLOR[t];
          return (
            <button key={t} onClick={onAddBlank}
              style={{ background: `${sc.fg}10`, border: `1px solid ${sc.fg}44`, color: sc.fg, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, padding: '10px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 14 }}>{m.icon}</span>
              <div style={{ textAlign: 'left' as const }}>
                <div>{t}</div>
                <div style={{ fontSize: 7, opacity: .6, marginTop: 2, fontWeight: 400, letterSpacing: .5 }}>{m.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Step 1 — context + endpoints ────────────────────────────────────────────
// Mirrors reference Step1 layout exactly: 3-column context grid + step builder.

// ─── Per-bookmaker state ──────────────────────────────────────────────────────
// ─── Saved workflow types ─────────────────────────────────────────────────────

interface SavedStepSummary {
  position:          number;
  name:              string;
  step_type:         StepType;
  url_template:      string;
  method:            string;
  result_array_path: string;
  fields:            FieldDescriptor[];
  firstItem:         Record<string, unknown> | null;
  field_mappings:    Record<string, string>;
}

interface SavedWorkflowEntry {
  localId:      string;
  wfId:         number | null;
  bookmaker_id: number;
  bmName:       string;
  wfName:       string;
  wfDesc:       string;
  workflowType: string;
  savedAt:      number;   // Date.now()
  steps:        SavedStepSummary[];
  mergedJson:   Record<string, unknown>;  // combined sample object
}

// Build one merged JSON from all steps' firstItems
// Step 1 (base) contributes its fields at the root.
// Each subsequent step contributes under a key derived from its name/type.
function buildMergedJson(steps: DraftStep[]): Record<string, unknown> {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const merged: Record<string, unknown> = {};

  sorted.forEach((step, idx) => {
    const item = step.firstItem ?? {};
    if (idx === 0) {
      // Root match/event — spread directly, but add extracted field labels too
      Object.assign(merged, item);
      step.fields.forEach(f => {
        if (!(f.path in merged)) merged[f.label || f.role] = f.sample ?? null;
      });
    } else {
      // Subsequent steps — nest under a key so paths stay unambiguous
      const key = `_${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `step${step.position}`}`;
      const nested: Record<string, unknown> = { ...item };
      step.fields.forEach(f => {
        if (!(f.path in nested)) nested[f.label || f.role] = f.sample ?? null;
      });
      merged[key] = nested;
    }
  });

  return merged;
}

// Flatten mergedJson → accessor paths with types and sample values (for path builder)
function flattenMerged(
  obj: unknown,
  prefix = '',
  depth = 0,
): { path: string; type: string; sample: string }[] {
  if (depth > 5 || obj === null || obj === undefined) return [];
  const t = Array.isArray(obj) ? 'array' : typeof obj;
  if (t !== 'object' && t !== 'array') {
    return [{ path: prefix, type: t, sample: String(obj).slice(0, 40) }];
  }
  if (t === 'array') {
    const arr = obj as unknown[];
    const self: { path: string; type: string; sample: string }[] = [{ path: prefix || '[root]', type: 'array', sample: `[${arr.length} items]` }];
    if (arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
      const children = flattenMerged(arr[0], prefix ? `${prefix}[0]` : '[0]', depth + 1);
      return [...self, ...children];
    }
    return self;
  }
  // object
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const vt = Array.isArray(v) ? 'array' : typeof v;
    if (vt === 'object' || vt === 'array') {
      return [{ path: p, type: vt, sample: vt === 'array' ? `[${(v as unknown[]).length}]` : '{…}' },
              ...flattenMerged(v, p, depth + 1)];
    }
    return [{ path: p, type: vt, sample: String(v ?? '').slice(0, 40) }];
  });
}

interface BookmakerConfig {
  steps:        DraftStep[];
  workflowType: string;
  wfName:       string;
  wfDesc:       string;
  saveStatus:   'idle' | 'saving' | 'saved' | 'error';
  saveMsg:      string;
  showTest:     boolean;
}

function mkConfig(defaultType: string): BookmakerConfig {
  return { steps: [], workflowType: defaultType, wfName: '', wfDesc: '', saveStatus: 'idle', saveMsg: '', showTest: false };
}

// ─── BookmakerWorkflowPanel — isolated editor for one bookmaker ───────────────

function BookmakerWorkflowPanel({ bm, cfg, roles, reqTypes, sports, sportId, onChange }: {
  bm:       BookmakerOption;
  cfg:      BookmakerConfig;
  roles:    FieldRole[];
  reqTypes: string[];
  sports:   SportOption[];
  sportId:  number | null;
  onChange: (patch: Partial<BookmakerConfig>) => void;
}) {
  const steps = cfg.steps;

  const setSteps = (fn: (prev: DraftStep[]) => DraftStep[]) =>
    onChange({ steps: fn(steps) });

  const addStep = useCallback((afterPos?: number) => {
    setSteps(prev => {
      const max  = prev.length ? Math.max(...prev.map(s => s.position)) : 0;
      const newP = afterPos !== undefined ? afterPos + 1 : max + 1;
      const shifted = prev.map(s => s.position >= newP ? { ...s, position: s.position + 1 } : s);
      return [...shifted, blankStep(newP)].sort((a, b) => a.position - b.position);
    });
  }, [steps]);

  const updStep = (localId: string, patch: Partial<DraftStep>) =>
    onChange({ steps: steps.map(s => s.localId === localId ? { ...s, ...patch } : s) });

  const delStep = (localId: string) =>
    onChange({ steps: steps.filter(s => s.localId !== localId).map((s, i) => ({ ...s, position: i + 1 })) });

  const moveStep = (localId: string, dir: 'up' | 'down') => {
    const sorted = [...steps].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex(s => s.localId === localId);
    if (dir === 'up' && idx === 0) return;
    if (dir === 'down' && idx === sorted.length - 1) return;
    const si = dir === 'up' ? idx - 1 : idx + 1;
    const a = sorted[idx].position, b = sorted[si].position;
    onChange({ steps: steps.map(s =>
      s.localId === sorted[idx].localId ? { ...s, position: b } :
      s.localId === sorted[si].localId  ? { ...s, position: a } : s
    )});
  };

  const sorted     = [...steps].sort((a, b) => a.position - b.position);
  const fieldCount = steps.reduce((acc, s) => acc + s.fields.length, 0);
  const canSave    = steps.length > 0 && cfg.wfName.trim().length > 0;

  // accent colour derived from brand_color (bookmaker may have it later, for now use acid)
  const accentFg = 'var(--acid)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {cfg.showTest && (
        <WorkflowTestPanel steps={steps} onClose={() => onChange({ showTest: false })} />
      )}

      {/* ── Per-bookmaker config bar ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)' }}>
        <div style={s.fieldWrap}>
          <label style={s.label}>WORKFLOW TYPE</label>
          <select value={cfg.workflowType} onChange={e => onChange({ workflowType: e.target.value })} style={s.input}>
            {reqTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={s.fieldWrap}>
          <label style={s.label}>WORKFLOW NAME <span style={{ color: 'var(--red)' }}>*</span></label>
          <input
            value={cfg.wfName}
            onChange={e => onChange({ wfName: e.target.value })}
            placeholder={`e.g. ${bm?.name} Match List + Odds`}
            style={{ ...s.input, borderColor: cfg.wfName.trim() ? undefined : 'rgba(251,146,60,.3)' }}
          />
        </div>
        <div style={{ ...s.fieldWrap, gridColumn: '1 / -1' }}>
          <label style={s.label}>DESCRIPTION (optional)</label>
          <input value={cfg.wfDesc} onChange={e => onChange({ wfDesc: e.target.value })} style={s.input} placeholder="Describe what this workflow fetches" />
        </div>
      </div>

      {/* ── Sport info strip ── */}
      {(sportId || cfg.workflowType) && (
        <div style={{ display: 'flex', gap: 10, padding: '4px 12px', background: 'rgba(198,241,53,.03)', border: '1px solid rgba(198,241,53,.1)', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
          {sportId && <span>SPORT: <span style={{ color: 'var(--text-secondary)' }}>{sports.find(sp => sp.id === sportId)?.name ?? sportId}</span></span>}
          {cfg.workflowType && <span>TYPE: <span style={{ color: accentFg }}>{cfg.workflowType}</span></span>}
          <span>{steps.length} STEP{steps.length !== 1 ? 'S' : ''} · {fieldCount} FIELDS</span>
        </div>
      )}

      {/* ── Action bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
        <div style={{ flex: 1 }} />
        <button onClick={() => addStep()} style={s.btnGhost}>⊕ ADD STEP</button>
        <button
          onClick={() => onChange({ showTest: true })}
          disabled={steps.length === 0}
          style={{ background: steps.length > 0 ? 'rgba(6,182,212,.08)' : 'transparent', border: `1px solid ${steps.length > 0 ? 'rgba(6,182,212,.4)' : 'var(--border-dim)'}`, color: steps.length > 0 ? 'var(--cyan)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '7px 14px', cursor: steps.length > 0 ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' as const, opacity: steps.length > 0 ? 1 : .4 }}
        >▶ TEST</button>
        <button
          onClick={() => canSave && onChange({ saveStatus: 'saving' })}
          disabled={!canSave || cfg.saveStatus === 'saving'}
          style={{ ...s.btnApprove, opacity: (canSave && cfg.saveStatus !== 'saving') ? 1 : .4 }}
        >
          {cfg.saveStatus === 'saving' ? '⟳ SAVING…' : cfg.saveStatus === 'saved' ? '✓ SAVED' : '✓ SAVE WORKFLOW'}
        </button>
      </div>

      {/* Save status message */}
      {cfg.saveMsg && (
        <div style={{ padding: '6px 12px', background: cfg.saveStatus === 'error' ? 'rgba(255,61,90,.06)' : 'rgba(198,241,53,.06)', border: `1px solid ${cfg.saveStatus === 'error' ? 'rgba(255,61,90,.25)' : 'rgba(198,241,53,.25)'}`, fontFamily: 'var(--font-mono)', fontSize: 9, color: cfg.saveStatus === 'error' ? 'var(--red)' : 'var(--acid)' }}>
          {cfg.saveMsg}
        </div>
      )}

      {/* ── Step type legend ── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-dim)', borderTop: '1px solid var(--border-dim)' }}>
        {(Object.entries(STEP_TYPES) as [StepType, typeof STEP_TYPES[StepType]][]).map(([type, m]) => {
          const sc = STEP_COLOR[type];
          return (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderRight: '1px solid var(--border-dim)' }}>
              <span style={{ color: sc.fg, fontSize: 11 }}>{m.icon}</span>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: sc.fg, letterSpacing: 1.5 }}>{type}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 6, color: 'var(--text-muted)', marginTop: 1 }}>{m.desc}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Steps ── */}
      {steps.length === 0 ? (
        <QuickStart
          onAddBlank={() => addStep()}
          onAddFromCurl={importedStep => onChange({ steps: [{ ...blankStep(1), ...importedStep }] })}
        />
      ) : (
        <div>
          {sorted.map((step, idx) => {
            const prev = idx > 0 ? sorted[idx - 1] : null;
            return (
              <div key={step.localId}>
                {prev && <StepConnector from={prev} to={step} />}
                <EndpointBuilder
                  step={step} prevStep={prev} allSteps={sorted} roles={roles}
                  onChange={p => updStep(step.localId, p)}
                  onDelete={() => delStep(step.localId)}
                  onMoveUp={() => moveStep(step.localId, 'up')}
                  onMoveDown={() => moveStep(step.localId, 'down')}
                  canMoveUp={idx > 0} canMoveDown={idx < sorted.length - 1}
                />
                <div style={{ display: 'flex', justifyContent: 'center', padding: '3px 0' }}>
                  <button onClick={() => addStep(step.position)}
                    style={{ background: 'none', border: '1px dashed var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, padding: '2px 14px', cursor: 'pointer', opacity: .4, transition: 'all .15s' }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'rgba(198,241,53,.4)'; e.currentTarget.style.color = 'var(--acid)'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '.4'; e.currentTarget.style.borderColor = 'var(--border-dim)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
                  >⊕ INSERT STEP HERE</button>
                </div>
              </div>
            );
          })}
          <button onClick={() => addStep()}
            style={{ width: '100%', background: 'none', border: '1px dashed rgba(6,182,212,.25)', color: 'rgba(6,182,212,.5)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '12px 0', cursor: 'pointer', marginTop: 4, transition: 'all .15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.5)'; e.currentTarget.style.color = 'var(--cyan)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.25)'; e.currentTarget.style.color = 'rgba(6,182,212,.5)'; }}
          >⊕ ADD STEP</button>
        </div>
      )}
    </div>
  );
}

// ─── SavedWorkflowsPanel ─────────────────────────────────────────────────────
// Persists on page after each save. Shows per-workflow cards with:
//   • step timeline (first / middle / last summary)
//   • merged JSON viewer (combined sample from all probed steps)
//   • flattened accessor path table

const STEP_TYPE_SHORT: Record<StepType, string> = {
  FETCH_LIST:     'LIST',
  FETCH_PER_ITEM: 'PER ITEM',
  FETCH_ONCE:     'ONCE',
};

function StepBadge({ step, compact = false }: { step: SavedStepSummary; compact?: boolean }) {
  const sc = STEP_COLOR[step.step_type];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: compact ? '6px 10px' : '8px 12px', background: sc.bg, border: `1px solid ${sc.border}`, minWidth: compact ? 140 : 180, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 18, height: 18, borderRadius: '50%', background: sc.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 800, color: '#060b06', flexShrink: 0 }}>
          {step.position}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: sc.fg, letterSpacing: 1.5 }}>{STEP_TYPE_SHORT[step.step_type]}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)', fontWeight: 600 }}>{step.name}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', wordBreak: 'break-all' as const, opacity: .8 }}>
        {step.method} {step.url_template.length > 42 ? step.url_template.slice(0, 42) + '…' : step.url_template}
      </div>
      {step.fields.length > 0 && (
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {step.fields.slice(0, 5).map((f, i) => (
            <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 6, padding: '1px 5px', background: `${roleAccent(f.role)}15`, border: `1px solid ${roleAccent(f.role)}40`, color: roleAccent(f.role), letterSpacing: .5 }}>
              {f.role !== 'custom' ? f.role : f.label}
            </span>
          ))}
          {step.fields.length > 5 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 6, color: 'var(--text-muted)' }}>+{step.fields.length - 5}</span>}
        </div>
      )}
      {step.result_array_path && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 6, color: 'var(--acid)', opacity: .7 }}>@ {step.result_array_path}</div>
      )}
    </div>
  );
}

function SavedWorkflowCard({ entry, onRemove }: {
  entry:    SavedWorkflowEntry;
  onRemove: () => void;
}) {
  const [tab,      setTab]      = useState<'json' | 'paths'>('json');
  const [expanded, setExpanded] = useState(true);
  const [copied,   setCopied]   = useState(false);

  const paths    = flattenMerged(entry.mergedJson);
  const jsonStr  = JSON.stringify(entry.mergedJson, null, 2);
  const stepList = entry.steps;
  const first    = stepList[0];
  const last     = stepList[stepList.length - 1];
  const middle   = stepList.slice(1, stepList.length - 1);
  const timeAgo  = (() => {
    const d = Date.now() - entry.savedAt;
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    return `${Math.floor(d / 3600000)}h ago`;
  })();

  const copyJson = () => {
    navigator.clipboard?.writeText(jsonStr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const TYPE_COLOR: Record<string, string> = {
    string: 'rgba(167,243,208,.75)', number: 'rgba(251,146,60,.85)',
    boolean: 'rgba(6,182,212,.75)',  array: 'rgba(216,180,254,.75)',
    object: 'var(--text-muted)',     null: 'rgba(198,241,53,.4)',
  };

  return (
    <div style={{ border: '1px solid rgba(198,241,53,.2)', background: 'var(--bg-surface)' }}>
      {/* ── Card header ── */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: 'rgba(198,241,53,.03)', borderBottom: expanded ? '1px solid rgba(198,241,53,.15)' : 'none' }}
      >
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--acid)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{entry.wfName}</span>
            {entry.wfId && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(198,241,53,.5)', border: '1px solid rgba(198,241,53,.2)', padding: '0 5px' }}>ID {entry.wfId}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)' }}>{entry.bmName}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{entry.workflowType}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{stepList.length} STEPS</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{paths.length} PATHS</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginLeft: 'auto' }}>{timeAgo}</span>
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{ background: 'none', border: 'none', color: 'rgba(255,61,90,.3)', fontSize: 14, cursor: 'pointer', padding: '0 4px' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.3)')}
        >⊗</button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* ── Step timeline ── */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-dim)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 8 }}>WORKFLOW STEPS</div>
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
              {/* First step */}
              {first && <StepBadge step={first} />}

              {/* Middle steps — collapsed if many */}
              {middle.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      {middle.map((_, i) => <div key={i} style={{ width: 1, height: 12, background: 'var(--border-dim)' }} />)}
                      <div style={{ width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '6px solid rgba(198,241,53,.2)' }} />
                    </div>
                  </div>
                  {middle.length === 1 ? (
                    <StepBadge step={middle[0]} />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      {middle.map(ms => <StepBadge key={ms.position} step={ms} compact />)}
                    </div>
                  )}
                </>
              )}

              {/* Arrow connector */}
              {last && last.position !== first?.position && (
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ width: 1, height: 24, background: 'rgba(198,241,53,.2)' }} />
                    <div style={{ width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '6px solid rgba(198,241,53,.3)' }} />
                  </div>
                </div>
              )}

              {/* Last step */}
              {last && last.position !== first?.position && <StepBadge step={last} />}
            </div>

            {/* Field wiring summary */}
            {stepList.length > 1 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stepList.slice(1).map(st => {
                  const wired = Object.entries(st.field_mappings);
                  if (wired.length === 0) return null;
                  return wired.map(([varName, srcPath]) => (
                    <span key={`${st.position}-${varName}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 7px', background: 'rgba(6,182,212,.06)', border: '1px solid rgba(6,182,212,.2)', color: 'var(--cyan)' }}>
                      S{st.position} {'{{' + varName + '}}'} ← {srcPath}
                    </span>
                  ));
                })}
              </div>
            )}
          </div>

          {/* ── Tabs: Merged JSON / Accessor Paths ── */}
          <div style={{ borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center' }}>
            {(['json', 'paths'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                style={{ ...s.tabBtn, fontSize: 7, color: tab === t ? 'var(--acid)' : 'var(--text-muted)', borderBottomColor: tab === t ? 'var(--acid)' : 'transparent' }}>
                {t === 'json'  && `MERGED JSON (${stepList.length} STEPS COMBINED)`}
                {t === 'paths' && `ACCESSOR PATHS (${paths.length})`}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={copyJson} style={{ ...s.btnGhost, fontSize: 7, padding: '4px 10px', margin: '2px 8px 2px 0' }}>
              {copied ? '✓ COPIED' : '⊕ COPY JSON'}
            </button>
          </div>

          {/* ── MERGED JSON tab ── */}
          {tab === 'json' && (
            <div style={{ background: 'rgba(6,10,6,.9)', padding: '14px 16px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 2, marginBottom: 10 }}>
                COMBINED SAMPLE · Step 1 fields at root · subsequent steps nested under _key · use ACCESSOR PATHS tab to configure mapping
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <JsonTree data={entry.mergedJson} />
              </div>
            </div>
          )}

          {/* ── ACCESSOR PATHS tab ── */}
          {tab === 'paths' && (
            <div>
              <div style={{ padding: '8px 14px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1.5 }}>
                ALL ACCESSOR PATHS — copy any path to use in field mappings / parser config
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {paths.map((p, i) => (
                  <div key={i}
                    style={{ display: 'grid', gridTemplateColumns: '16px 1fr 60px 1fr', gap: 0, borderBottom: '1px solid rgba(255,255,255,.03)', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.025)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ padding: '5px 6px' }}>
                      <div style={{ width: 5, height: 5, borderRadius: '50%', background: TYPE_COLOR[p.type] ?? 'var(--text-muted)' }} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', padding: '5px 0', userSelect: 'text' as const }}>
                      {p.path}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: TYPE_COLOR[p.type] ?? 'var(--text-muted)', padding: '5px 6px', letterSpacing: .5 }}>
                      {p.type}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', padding: '5px 8px 5px 0', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={p.sample}>
                      {p.sample}
                    </div>
                  </div>
                ))}
                {paths.length === 0 && (
                  <div style={{ padding: '20px', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', textAlign: 'center' as const }}>
                    No paths — probe steps first so sample data is captured
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Description ── */}
          {entry.wfDesc && (
            <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
              {entry.wfDesc}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SavedWorkflowsPanel({ entries, onRemove }: {
  entries:  SavedWorkflowEntry[];
  onRemove: (localId: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '2px solid rgba(198,241,53,.2)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 3, color: 'var(--acid)' }}>
          ✓ SAVED THIS SESSION
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1 }}>
          {entries.length} WORKFLOW{entries.length !== 1 ? 'S' : ''} · {entries.reduce((a, e) => a + e.steps.length, 0)} TOTAL STEPS
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginLeft: 'auto', letterSpacing: 1 }}>
          click card to expand · paths tab for accessor config
        </span>
      </div>
      {entries.map(e => (
        <SavedWorkflowCard key={e.localId} entry={e} onRemove={() => onRemove(e.localId)} />
      ))}
    </div>
  );
}

// ─── localStorage persistence helpers ────────────────────────────────────────

const LS_KEY = 'endpoint_research_v1';

interface PersistedState {
  bookmarkerIds: number[];
  sportId:       number | null;
  activeTab:     number | null;
  configs:       Record<number, BookmakerConfig>;
}

function loadPersistedState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedState;
  } catch {
    return {};
  }
}

function persistState(state: PersistedState) {
  try {
    const clean: PersistedState = {
      ...state,
      configs: Object.fromEntries(
        Object.entries(state.configs).map(([id, cfg]) => [
          id,
          {
            ...cfg,
            saveStatus: cfg.saveStatus === 'saving' ? 'idle' : cfg.saveStatus,
            saveMsg:    '',
            showTest:   false,
            steps: cfg.steps.map(s => ({
              ...s,
              probeStatus:     'idle'  as const,
              probeResponse:   null,
              probeError:      '',
              probeHttpStatus: null,
              // firstItem kept — needed for field wiring preview
            })),
          },
        ])
      ),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(clean));
  } catch { /* quota / private-mode errors */ }
}

// ─── Step 1 — Multi-bookmaker orchestrator ────────────────────────────────────
// Each bookmaker gets an isolated tab with its own steps, workflow type, name.


// ─── Main page ────────────────────────────────────────────────────────────────

export default function EndpointResearch() {
  const [bookmakers, setBookmakers] = useState<BookmakerOption[]>([]);
  const [sports,     setSports]     = useState<SportOption[]>([]);
  const [reqTypes,   setReqTypes]   = useState<string[]>(WORKFLOW_TYPES);
  const [loading,    setLoading]    = useState(true);
  const [toast,      setToast]      = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth('/research/meta');
        if (res.ok) {
          const d = await res.json();
          setBookmakers(d.bookmakers ?? []);
          setSports(d.sports ?? []);
          if (d.request_types?.length) setReqTypes(d.request_types);
        }
      } catch { setToast('⚠ Could not load metadata'); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <PlaywrightOnboarding bookmakers={bookmakers} 
    // sports={sports} reqTypes={reqTypes} loading={loading} 
    // toast={toast} persistState={persistState} 
    // loadPersistedState={loadPersistedState} 
    />  
    
  );
}