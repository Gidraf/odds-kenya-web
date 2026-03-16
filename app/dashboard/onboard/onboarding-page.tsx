/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookmakerOption { id: number; name: string; domain?: string }
interface SportOption     { id: number; name: string }
interface KV              { key: string; value: string }

type Phase = 'LIST' | 'MARKETS' | 'LIVE_LIST' | 'LIVE_MARKETS' | 'SPORTS' | 'REVIEW';

interface SportMapping {
  bk_sport_id: string;
  sport_id:    number | null;
  sport_name:  string;
  param_key:   string;
  param_in:    'query' | 'path';
  status:      'pending' | 'ok' | 'error';
  item_count:  number;
  error?:      string | null;
}

interface OnboardingSession {
  id: number; bookmaker_id: number; bookmaker_name: string;
  current_phase: string;
  list_ok: boolean; markets_ok: boolean;
  live_list_ok: boolean; live_markets_ok: boolean; is_complete: boolean;
  list_url: string; list_url_raw: string; list_method: string;
  list_headers: Record<string,string>; list_params: Record<string,string>;
  list_array_path: string; list_field_map: Record<string,string>;
  list_sport_id_path: string; sport_mappings: SportMapping[];
  list_sample?: string | null;
  markets_url_template: string; markets_url_raw: string; markets_method: string;
  markets_headers: Record<string,string>; markets_params: Record<string,string>;
  markets_array_path: string; markets_field_map: Record<string,string>;
  markets_placeholder_map: Record<string,string>;
  live_list_url: string; live_list_url_raw: string; live_list_method: string;
  live_list_headers: Record<string,string>; live_list_params: Record<string,string>;
  live_list_array_path: string; live_list_field_map: Record<string,string>;
  live_list_sample?: string | null;
  live_markets_url_template: string; live_markets_url_raw: string; live_markets_method: string;
  live_markets_headers: Record<string,string>; live_markets_params: Record<string,string>;
  live_markets_array_path: string; live_markets_field_map: Record<string,string>;
  live_markets_placeholder_map: Record<string,string>;
  workflow_ids: { upcoming?: number; live?: number } | null;
  endpoint_ids: number[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API = '/onboarding';
const api = (path: string, opts?: RequestInit) =>
  fetchWithAuth(`${API}${path}`, opts).then((r: Response) => r.json());

const ROLES = [
  'match_id','parent_match_id','home_team','away_team','start_time',
  'sport','competition','market_name','specifier','selection_name',
  'selection_price','match_status','score_home','score_away','kickoff_in_mins','custom',
];
const AUTH_RE   = /authorization|x-api-key|x-auth-token|bearer|token|secret|api.?key/i;
const PHASES: Phase[] = ['LIST','MARKETS','LIVE_LIST','LIVE_MARKETS','SPORTS','REVIEW'];
const PHASE_LABELS: Record<Phase,string> = {
  LIST:'Match List', MARKETS:'Markets', LIVE_LIST:'Live List',
  LIVE_MARKETS:'Live Markets', SPORTS:'Per-Sport', REVIEW:'Review & Save',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

// Converts KV rows to plain object — last duplicate key wins, empty keys skipped
const kvToObj = (pairs: KV[]): Record<string,string> => {
  const result: Record<string,string> = {};
  for (const p of pairs) {
    const k = p.key.trim();
    if (!k) continue;
    result[k] = p.value; // value intentionally NOT trimmed
  }
  return result;
};

const objToKv = (obj: Record<string,string> | null | undefined): KV[] =>
  Object.entries(obj ?? {}).map(([key, value]) => ({ key, value }));

// parseCurl — never uses new URL() to avoid param reordering / double-encoding.
//
// Returns:
//   url         — base URL without query string (for probe engine)
//   rawUrl      — full original URL with original qs intact (param order preserved)
//   urlTemplate — same structure as rawUrl but every param VALUE is replaced by
//                 {{param_key}} so it can be used directly as a markets URL
//                 template. E.g.:
//                   rawUrl:      .../GetGameZip?id=703489210&lng=en&gr=656
//                   urlTemplate: .../GetGameZip?id={{id}}&lng={{lng}}&gr={{gr}}
//                 Single-value params (lng=en, gr=656) stay as {{lng}}, {{gr}}
//                 so the user can wire them to constants or list fields later.
//   method      — HTTP verb
//   headers     — KV[] including cookies from -b flags
//   params      — KV[] in original order, values decoded
//   body        — raw body string
function parseCurl(raw: string): {
  url: string; rawUrl: string; urlTemplate: string;
  method: string; headers: KV[]; params: KV[]; body: string;
} {
  const cmd = raw.replace(/\\\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === ' ') { i++; continue; }
    const q = cmd[i] === "'" ? "'" : cmd[i] === '"' ? '"' : '';
    if (q) {
      const end = cmd.indexOf(q, i + 1);
      tokens.push(end < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, end));
      i = end < 0 ? cmd.length : end + 1;
    } else {
      const sp = cmd.indexOf(' ', i);
      tokens.push(sp < 0 ? cmd.slice(i) : cmd.slice(i, sp));
      i = sp < 0 ? cmd.length : sp;
    }
  }

  let rawFullUrl = '', method = 'GET', body = '';
  const rawHeaders: KV[] = [];
  let cookieStr = '';
  let t = 0;
  if (tokens[0]?.toLowerCase() === 'curl') t = 1;

  while (t < tokens.length) {
    const tok = tokens[t];
    if (tok === '-X' || tok === '--request') {
      method = (tokens[++t] ?? 'GET').toUpperCase();
    } else if (tok === '-H' || tok === '--header') {
      const h = tokens[++t] ?? '';
      const col = h.indexOf(':');
      if (col >= 0) rawHeaders.push({ key: h.slice(0, col).trim(), value: h.slice(col + 1).trim() });
    } else if (tok === '-b' || tok === '--cookie') {
      const c = tokens[++t] ?? '';
      cookieStr = cookieStr ? `${cookieStr}; ${c}` : c;
    } else if (['-d', '--data', '--data-raw', '--data-binary'].includes(tok)) {
      body = tokens[++t] ?? '';
      if (method === 'GET') method = 'POST';
    } else if (tok === '--url') {
      rawFullUrl = tokens[++t] ?? '';
    } else if (!tok.startsWith('-') && !rawFullUrl) {
      rawFullUrl = tok;
    }
    t++;
  }

  // Inject -b cookies as a cookie header
  if (cookieStr) {
    const existing = rawHeaders.find(h => h.key.toLowerCase() === 'cookie');
    if (existing) {
      existing.value = existing.value ? `${existing.value}; ${cookieStr}` : cookieStr;
    } else {
      rawHeaders.push({ key: 'cookie', value: cookieStr });
    }
  }

  // Split base URL from query string — plain indexOf, no URL normalization
  const parsedParams: KV[] = [];
  let cleanUrl = rawFullUrl;
  const qIdx = rawFullUrl.indexOf('?');
  if (qIdx >= 0) {
    cleanUrl = rawFullUrl.slice(0, qIdx);
    rawFullUrl.slice(qIdx + 1).split('&').forEach(part => {
      if (!part) return;
      const eqIdx = part.indexOf('=');
      if (eqIdx >= 0) {
        parsedParams.push({
          key:   decodeURIComponent(part.slice(0, eqIdx).replace(/\+/g, ' ')),
          value: decodeURIComponent(part.slice(eqIdx + 1).replace(/\+/g, ' ')),
        });
      } else {
        parsedParams.push({ key: decodeURIComponent(part.replace(/\+/g, ' ')), value: '' });
      }
    });
  }

  // Build urlTemplate — rawUrl with every param value replaced by {{param_key}}.
  // Uses the raw (un-decoded) query string segments so the base URL and
  // separators (? &) stay byte-for-byte identical to the original curl.
  // Param keys are decoded for readability in the template.
  let urlTemplate = rawFullUrl;
  if (qIdx >= 0) {
    const templateParts = rawFullUrl.slice(qIdx + 1).split('&').map(part => {
      if (!part) return part;
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) {
        // Flag param with no value — use {{key}} as the whole part
        const key = decodeURIComponent(part.replace(/\+/g, ' '));
        return `${key}={{${key}}}`;
      }
      const rawKey = part.slice(0, eqIdx);
      const key    = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      // Replace only the value portion — keep the raw key encoding intact
      return `${rawKey}={{${key}}}`;
    });
    urlTemplate = `${rawFullUrl.slice(0, qIdx)}?${templateParts.join('&')}`;
  }
  // If no query string, urlTemplate === rawUrl (base URL only, no params to template)

  return { url: cleanUrl, rawUrl: rawFullUrl, urlTemplate, method, headers: rawHeaders, params: parsedParams, body };
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (!path || !obj) return obj;
  return path.split('.').reduce((acc: unknown, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function flattenObj(obj: unknown, prefix = '', depth = 0): { path: string; value: string; type: string }[] {
  if (depth > 4 || !obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return [
    { path: prefix || '[]', value: `[${obj.length} items]`, type: 'array' },
    ...(obj[0] && typeof obj[0] === 'object' ? flattenObj(obj[0], `${prefix}[0]`, depth + 1) : []),
  ];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if ((t === 'object' || t === 'array') && depth < 3)
      return [{ path: p, value: t === 'array' ? `[${(v as unknown[]).length}]` : '{…}', type: t }, ...flattenObj(v, p, depth + 1)];
    return [{ path: p, value: String(v ?? ''), type: t }];
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  label:    { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 4, display: 'block' },
  input:    { width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '7px 11px', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' as const },
  mini:     { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  btnAcid:  { background: 'var(--acid)', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: 2, padding: '8px 16px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnGhost: { background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnCyan:  { background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.4)', color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  card:     { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
};

const pill = (ok: boolean) => ({
  fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 7px', letterSpacing: 1,
  background: ok ? 'rgba(198,241,53,.1)' : 'rgba(255,255,255,.04)',
  border: `1px solid ${ok ? 'rgba(198,241,53,.3)' : 'var(--border-dim)'}`,
  color: ok ? 'var(--acid)' : 'var(--text-muted)',
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (!msg) return; const t = setTimeout(onClear, 5000); return () => clearTimeout(t); }, [msg, onClear]);
  if (!msg) return null;
  const err = msg.startsWith('✗');
  return (
    <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 9999, background: 'var(--bg-elevated)', border: `1px solid ${err ? 'rgba(255,61,90,.5)' : 'rgba(198,241,53,.5)'}`, color: err ? 'var(--red)' : 'var(--acid)', padding: '11px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 8px 32px rgba(0,0,0,.7)', letterSpacing: 1, maxWidth: 480 }}>
      {msg}
    </div>
  );
}

// ─── UrlBlueprint ─────────────────────────────────────────────────────────────
// Shows the saved raw URL with each param as a token, plus a TEMPLATE tab that
// shows the same URL with param values replaced by {{placeholders}}.

function UrlBlueprint({ rawUrl, urlTemplate, accent = 'var(--acid)', onUse }: {
  rawUrl: string; urlTemplate?: string; accent?: string; onUse: (url: string) => void;
}) {
  const [view,    setView]   = useState<'raw' | 'template'>('template');
  const [copied, setCopied] = useState(false);
  if (!rawUrl) return null;

  const displayUrl = view === 'template' && urlTemplate ? urlTemplate : rawUrl;
  const hasTemplate = !!urlTemplate && urlTemplate !== rawUrl;

  const qIdx  = displayUrl.indexOf('?');
  const base  = qIdx >= 0 ? displayUrl.slice(0, qIdx) : displayUrl;
  const qs    = qIdx >= 0 ? displayUrl.slice(qIdx + 1) : '';
  const parts = qs ? qs.split('&').filter(Boolean) : [];

  const copy = () => {
    navigator.clipboard.writeText(displayUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const isPlaceholder = (val: string) => val.startsWith('{{') && val.endsWith('}}');

  return (
    <div style={{ border: `1px solid ${accent}33`, background: `${accent}05` }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: `1px solid ${accent}22` }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: accent }}>📋 URL BLUEPRINT</span>
        {/* Tab switcher */}
        {hasTemplate && (
          <div style={{ display: 'flex', gap: 0, marginLeft: 6, border: `1px solid ${accent}33`, overflow: 'hidden' }}>
            {(['template', 'raw'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1, padding: '2px 8px',
                background: view === v ? `${accent}22` : 'transparent',
                border: 'none', borderRight: v === 'template' ? `1px solid ${accent}33` : 'none',
                color: view === v ? accent : 'var(--text-muted)', cursor: 'pointer',
              }}>
                {v === 'template' ? '{{}} TEMPLATE' : 'RAW'}
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={copy} style={{ ...s.btnGhost, fontSize: 7, padding: '2px 8px', borderColor: `${accent}44`, color: accent }}>
          {copied ? '✓ COPIED' : '⎘ COPY'}
        </button>
        <button onClick={() => onUse(displayUrl)} style={{ ...s.btnAcid, fontSize: 7, padding: '3px 10px', background: accent }}>
          USE AS TEMPLATE →
        </button>
      </div>

      {/* URL body */}
      <div style={{ padding: '8px 10px' }}>
        {/* Label when showing template */}
        {hasTemplate && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginBottom: 4, letterSpacing: 1 }}>
            {view === 'template'
              ? '⚡ Param values replaced with {{placeholders}} — ready to wire to list fields'
              : '🔢 Original values from your curl — use for raw test'}
          </div>
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)', wordBreak: 'break-all' as const }}>{base}</span>
        {parts.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap' as const, gap: 3 }}>
            {parts.map((p, i) => {
              const eq  = p.indexOf('=');
              const key = eq >= 0 ? p.slice(0, eq) : p;
              const val = eq >= 0 ? p.slice(eq + 1) : '';
              const isVar = isPlaceholder(val);
              return (
                <span key={i} style={{
                  fontFamily: 'var(--font-mono)', fontSize: 8, padding: '1px 6px',
                  background: isVar ? `${accent}10` : 'rgba(255,255,255,.04)',
                  border: `1px solid ${isVar ? accent + '44' : 'var(--border-dim)'}`,
                }}>
                  <span style={{ color: 'rgba(130,180,255,.8)' }}>{key}</span>
                  {val && (
                    <>
                      <span style={{ color: 'var(--text-muted)' }}>=</span>
                      <span style={{ color: isVar ? accent : 'rgba(167,243,208,.8)', fontWeight: isVar ? 700 : 400 }}>{val}</span>
                    </>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── HeadersPanel ─────────────────────────────────────────────────────────────

function HeadersPanel({ headers }: { headers: Record<string, string> }) {
  const [show, setShow] = useState(true);
  const [reveal, setReveal] = useState(false);
  const entries = Object.entries(headers || {});
  if (!entries.length) return null;
  const tokenH = entries.filter(([k]) => AUTH_RE.test(k));
  return (
    <div style={{ border: '1px solid rgba(251,146,60,.3)', background: 'rgba(251,146,60,.03)' }}>
      <div onClick={() => setShow(x => !x)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', borderBottom: show ? '1px solid rgba(251,146,60,.2)' : 'none' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: '#fb923c' }}>🔑 HEADERS ({entries.length})</span>
        {tokenH.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)', color: '#fb923c', padding: '1px 6px' }}>{tokenH.length} AUTH TOKEN{tokenH.length > 1 ? 'S' : ''}</span>}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{show ? '▲' : '▼'}</span>
      </div>
      {show && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map(([k, v]) => {
            const isAuth = AUTH_RE.test(k);
            const dv = isAuth && !reveal ? `${v.slice(0, 8)}${'•'.repeat(Math.min(24, v.length - 8))}` : v;
            return (
              <div key={k} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isAuth ? '#fb923c' : 'rgba(130,180,255,.8)', display: 'flex', alignItems: 'center', gap: 5 }}>{isAuth && '🔑'}{k}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: isAuth ? '#fb923c' : 'var(--text-secondary)', wordBreak: 'break-all' as const, opacity: isAuth && !reveal ? .7 : 1 }}>{dv}</span>
              </div>
            );
          })}
          {tokenH.length > 0 && <button onClick={() => setReveal(r => !r)} style={{ ...s.btnGhost, fontSize: 7, padding: '3px 10px', alignSelf: 'flex-start', marginTop: 4, borderColor: 'rgba(251,146,60,.3)', color: '#fb923c' }}>{reveal ? '🙈 HIDE' : '👁 REVEAL'} TOKENS</button>}
        </div>
      )}
    </div>
  );
}

// ─── CurlImportBox ────────────────────────────────────────────────────────────

function CurlImportBox({ onImport, accentColor = 'var(--acid)' }: {
  onImport: (p: ReturnType<typeof parseCurl>) => void;
  accentColor?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const tryImport = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!trimmed.toLowerCase().startsWith('curl')) { setError('Paste a valid curl command'); return; }
    try {
      onImport(parseCurl(trimmed));
      setOpen(false); setText(''); setError('');
    } catch (e: any) { setError(e.message ?? 'Parse error'); }
  };

  return (
    <div>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', background: open ? `${accentColor}10` : 'transparent', border: `1px solid ${open ? accentColor + '55' : 'var(--border-dim)'}`, color: open ? accentColor : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '7px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>⊕ IMPORT FROM CURL</span><span style={{ opacity: .5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ border: `1px solid ${accentColor}22`, borderTop: 'none', background: `${accentColor}04`, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={text}
            onChange={e => { setText(e.target.value); setError(''); }}
            onPaste={e => {
              setTimeout(() => {
                const pasted = e.clipboardData?.getData('text') || '';
                const val = (pasted || text).trim();
                if (val.toLowerCase().startsWith('curl')) tryImport(val);
              }, 80);
            }}
            rows={4} spellCheck={false}
            style={{ ...s.mini, resize: 'vertical', lineHeight: 1.6, fontSize: 10 }}
            placeholder={`curl 'https://api.example.com/events' \\\n  -H 'x-api-key: TOKEN'`}
          />
          {error && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)' }}>✗ {error}</span>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setOpen(false); setText(''); setError(''); }} style={s.btnGhost}>CANCEL</button>
            <button onClick={() => tryImport(text)} disabled={!text.trim()} style={{ ...s.btnAcid, flex: 1, background: text.trim() ? accentColor : 'var(--border-dim)', color: text.trim() ? '#0a0a0a' : 'var(--text-muted)', opacity: text.trim() ? 1 : .5 }}>IMPORT & POPULATE</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KVEditor ─────────────────────────────────────────────────────────────────

function KVEditor({ rows, onChange }: { rows: KV[]; onChange: (r: KV[]) => void }) {
  const set = (i: number, k: keyof KV, v: string) => onChange(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 4 }}>
          <input value={row.key} onChange={e => set(i, 'key', e.target.value)} placeholder="key" style={{ ...s.mini, flex: '0 0 38%', color: AUTH_RE.test(row.key) ? '#fb923c' : undefined }} />
          <input value={row.value} onChange={e => set(i, 'value', e.target.value)} placeholder="value" style={{ ...s.mini, flex: 1 }} />
          <button onClick={() => onChange(rows.filter((_, j) => j !== i))} style={{ background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, padding: '4px 7px', cursor: 'pointer' }}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { key: '', value: '' }])} style={{ background: 'none', border: '1px dashed var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, padding: '3px 10px', cursor: 'pointer', marginTop: 2, alignSelf: 'flex-start' }}>⊕ ADD</button>
    </div>
  );
}

// ─── JsonNode ─────────────────────────────────────────────────────────────────

function JsonNode({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [c, setC] = useState(depth > 1);
  if (data === null) return <span style={{ color: 'rgba(198,241,53,.4)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: 'rgba(6,182,212,.8)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: 'rgba(251,146,60,.9)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{data}</span>;
  if (typeof data === 'string') return <span style={{ color: 'rgba(167,243,208,.85)', fontFamily: 'var(--font-mono)', fontSize: 9 }} title={data}>"{data.length > 60 ? data.slice(0, 60) + '…' : data}"</span>;
  if (Array.isArray(data)) {
    if (!data.length) return <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>[]</span>;
    return <span><span onClick={() => setC(x => !x)} style={{ color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9, userSelect: 'none' }}>{c ? `▶ [${data.length}]` : '▾ ['}</span>{!c && <div style={{ marginLeft: 14 }}>{data.slice(0, 20).map((it, i) => <div key={i}><JsonNode data={it} depth={depth + 1} /></div>)}{data.length > 20 && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>…{data.length - 20} more</span>}<span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>]</span></div>}</span>;
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data as object);
    if (!keys.length) return <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{'{}'}</span>;
    return <span><span onClick={() => setC(x => !x)} style={{ color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9, userSelect: 'none' }}>{c ? `▶ {${keys.length}}` : '▾ {'}</span>{!c && <div style={{ marginLeft: 14 }}>{keys.map((k, i) => <div key={k} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}><span style={{ color: 'rgba(130,180,255,.8)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>"{k}"</span><span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>: </span><JsonNode data={(data as any)[k]} depth={depth + 1} />{i < keys.length - 1 && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>,</span>}</div>)}<span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{'}'}</span></div>}</span>;
  }
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)' }}>{String(data)}</span>;
}

// ─── FieldMapEditor ───────────────────────────────────────────────────────────

function FieldMapEditor({ fieldMap, firstItem, onChange }: { fieldMap: Record<string, string>; firstItem: unknown; onChange: (m: Record<string, string>) => void }) {
  const [newRole, setNewRole] = useState('match_id');
  const [newPath, setNewPath] = useState('');
  const flat = useMemo(() => firstItem ? flattenObj(firstItem) : [], [firstItem]);
  const entries = Object.entries(fieldMap);
  const add = () => { if (!newPath.trim()) return; onChange({ ...fieldMap, [newRole]: newPath.trim() }); setNewPath(''); };
  const remove = (role: string) => { const n = { ...fieldMap }; delete n[role]; onChange(n); };
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 120px', gap: 6, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-dim)' }}><span>ROLE</span><span>DOT-PATH</span><span>SAMPLE VALUE</span></div>
      {entries.map(([role, path]) => {
        const sample = path && firstItem ? String(getNestedValue(firstItem, path) ?? '') : '';
        return (
          <div key={role} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 120px 22px', gap: 6, padding: '5px 8px', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)' }}>{role}</span>
            <input value={path} onChange={e => onChange({ ...fieldMap, [role]: e.target.value })} style={{ ...s.mini, padding: '3px 7px' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{sample.slice(0, 22)}</span>
            <button onClick={() => remove(role)} style={{ background: 'none', border: 'none', color: 'rgba(255,61,90,.4)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
          </div>
        );
      })}
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 120px 22px', gap: 6, padding: '6px 8px', alignItems: 'center', borderTop: '1px solid var(--border-dim)' }}>
        <select value={newRole} onChange={e => setNewRole(e.target.value)} style={{ ...s.mini, padding: '3px 6px' }}>{ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select>
        <div style={{ position: 'relative' as const }}>
          <input value={newPath} onChange={e => setNewPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="e.g. event.id" style={{ ...s.mini, padding: '3px 7px' }} list="flat-paths" />
          <datalist id="flat-paths">{flat.map(f => <option key={f.path} value={f.path} />)}</datalist>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.6)' }}>{newPath && firstItem ? String(getNestedValue(firstItem, newPath) ?? '').slice(0, 18) : ''}</span>
        <button onClick={add} disabled={!newPath.trim()} style={{ ...s.btnAcid, padding: '3px 0', width: 22, fontSize: 14, opacity: newPath.trim() ? 1 : .3 }}>+</button>
      </div>
    </div>
  );
}

// ─── ProbeResultPanel ─────────────────────────────────────────────────────────

function ProbeResultPanel({ result, accent = 'var(--acid)' }: { result: any; accent?: string }) {
  const [tab, setTab] = useState<'tree' | 'raw' | 'curl'>('tree');
  const [copied, setCopied] = useState(false);
  if (!result) return null;

  const curlText: string = result.curl_regenerated || result.curl || '';
  const hasCurl = !!curlText;
  const isRegenerated = !!(result.curl_regenerated && result.curl_regenerated !== result.curl);

  const copyCurl = () => {
    navigator.clipboard.writeText(curlText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!result.ok && <div style={{ padding: '8px 12px', background: 'rgba(255,61,90,.04)', border: '1px solid rgba(255,61,90,.25)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)' }}>✗ {result.error ?? `HTTP ${result.status}`}</div>}
      {result.ok && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: `${accent}08`, border: `1px solid ${accent}33` }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: accent }}>✓ HTTP {result.status}</span>
          {result.latency_ms != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{result.latency_ms}ms</span>}
          {result.size_bytes > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{(result.size_bytes / 1024).toFixed(1)}KB</span>}
          {result.array_length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, marginLeft: 'auto', border: `1px solid ${accent}44`, padding: '1px 8px' }}>{result.array_length} items{result.array_key ? ` @ ${result.array_key}` : ''}</span>}
        </div>
      )}
      {result.parsed !== null && <>
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-dim)', alignItems: 'center' }}>
          {(['tree', 'raw', 'curl'] as const).map(t => {
            if (t === 'curl' && !hasCurl) return null;
            return (
              <button key={t} onClick={() => setTab(t)} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, padding: '5px 12px', background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? accent : 'transparent'}`, marginBottom: -1, color: tab === t ? accent : 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {t === 'curl' && isRegenerated && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--acid)', display: 'inline-block' }} />}
                {t.toUpperCase()}{t === 'curl' && isRegenerated ? ' (LIVE)' : ''}
              </button>
            );
          })}
          {tab === 'curl' && hasCurl && (
            <button onClick={copyCurl} style={{ ...s.btnGhost, marginLeft: 'auto', fontSize: 7, padding: '3px 10px', borderColor: `${accent}44`, color: accent }}>
              {copied ? '✓ COPIED' : '⎘ COPY'}
            </button>
          )}
        </div>
        {tab === 'tree' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><div style={{ ...s.label, marginBottom: 4 }}>FULL RESPONSE</div><div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 220, overflowY: 'auto' }}><JsonNode data={result.parsed} /></div></div>
            <div><div style={{ ...s.label, marginBottom: 4 }}>FIRST ITEM</div><div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 220, overflowY: 'auto' }}>{result.first_item ? <JsonNode data={result.first_item} /> : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>No array found</span>}</div></div>
          </div>
        )}
        {tab === 'raw' && (
          <div style={{ background: 'rgba(6,10,6,.9)', border: '1px solid var(--border-dim)', padding: '10px 12px', maxHeight: 300, overflowY: 'auto' }}>
            <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(167,243,208,.8)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.6 }}>{JSON.stringify(result.parsed, null, 2)}</pre>
          </div>
        )}
        {tab === 'curl' && hasCurl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {isRegenerated && <div style={{ padding: '5px 10px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.2)', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--acid)', letterSpacing: 1 }}>⚡ LIVE — includes browser-generated x-hd token from this request</div>}
            <div style={{ background: 'rgba(6,10,6,.9)', border: '1px solid var(--border-dim)', padding: '10px 12px', maxHeight: 320, overflowY: 'auto' }}>
              <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(167,243,208,.8)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.8 }}>{curlText}</pre>
            </div>
          </div>
        )}
      </>}
    </div>
  );
}

// ─── InlineStepIterator ───────────────────────────────────────────────────────

interface IterItem { id: string | number; label: string; meta?: any }
interface IProbeResult { ok: boolean; status: number | null; latency_ms: number | null; parsed: unknown; first_item: unknown; array_key: string | null; array_length: number; size_bytes: number; error: string | null }
type IStat = 'pending' | 'probing' | 'done' | 'accepted' | 'skipped';
interface IState { status: IStat; result: IProbeResult | null }

function InlineStepIterator({ title, accent = 'var(--acid)', items, buildRequest, onAccepted, onComplete, sessionId }: {
  title: string; accent?: string; items: IterItem[];
  buildRequest: (item: IterItem) => { url: string; method?: string; headers?: Record<string, string>; params?: Record<string, string>; body?: string | null; url_raw?: string };
  onAccepted?: (item: IterItem, result: IProbeResult) => void;
  onComplete?: (accepted: { item: IterItem; result: IProbeResult }[]) => void;
  sessionId: number;
}) {
  const init = () => Object.fromEntries(items.map(it => [it.id, { status: 'pending' as IStat, result: null }]));
  const [states, setStates] = useState<Record<string | number, IState>>(init);
  const [cursor, setCursor] = useState(0);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const current = items[cursor] ?? null;
  const curState = current ? (states[current.id] ?? { status: 'pending' as IStat, result: null }) : { status: 'pending' as IStat, result: null };
  const accepted = items.filter(it => states[it.id]?.status === 'accepted').length;
  const doneCount = items.filter(it => ['accepted', 'skipped', 'done'].includes(states[it.id]?.status ?? '')).length;

  const patch = (id: string | number, p: Partial<IState>) => setStates(prev => ({ ...prev, [id]: { ...prev[id], ...p } }));

  const probe = async () => {
    if (!current || curState.status === 'probing') return;
    abortRef.current?.abort();
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const req = buildRequest(current);
    patch(current.id, { status: 'probing', result: null });
    try {
      const data: IProbeResult = await api(`/sessions/${sessionId}/probe`, {
        method: 'POST',
        signal: ctrl.signal,
        body: JSON.stringify({
          url:     req.url,
          method:  req.method  ?? 'GET',
          headers: req.headers ?? {},
          params:  req.params  ?? {},
          body:    req.body    ?? null,
          url_raw: req.url_raw ?? '',  // ← forwarded from buildMarketReq
        }),
      });
      patch(current.id, { status: 'done', result: data });
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      patch(current.id, { status: 'done', result: { ok: false, status: null, latency_ms: null, parsed: null, first_item: null, array_key: null, array_length: 0, size_bytes: 0, error: e.message ?? 'Error' } });
    }
  };

  const advance = useCallback(() => {
    const next = cursor + 1;
    if (next >= items.length) {
      setFinished(true);
      const acc = items.filter(it => states[it.id]?.status === 'accepted').map(it => ({ item: it, result: states[it.id]!.result! }));
      onComplete?.(acc);
    } else { setCursor(next); }
  }, [cursor, items, states, onComplete]);

  const accept = () => { if (!current || !curState.result) return; patch(current.id, { status: 'accepted' }); onAccepted?.(current, curState.result); advance(); };
  const skip = () => { if (!current) return; patch(current.id, { status: 'skipped' }); advance(); };

  const ab = `${accent}44`, abg = `${accent}0d`;
  const result = curState.result;
  const isProbing = curState.status === 'probing';
  const isDone = curState.status === 'done';

  if (!started) return (
    <div style={{ border: `1px solid ${ab}`, background: abg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${ab}` }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 800, letterSpacing: 2, color: accent }}>{title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>MANUAL STEP-THROUGH · {items.length} ITEMS</span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ border: '1px solid var(--border-dim)', maxHeight: 160, overflowY: 'auto' }}>
          {items.map((it, i) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--border-dim)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', width: 20 }}>{i + 1}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)', flex: 1 }}>{it.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{String(it.id)}</span>
            </div>
          ))}
        </div>
        <button onClick={() => setStarted(true)} disabled={items.length === 0} style={{ ...s.btnAcid, background: accent, alignSelf: 'flex-start', opacity: items.length > 0 ? 1 : .4 }}>▶ START ITERATION</button>
      </div>
    </div>
  );

  if (finished) return (
    <div style={{ border: `1px solid ${ab}`, background: abg, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 800, letterSpacing: 2, color: accent }}>✓ {title} COMPLETE — {accepted}/{items.length} accepted</div>
      {items.map(it => {
        const st = states[it.id];
        return (
          <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'rgba(255,255,255,.02)', border: '1px solid var(--border-dim)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: st?.status === 'accepted' ? accent : 'var(--text-muted)', width: 16 }}>{st?.status === 'accepted' ? '✓' : '—'}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)', flex: 1 }}>{it.label}</span>
            {st?.result?.array_length != null && st.result.array_length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(198,241,53,.6)' }}>{st.result.array_length} items</span>}
            {st?.result?.latency_ms != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{st.result.latency_ms}ms</span>}
          </div>
        );
      })}
      <button onClick={() => { setStarted(false); setFinished(false); setCursor(0); setStates(init()); }} style={{ ...s.btnGhost, fontSize: 8, alignSelf: 'flex-start' }}>↺ RESET</button>
    </div>
  );

  const dot = (st: IStat) => st === 'accepted' ? accent : st === 'done' ? (result?.ok ? accent : 'var(--red)') : st === 'probing' ? 'rgba(251,146,60,.9)' : 'var(--text-muted)';

  return (
    <div style={{ border: `1px solid ${ab}`, background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: abg, borderBottom: `1px solid ${ab}` }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 800, letterSpacing: 2, color: accent }}>{title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{cursor + 1}/{items.length}</span>
        <div style={{ flex: 1, height: 3, background: 'var(--border-dim)', position: 'relative' as const }}><div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(doneCount / items.length) * 100}%`, background: accent, transition: 'width .3s' }} /></div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{accepted} accepted</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', minHeight: 320 }}>
        <div style={{ borderRight: '1px solid var(--border-dim)', overflowY: 'auto', maxHeight: 460 }}>
          {items.map((it, i) => {
            const st = states[it.id]; const isCur = i === cursor;
            return (
              <div key={it.id} onClick={() => setCursor(i)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: isCur ? `${accent}10` : 'transparent', borderLeft: `3px solid ${isCur ? accent : 'transparent'}`, borderBottom: '1px solid var(--border-dim)', cursor: 'pointer' }}
                onMouseEnter={e => { if (!isCur) e.currentTarget.style.background = 'rgba(255,255,255,.03)'; }}
                onMouseLeave={e => { if (!isCur) e.currentTarget.style.background = 'transparent'; }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: dot(st?.status ?? 'pending'), flexShrink: 0, opacity: st?.status === 'pending' ? .3 : 1 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: isCur ? accent : 'var(--text-primary)', fontWeight: isCur ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{it.label}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{String(it.id)}</div>
                </div>
                {st?.result?.array_length != null && st.result.array_length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(198,241,53,.6)', flexShrink: 0 }}>{st.result.array_length}</span>}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 700 }}>{current?.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{String(current?.id)}</div>
            </div>
            {result?.status && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: result.ok ? 'var(--acid)' : 'var(--red)', border: `1px solid ${result.ok ? 'rgba(198,241,53,.4)' : 'rgba(255,61,90,.4)'}`, padding: '2px 8px' }}>{result.status}</span>}
            {result?.latency_ms != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{result.latency_ms}ms</span>}
          </div>
          <div style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {isDone && result && <ProbeResultPanel result={result} accent={accent} />}
            {curState.status === 'pending' && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: .5 }}>↓ Click PROBE to fire this request</span></div>}
            {isProbing && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(251,146,60,.9)', display: 'inline-block', animation: 'spin .7s linear infinite' }}>⟳</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(251,146,60,.9)' }}>Probing…</span></div>}
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-dim)', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-elevated)' }}>
            {!isProbing && <button onClick={probe} style={{ ...s.btnAcid, background: accent, fontSize: 9 }}>{isDone ? '↺ RE-PROBE' : '▶ PROBE'}</button>}
            {isProbing && <button onClick={() => abortRef.current?.abort()} style={{ ...s.btnGhost, borderColor: 'rgba(255,61,90,.4)', color: 'var(--red)' }}>■ ABORT</button>}
            <div style={{ flex: 1 }} />
            <button onClick={skip} disabled={isProbing} style={{ ...s.btnGhost, opacity: isProbing ? .4 : 1, fontSize: 8 }}>SKIP →</button>
            {isDone && result?.ok && <button onClick={accept} style={{ ...s.btnAcid, background: `${accent}22`, color: accent, border: `1px solid ${accent}66` }}>✓ ACCEPT & {cursor < items.length - 1 ? 'NEXT →' : 'FINISH'}</button>}
            {isDone && !result?.ok && <button onClick={accept} style={{ ...s.btnGhost, borderColor: 'rgba(251,146,60,.4)', color: '#fb923c', fontSize: 8 }}>ACCEPT ANYWAY & {cursor < items.length - 1 ? 'NEXT →' : 'FINISH'}</button>}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LIST / LIVE_LIST Phase ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ListPhase({ session, phase, sports, onUpdate, onToast }: {
  session: OnboardingSession; phase: 'LIST' | 'LIVE_LIST';
  sports: SportOption[]; onUpdate: (p: any) => Promise<void>; onToast: (m: string) => void;
}) {
  const isLive = phase === 'LIVE_LIST';
  const prefix = isLive ? 'live_list' : 'list';
  const accent = isLive ? 'var(--cyan)' : 'var(--acid)';

  const sessUrl     = (session as any)[`${prefix}_url`]        || '';
  const sessMethod  = (session as any)[`${prefix}_method`]     || 'GET';
  const sessHeaders = (session as any)[`${prefix}_headers`]    || {};
  const sessParams  = (session as any)[`${prefix}_params`]     || {};
  const sessArray   = (session as any)[`${prefix}_array_path`] || '';
  const sessRawUrl  = (session as any)[`${prefix}_url_raw`]    || '';
  const fieldMap    = (session as any)[`${prefix}_field_map`]  || {};
  const phaseOk     = (session as any)[`${prefix}_ok`];

  const [urlInput,    setUrlInput]    = useState(sessUrl);
  const [methodSel,   setMethodSel]   = useState(sessMethod);
  const [headerRows,  setHeaderRows]  = useState<KV[]>(() => objToKv(sessHeaders));
  const [paramRows,   setParamRows]   = useState<KV[]>(() => objToKv(sessParams));
  const [arrayInput,  setArrayInput]  = useState(sessArray);
  // rawUrlLocal mirrors sessRawUrl but updates immediately on curl import,
  // without waiting for the async onUpdate → session prop cycle to complete.
  // This ensures url_raw is never empty when the user clicks PROBE right after
  // pasting a curl command.
  const [rawUrlLocal, setRawUrlLocal] = useState(sessRawUrl);
  const [tab,         setTab]         = useState<'params' | 'headers'>('params');
  const [probeState,  setProbeState]  = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [probeData,   setProbeData]   = useState<any>(null);
  const [firstItem,   setFirstItem]   = useState<any>(null);
  const [sportIdPath, setSportIdPath] = useState(session.list_sport_id_path || '');
  const [sportRows,   setSportRows]   = useState<SportMapping[]>(session.sport_mappings || []);

  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (session.id === prevSessionId.current) return;
    prevSessionId.current = session.id;
    setUrlInput((session as any)[`${prefix}_url`] || '');
    setMethodSel((session as any)[`${prefix}_method`] || 'GET');
    setHeaderRows(objToKv((session as any)[`${prefix}_headers`] || {}));
    setParamRows(objToKv((session as any)[`${prefix}_params`] || {}));
    setArrayInput((session as any)[`${prefix}_array_path`] || '');
    setRawUrlLocal((session as any)[`${prefix}_url_raw`] || '');
    setProbeData(null); setFirstItem(null); setProbeState('idle');
    setSportIdPath(session.list_sport_id_path || '');
    setSportRows(session.sport_mappings || []);
  }, [session.id, session, prefix]);

  const handleCurlImport = useCallback((p: ReturnType<typeof parseCurl>) => {
    // List phase: use real URL + real param values (no templating needed here).
    setUrlInput(p.url);
    setMethodSel(p.method);
    setHeaderRows(p.headers.length ? p.headers : []);
    setParamRows(p.params.length ? p.params : []);
    setProbeData(null); setFirstItem(null); setProbeState('idle');
    // Update local state immediately so probe() has the value before the
    // async onUpdate → session prop cycle completes (fixes empty url_raw bug).
    setRawUrlLocal(p.rawUrl);
    onUpdate({ [`${prefix}_url_raw`]: p.rawUrl });
  }, [prefix, onUpdate]);

  const hc = headerRows.filter(r => r.key.trim()).length;
  const pc = paramRows.filter(r => r.key.trim()).length;

  const probe = async () => {
    if (!urlInput.trim()) return;
    setProbeState('loading');
    try {
      const res = await api(`/sessions/${session.id}/probe`, {
        method: 'POST',
        body: JSON.stringify({
          url:        urlInput,
          method:     methodSel,
          headers:    kvToObj(headerRows),
          params:     kvToObj(paramRows),
          phase:      prefix,
          array_path: arrayInput || null,
          url_raw:    rawUrlLocal,  // ← local state: always current, never one render behind
        }),
      });
      if (res.ok) {
        setProbeState('ok'); setProbeData(res.parsed);
        const items = arrayInput
          ? (getNestedValue(res.parsed, arrayInput) as any[] || [])
          : (Array.isArray(res.parsed) ? res.parsed : Object.values(res.parsed || {}).find(Array.isArray) as any[] || []);
        setFirstItem(items[0] ?? res.first_item);
        if (!arrayInput && res.array_key) setArrayInput(res.array_key);
        if (!isLive && items[0] && !sportIdPath) {
          const flat = flattenObj(items[0]);
          const g = flat.find(f => /sport[_.]?id$/i.test(f.path));
          if (g) setSportIdPath(g.path);
        }
        await onUpdate({
          [`${prefix}_url`]:        urlInput,
          [`${prefix}_method`]:     methodSel,
          [`${prefix}_headers`]:    kvToObj(headerRows),
          [`${prefix}_params`]:     kvToObj(paramRows),
          [`${prefix}_array_path`]: arrayInput || (res.array_key || ''),
          ...(!isLive ? { list_sport_id_path: sportIdPath } : {}),
        });
        onToast('✓ Probe successful');
      } else { setProbeState('error'); onToast(`✗ ${res.error ?? 'Probe failed'}`); }
    } catch (e: any) { setProbeState('error'); onToast(`✗ ${e.message}`); }
  };

  const detectSports = () => {
    if (!sportIdPath || !probeData) return;
    const items = Array.isArray(probeData) ? probeData : (Object.values(probeData).find(Array.isArray) as any[] || []);
    const seen = new Set<string>();
    items.slice(0, 50).forEach((item: any) => { const v = getNestedValue(item, sportIdPath); if (v != null) seen.add(String(v)); });
    const existing = new Set(sportRows.map(s => s.bk_sport_id));
    const newRows = [...seen].filter(id => !existing.has(id)).map(id => ({ bk_sport_id: id, sport_id: null, sport_name: '', param_key: 'sport_id', param_in: 'query' as const, status: 'pending' as const, item_count: 0 }));
    setSportRows(prev => [...prev, ...newRows]);
    onToast(`✓ Detected ${newRows.length} sport ID(s)`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {phaseOk && <div style={{ padding: '7px 12px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.25)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)', letterSpacing: 1 }}>✓ PHASE COMPLETE</div>}

      <CurlImportBox accentColor={accent} onImport={handleCurlImport} />

      {/* URL Blueprint — shows saved raw URL with param tokens (no template for list phase) */}
      {rawUrlLocal && (
        <UrlBlueprint
          rawUrl={rawUrlLocal}
          accent={accent}
          onUse={raw => {
            // List phase: restore original values (not templated)
            const p = parseCurl(`curl '${raw}'`);
            setUrlInput(p.url);
            setParamRows(p.params);
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <select value={methodSel} onChange={e => setMethodSel(e.target.value)} style={{ ...s.mini, flex: '0 0 80px', color: 'var(--cyan)', fontWeight: 700 }}>
          {['GET', 'POST', 'PUT', 'PATCH'].map(m => <option key={m}>{m}</option>)}
        </select>
        <input value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="https://api.bookmaker.com/v2/events" style={{ ...s.mini, flex: 1 }} onKeyDown={e => e.key === 'Enter' && probe()} />
      </div>

      {headerRows.filter(r => r.key.trim()).length > 0 && <HeadersPanel headers={kvToObj(headerRows)} />}

      <div>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 8 }}>
          {(['params', 'headers'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? accent : 'transparent'}`, color: tab === t ? accent : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '6px 14px', cursor: 'pointer', marginBottom: -1 }}>
              {t === 'params' ? `PARAMS${pc ? ` (${pc})` : ''}` : `HEADERS${hc ? ` (${hc})` : ''}`}
            </button>
          ))}
        </div>
        <KVEditor rows={tab === 'params' ? paramRows : headerRows} onChange={tab === 'params' ? setParamRows : setHeaderRows} />
      </div>

      <div>
        <label style={s.label}>RESULT ARRAY PATH</label>
        <input value={arrayInput} onChange={e => setArrayInput(e.target.value)} placeholder="e.g. data.events  (blank = root)" style={s.input} />
      </div>

      <button onClick={probe} disabled={!urlInput.trim() || probeState === 'loading'} style={{ ...s.btnAcid, background: urlInput.trim() ? accent : 'var(--border-dim)', color: urlInput.trim() ? '#0a0a0a' : 'var(--text-muted)', padding: '10px 0', width: '100%', opacity: urlInput.trim() ? 1 : .5, fontSize: 9, letterSpacing: 2 }}>
        {probeState === 'loading' ? '⟳ PROBING…' : `▶ PROBE ${phase}`}
      </button>

      {probeData && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={s.label}>RESPONSE</label><div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 200, overflowY: 'auto' }}><JsonNode data={probeData} /></div></div>
          <div><label style={s.label}>FIRST ITEM</label><div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 200, overflowY: 'auto' }}>{firstItem ? <JsonNode data={firstItem} /> : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>No array</span>}</div></div>
        </div>
      )}

      {firstItem && (
        <div>
          <label style={s.label}>FIELD MAPPINGS</label>
          <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-base)' }}>
            <FieldMapEditor fieldMap={fieldMap} firstItem={firstItem} onChange={fm => onUpdate({ [`${prefix}_field_map`]: fm })} />
          </div>
        </div>
      )}

      {!isLive && probeData && (
        <div style={{ border: '1px solid rgba(198,241,53,.2)', background: 'rgba(198,241,53,.03)' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(198,241,53,.15)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--acid)' }}>⚡ SPORT ID MAPPING</div>
          <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>SPORT_ID FIELD PATH</label>
                <input value={sportIdPath} onChange={e => setSportIdPath(e.target.value)} placeholder="e.g. sport_id" style={s.input} list="flat-sport" />
                {firstItem && <datalist id="flat-sport">{flattenObj(firstItem).map(f => <option key={f.path} value={f.path} />)}</datalist>}
              </div>
              <button onClick={detectSports} disabled={!sportIdPath || !probeData} style={{ ...s.btnAcid, fontSize: 8 }}>AUTO-DETECT</button>
            </div>
            {sportRows.length > 0 && <>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 70px', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', padding: '2px 0' }}>
                <span>BK ID</span><span>CANONICAL SPORT</span><span>PARAM KEY</span><span>IN</span><span>STATUS</span>
              </div>
              {sportRows.map((sm, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 70px', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--cyan)', fontWeight: 700 }}>{sm.bk_sport_id}</span>
                  <select value={sm.sport_id ?? ''} onChange={e => setSportRows(p => p.map((r, j) => j === i ? { ...r, sport_id: e.target.value ? Number(e.target.value) : null, sport_name: sports.find(s => s.id === Number(e.target.value))?.name || r.sport_name } : r))} style={s.mini}>
                    <option value="">— map to sport —</option>
                    {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                  </select>
                  <input value={sm.param_key} onChange={e => setSportRows(p => p.map((r, j) => j === i ? { ...r, param_key: e.target.value } : r))} placeholder="param key" style={s.mini} />
                  <select value={sm.param_in} onChange={e => setSportRows(p => p.map((r, j) => j === i ? { ...r, param_in: e.target.value as any } : r))} style={s.mini}>
                    <option value="query">query</option><option value="path">path</option>
                  </select>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: sm.status === 'ok' ? 'var(--acid)' : sm.status === 'error' ? 'var(--red)' : 'var(--text-muted)' }}>{sm.status === 'ok' ? `✓ ${sm.item_count}` : sm.status === 'error' ? '✗' : '…'}</span>
                </div>
              ))}
              <button onClick={() => setSportRows(p => [...p, { bk_sport_id: '', sport_id: null, sport_name: '', param_key: 'sport_id', param_in: 'query', status: 'pending', item_count: 0 }])} style={{ ...s.btnGhost, fontSize: 7, alignSelf: 'flex-start' }}>⊕ ADD SPORT ID</button>
              <div style={{ display: 'flex', gap: 6, paddingTop: 4, borderTop: '1px solid var(--border-dim)' }}>
                <button onClick={async () => { await onUpdate({ sport_mappings: sportRows, list_sport_id_path: sportIdPath }); onToast('✓ Mappings saved'); }} style={{ ...s.btnAcid, fontSize: 8, padding: '6px 14px' }}>SAVE MAPPINGS</button>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', alignSelf: 'center' }}>Sport iteration happens in the SPORTS phase after markets are configured</span>
              </div>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MARKETS / LIVE_MARKETS Phase ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type MktSubStep = 'raw_test' | 'wire' | 'iterate';

function MarketsPhase({ session, phase, onUpdate, onToast }: {
  session: OnboardingSession; phase: 'MARKETS' | 'LIVE_MARKETS';
  onUpdate: (p: any) => Promise<void>; onToast: (m: string) => void;
}) {
  const isLive     = phase === 'LIVE_MARKETS';
  const prefix     = isLive ? 'live_markets' : 'markets';
  const accent     = isLive ? '#f472b6' : '#38bdf8';
  const listPrefix = isLive ? 'live_list' : 'list';

  const storedUrl    = (session as any)[`${prefix}_url_template`]    || '';
  const storedRawUrl = (session as any)[`${prefix}_url_raw`]         || '';
  const storedMethod = (session as any)[`${prefix}_method`]          || 'GET';
  const storedHdrs   = (session as any)[`${prefix}_headers`]         || {};
  const storedParams = (session as any)[`${prefix}_params`]          || {};
  const storedArray  = (session as any)[`${prefix}_array_path`]      || '';
  const storedFm     = (session as any)[`${prefix}_field_map`]       || {};
  const storedPhMap  = (session as any)[`${prefix}_placeholder_map`] || {};
  const phaseOk      = (session as any)[`${prefix}_ok`];
  const listFieldMap = isLive ? (session.live_list_field_map || {}) : (session.list_field_map || {});

  const [urlInput,   setUrlInput]   = useState(storedUrl);
  const [methodSel,  setMethodSel]  = useState(storedMethod);
  const [headerRows, setHeaderRows] = useState<KV[]>(() => objToKv(storedHdrs));
  const [paramRows,  setParamRows]  = useState<KV[]>(() => objToKv(storedParams));
  const [arrayInput, setArrayInput] = useState(storedArray);
  const [phMap,      setPhMap]      = useState<Record<string, string>>(storedPhMap);
  // rawUrlLocal mirrors storedRawUrl but updates immediately on curl import —
  // prevents url_raw being empty when probe fires before session prop re-renders.
  const [rawUrlLocal, setRawUrlLocal] = useState(storedRawUrl);
  const [tab,        setTab]        = useState<'params' | 'headers'>('params');
  const [subStep,    setSubStep]    = useState<MktSubStep>('raw_test');
  const [rawResult,  setRawResult]  = useState<any>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [detecting,  setDetecting]  = useState(false);
  const [firstItem,  setFirstItem]  = useState<any>(null);
  const [matchItems, setMatchItems] = useState<IterItem[]>([]);
  const [iterKey,    setIterKey]    = useState(0);
  const [cacheInfo,  setCacheInfo]  = useState('');

  const urlRef    = useRef(urlInput);
  const methodRef = useRef(methodSel);
  const hdrRef    = useRef(headerRows);
  const prmRef    = useRef(paramRows);
  const phMapRef  = useRef(phMap);
  useEffect(() => { urlRef.current    = urlInput;   }, [urlInput]);
  useEffect(() => { methodRef.current = methodSel;  }, [methodSel]);
  useEffect(() => { hdrRef.current    = headerRows; }, [headerRows]);
  useEffect(() => { prmRef.current    = paramRows;  }, [paramRows]);
  useEffect(() => { phMapRef.current  = phMap;      }, [phMap]);

  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (session.id === prevSessionId.current) return;
    prevSessionId.current = session.id;
    setUrlInput((session as any)[`${prefix}_url_template`] || '');
    setMethodSel((session as any)[`${prefix}_method`] || 'GET');
    setHeaderRows(objToKv((session as any)[`${prefix}_headers`] || {}));
    setParamRows(objToKv((session as any)[`${prefix}_params`] || {}));
    setArrayInput((session as any)[`${prefix}_array_path`] || '');
    setPhMap((session as any)[`${prefix}_placeholder_map`] || {});
    setRawUrlLocal((session as any)[`${prefix}_url_raw`] || '');
    setRawResult(null); setFirstItem(null); setSubStep('raw_test'); setMatchItems([]);
  }, [session.id, session, prefix]);

  const handleCurlImport = useCallback((p: ReturnType<typeof parseCurl>) => {
    // Pre-populate URL input with urlTemplate (params as {{key}} placeholders).
    // rawUrl is saved as the blueprint for param order + encoding preservation.
    setUrlInput(p.urlTemplate || p.url);
    setMethodSel(p.method);
    setHeaderRows(p.headers.length ? p.headers : []);
    setParamRows(p.params.length ? p.params.map(kv => ({
      key:   kv.key,
      value: `{{${kv.key}}}`,
    })) : []);
    setRawResult(null); setFirstItem(null);
    // Update local state immediately — prevents url_raw being empty if the user
    // clicks probe before the async onUpdate → session prop cycle completes.
    setRawUrlLocal(p.rawUrl);
    onUpdate({
      [`${prefix}_url_raw`]:      p.rawUrl,
      [`${prefix}_url_template`]: p.urlTemplate || p.url,
    });
  }, [prefix, onUpdate]);

  const vars = useMemo(() => [...new Set([...(urlInput.matchAll(/\{\{(\w+)\}\}/g))].map(m => m[1]))], [urlInput]);

  const rawTest = async () => {
    if (!urlInput.trim()) return;
    setRawLoading(true); setRawResult(null);
    try {
      const res = await api(`/sessions/${session.id}/probe`, {
        method: 'POST',
        body: JSON.stringify({
          url:     urlInput,
          method:  methodSel,
          headers: kvToObj(headerRows),
          params:  kvToObj(paramRows),
          body:    null,
          url_raw: rawUrlLocal,  // ← local state: always current
        }),
      });
      setRawResult(res);
      if (res.ok) {
        const fi = res.first_item ?? (Array.isArray(res.parsed) ? res.parsed[0] : null);
        if (fi) setFirstItem(fi);
        await onUpdate({
          [`${prefix}_url_template`]: urlInput,
          [`${prefix}_method`]:       methodSel,
          [`${prefix}_headers`]:      kvToObj(headerRows),
          [`${prefix}_params`]:       kvToObj(paramRows),
        });
        onToast(`✓ Raw test OK — ${res.array_length ?? 0} items`);
      } else { onToast(`✗ ${res.error ?? `HTTP ${res.status}`}`); }
    } catch (e: any) { setRawResult({ ok: false, error: e.message }); onToast(`✗ ${e.message}`); }
    setRawLoading(false);
  };

  const detectPlaceholders = async () => {
    if (!urlInput.trim()) return;
    setDetecting(true);
    try {
      const res = await api(`/sessions/${session.id}/detect-placeholders`, {
        method: 'POST',
        body: JSON.stringify({
          url:     urlInput,
          params:  kvToObj(paramRows),
          url_raw: rawUrlLocal,  // ← local state: always current
        }),
      });
      if (res.ok) {
        if (res.suggested_url && res.suggested_url !== urlInput) setUrlInput(res.suggested_url);
        if (res.suggested_params) setParamRows(objToKv(res.suggested_params));
        const nm: Record<string, string> = { ...phMap };
        (res.detected || []).forEach((d: any) => { nm[d.var] = listFieldMap[d.var] || d.field_path || d.var; });
        setPhMap(nm);
        onToast(res.detected?.length ? `✓ Detected ${res.detected.length} placeholder(s)` : '⚠ No placeholders found');
      }
    } catch (e: any) { onToast(`✗ ${e.message}`); }
    setDetecting(false);
  };

  const loadMatchesFromCache = () => {
    const rawSample = (session as any)[`${listPrefix}_sample`];
    if (!rawSample) { onToast(`✗ No cached list sample — probe the ${isLive ? 'LIVE ' : ''}LIST phase first`); setCacheInfo(`❌ session.${listPrefix}_sample is null/undefined`); return; }
    let arr: any[] = [];
    try { const parsed = JSON.parse(rawSample); arr = Array.isArray(parsed) ? parsed : []; }
    catch (err) { onToast('✗ Could not parse cached list sample'); setCacheInfo(`❌ JSON.parse failed: ${String(err).slice(0, 80)}`); return; }
    if (!arr.length) { onToast('⚠ Cached list sample is empty'); setCacheInfo('⚠ Parsed OK but array is empty'); return; }
    const fm = listFieldMap, mip = fm['match_id'] || 'id', hp = fm['home_team'] || '', ap = fm['away_team'] || '';
    const built: IterItem[] = arr.slice(0, 20).map((item, idx) => {
      const mid = getNestedValue(item, mip) ?? idx;
      const home = hp ? String(getNestedValue(item, hp) || '') : '';
      const away = ap ? String(getNestedValue(item, ap) || '') : '';
      return { id: String(mid), label: home && away ? `${home} v ${away}` : `Match ${mid}`, meta: item };
    });
    setMatchItems(built); setIterKey(k => k + 1);
    setCacheInfo(`✓ Loaded ${built.length} items (match_id path: "${mip}")`);
    onToast(`✓ ${built.length} matches loaded from cache`);
  };

  const resolveItem = (item: IterItem) => {
    const tmpl       = urlRef.current;
    const mth        = methodRef.current;
    const hdrs       = kvToObj(hdrRef.current);
    const baseParams = kvToObj(prmRef.current);
    const pm         = phMapRef.current;
    const tvars      = [...new Set([...(tmpl.matchAll(/\{\{(\w+)\}\}/g))].map(m => m[1]))];

    let resolvedUrl = tmpl;
    let resolvedRaw = rawUrlLocal;  // ← local state, always current
    const rp: Record<string, string> = { ...baseParams };

    tvars.forEach(vname => {
      const path  = pm[vname];
      const value = path ? String(getNestedValue(item.meta, path) ?? item.id) : String(item.id);
      resolvedUrl = resolvedUrl.replace(new RegExp(`\\{\\{${vname}\\}\\}`, 'g'), value);
      resolvedRaw = resolvedRaw.replace(new RegExp(`\\{\\{${vname}\\}\\}`, 'g'), value);
      Object.keys(rp).forEach(pk => { rp[pk] = rp[pk].replace(new RegExp(`\\{\\{${vname}\\}\\}`, 'g'), value); });
    });

    return { url: resolvedUrl, url_raw: resolvedRaw, method: mth, headers: hdrs, params: rp };
  };

  const buildMarketRequest = useCallback((item: IterItem) => resolveItem(item), []);

  const handleAccepted = (_item: IterItem, result: IProbeResult) => {
    const fi = result.first_item ?? (Array.isArray(result.parsed) ? (result.parsed as any[])[0] : null);
    if (fi && !firstItem) setFirstItem(fi);
  };

  const handleIterComplete = async (accepted: { item: IterItem; result: IProbeResult }[]) => {
    if (!accepted.length) { onToast('⚠ No markets accepted'); return; }
    await onUpdate({ [`${prefix}_url_template`]: urlRef.current, [`${prefix}_method`]: methodRef.current, [`${prefix}_headers`]: kvToObj(hdrRef.current), [`${prefix}_params`]: kvToObj(prmRef.current), [`${prefix}_array_path`]: arrayInput, [`${prefix}_placeholder_map`]: phMapRef.current, [`${prefix}_ok`]: true });
    onToast(`✓ ${accepted.length} matches accepted — config saved`);
  };

  const SUB_STEPS: MktSubStep[] = ['raw_test', 'wire', 'iterate'];
  const SUB_LABELS: Record<MktSubStep, string> = { raw_test: 'A · Raw Test', wire: 'B · Wire Vars', iterate: 'C · Iterate' };
  const rawOk = rawResult?.ok === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {phaseOk && <div style={{ padding: '7px 12px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.25)', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)' }}>✓ PHASE COMPLETE</div>}

      <div style={{ display: 'flex', borderBottom: '2px solid var(--border-dim)' }}>
        {SUB_STEPS.map((ss, idx) => {
          const isActive = subStep === ss;
          const isDone = ss === 'raw_test' ? rawOk : ss === 'wire' ? (vars.length > 0 && Object.keys(phMap).length >= vars.length) : false;
          return (
            <button key={ss} onClick={() => setSubStep(ss)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: isActive ? 'var(--bg-elevated)' : 'transparent', border: 'none', borderBottom: `2px solid ${isActive ? accent : 'transparent'}`, marginBottom: -2, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
              <div style={{ width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isDone ? accent : isActive ? `${accent}22` : 'rgba(255,255,255,.06)', border: `1px solid ${isDone || isActive ? accent : 'var(--border-dim)'}`, fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 800, color: isDone ? '#0a0a0a' : isActive ? accent : 'var(--text-muted)' }}>
                {isDone ? '✓' : idx + 1}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, color: isActive ? accent : 'var(--text-muted)' }}>{SUB_LABELS[ss]}</span>
            </button>
          );
        })}
      </div>

      {/* ── A: Raw Test ── */}
      {subStep === 'raw_test' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ padding: '8px 12px', background: `${accent}08`, border: `1px solid ${accent}22`, fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, lineHeight: 1.6 }}>
            Paste the markets curl for <strong>one specific match</strong>. Test it works with the hardcoded match ID before templating.
          </div>
          <CurlImportBox accentColor={accent} onImport={handleCurlImport} />

          {/* Blueprint for markets — shows RAW and TEMPLATE tabs */}
          {rawUrlLocal && (
            <UrlBlueprint
              rawUrl={rawUrlLocal}
              urlTemplate={storedUrl || undefined}
              accent={accent}
              onUse={displayUrl => {
                // If the user clicks "USE AS TEMPLATE" from the TEMPLATE tab,
                // displayUrl already has {{placeholders}} — populate directly.
                // If from the RAW tab, it has real values — parse and template them.
                const hasPlaceholders = /\{\{.+?\}\}/.test(displayUrl);
                if (hasPlaceholders) {
                  // Already a template — split base from qs and populate
                  const qi = displayUrl.indexOf('?');
                  setUrlInput(displayUrl);
                  if (qi >= 0) {
                    const templateParams = displayUrl.slice(qi + 1).split('&').filter(Boolean).map(part => {
                      const eq = part.indexOf('=');
                      return eq >= 0
                        ? { key: decodeURIComponent(part.slice(0, eq)), value: part.slice(eq + 1) }
                        : { key: decodeURIComponent(part), value: '' };
                    });
                    setParamRows(templateParams);
                  }
                } else {
                  // Raw URL — parse and re-template the values
                  const p = parseCurl(`curl '${displayUrl}'`);
                  setUrlInput(p.urlTemplate || p.url);
                  setParamRows(p.params.map(kv => ({ key: kv.key, value: `{{${kv.key}}}` })));
                }
                setRawResult(null);
              }}
            />
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <select value={methodSel} onChange={e => setMethodSel(e.target.value)} style={{ ...s.mini, flex: '0 0 80px', color: 'var(--cyan)', fontWeight: 700 }}>
              {['GET', 'POST', 'PUT', 'PATCH'].map(m => <option key={m}>{m}</option>)}
            </select>
            <input value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="https://api.bookmaker.com/markets?id=703489210" style={{ ...s.mini, flex: 1 }} />
          </div>
          {headerRows.filter(r => r.key.trim()).length > 0 && <HeadersPanel headers={kvToObj(headerRows)} />}
          <div>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 8 }}>
              {(['params', 'headers'] as const).map(t => <button key={t} onClick={() => setTab(t)} style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? accent : 'transparent'}`, color: tab === t ? accent : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '6px 14px', cursor: 'pointer', marginBottom: -1 }}>{t.toUpperCase()}</button>)}
            </div>
            <KVEditor rows={tab === 'params' ? paramRows : headerRows} onChange={tab === 'params' ? setParamRows : setHeaderRows} />
          </div>
          <div><label style={s.label}>MARKETS ARRAY PATH</label><input value={arrayInput} onChange={e => setArrayInput(e.target.value)} placeholder="e.g. markets (blank = root)" style={s.input} /></div>
          <button onClick={rawTest} disabled={rawLoading || !urlInput.trim()} style={{ ...s.btnAcid, background: accent, padding: '10px 0', width: '100%', fontSize: 9, letterSpacing: 2, opacity: urlInput.trim() ? 1 : .5 }}>
            {rawLoading ? '⟳ TESTING…' : '▶ TEST RAW REQUEST'}
          </button>
          {rawResult && <ProbeResultPanel result={rawResult} accent={accent} />}
          {rawOk && <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', alignSelf: 'center' }}>✓ Raw test passed</span>
            <button onClick={() => setSubStep('wire')} style={{ ...s.btnAcid, fontSize: 9 }}>WIRE VARS →</button>
          </div>}
        </div>
      )}

      {/* ── B: Wire Vars ── */}
      {subStep === 'wire' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ padding: '8px 12px', background: `${accent}08`, border: `1px solid ${accent}22`, fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, lineHeight: 1.6 }}>
            Replace the concrete match ID with <code style={{ background: `${accent}18`, padding: '0 4px' }}>{'{{match_id}}'}</code> then map it to the field from the list.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="URL with {{match_id}}" style={{ ...s.mini, flex: 1, borderColor: vars.length ? `${accent}44` : undefined }} />
            <button onClick={detectPlaceholders} disabled={detecting || !urlInput.trim()} style={{ ...s.btnCyan, fontSize: 8 }}>{detecting ? '⟳ DETECTING…' : '⚡ AUTO-DETECT'}</button>
          </div>
          {vars.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
              {vars.map(v => { const linked = !!phMap[v]; return (
                <span key={v} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '2px 8px', background: linked ? 'rgba(198,241,53,.08)' : 'rgba(251,146,60,.08)', border: `1px solid ${linked ? 'rgba(198,241,53,.35)' : 'rgba(251,146,60,.35)'}`, color: linked ? 'var(--acid)' : '#fb923c' }}>
                  {`{{${v}}}`}{linked ? <span style={{ opacity: .6, marginLeft: 5 }}>← {phMap[v]}</span> : <span style={{ marginLeft: 5 }}>⚠ unlinked</span>}
                </span>
              ); })}
            </div>
          )}
          {vars.length > 0 && (
            <div style={{ border: `1px solid ${accent}33`, background: `${accent}05` }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${accent}22`, fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: accent }}>WIRE PLACEHOLDER → LIST FIELD PATH</div>
              <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {vars.map(v => (
                  <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: accent, width: 140, flexShrink: 0 }}>{`{{${v}}}`}</span>
                    <select value={phMap[v] || ''} onChange={e => setPhMap(prev => ({ ...prev, [v]: e.target.value }))} style={{ ...s.mini, flex: 1 }}>
                      <option value="">— pick list field path —</option>
                      {Object.entries(listFieldMap).map(([role, path]) => <option key={role} value={path}>{role} → {path}</option>)}
                    </select>
                    {!phMap[v] && <input placeholder="or type path" style={{ ...s.mini, width: 160, flexShrink: 0 }}
                      onBlur={e => { const v2 = e.target.value.trim(); if (v2) setPhMap(prev => ({ ...prev, [v]: v2 })); }}
                      onKeyDown={e => { if (e.key === 'Enter') { const v2 = (e.target as HTMLInputElement).value.trim(); if (v2) setPhMap(prev => ({ ...prev, [v]: v2 })); } }} />}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div><label style={s.label}>{'PARAMS (add {{var}} values if needed)'}</label><KVEditor rows={paramRows} onChange={setParamRows} /></div>
          {vars.length > 0 && Object.keys(phMap).length > 0 && (() => {
            const rawSample = (session as any)[`${listPrefix}_sample`];
            if (!rawSample) return <div style={{ padding: '6px 10px', background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.2)', fontFamily: 'var(--font-mono)', fontSize: 8, color: '#fb923c' }}>⚠ No list sample cached yet — probe the List phase first</div>;
            try {
              const first = JSON.parse(rawSample)?.[0]; if (!first) return null;
              let preview = urlInput;
              vars.forEach(v => { const path = phMap[v]; const val = path ? String(getNestedValue(first, path) ?? '?') : '?'; preview = preview.replace(new RegExp(`\\{\\{${v}\\}\\}`, 'g'), val); });
              return <div style={{ padding: '6px 10px', background: 'var(--bg-base)', border: `1px solid ${accent}33`, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', wordBreak: 'break-all' as const }}>
                <span style={{ color: accent, marginRight: 6, letterSpacing: 1 }}>PREVIEW →</span>{preview}
              </div>;
            } catch { return null; }
          })()}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {vars.length > 0 && Object.keys(phMap).length >= vars.length && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', alignSelf: 'center' }}>✓ All vars wired</span>}
            <button onClick={() => setSubStep('iterate')} style={{ ...s.btnAcid, fontSize: 9 }}>{vars.length === 0 ? 'NO VARS → ' : ''}ITERATE MATCHES →</button>
          </div>
        </div>
      )}

      {/* ── C: Iterate ── */}
      {subStep === 'iterate' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ padding: '8px 12px', background: `${accent}08`, border: `1px solid ${accent}22`, fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, lineHeight: 1.6 }}>
            Loads from the cached list (no new request). Verify the resolved URL looks right then click PROBE.
          </div>
          <div style={{ padding: '7px 10px', background: 'var(--bg-elevated)', border: `1px solid ${accent}22`, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', wordBreak: 'break-all' as const }}>
            <span style={{ color: accent, marginRight: 6, letterSpacing: 1, fontWeight: 700 }}>TEMPLATE:</span>
            {urlRef.current || <span style={{ color: 'var(--red)' }}>⚠ No template — go back to step A</span>}
          </div>
          {Object.keys(phMapRef.current).length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
              {Object.entries(phMapRef.current).map(([v, path]) => (
                <span key={v} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 8px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.2)', color: 'var(--acid)' }}>
                  {`{{${v}}}`} ← {path}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <button onClick={loadMatchesFromCache} style={{ ...s.btnCyan, fontSize: 8 }}>↓ LOAD FROM CACHE</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>reads {listPrefix}_sample — no network request</span>
            {matchItems.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', marginLeft: 'auto' }}>{matchItems.length} matches ready</span>}
          </div>
          {cacheInfo && <div style={{ padding: '5px 10px', background: 'rgba(255,255,255,.03)', border: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 8, color: cacheInfo.startsWith('✓') ? 'var(--acid)' : cacheInfo.startsWith('⚠') ? '#fb923c' : 'var(--red)' }}>{cacheInfo}</div>}
          {matchItems.length > 0 && (() => {
            try {
              const { url, params } = resolveItem(matchItems[0]);
              const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
              return <div style={{ padding: '7px 10px', background: 'var(--bg-base)', border: '1px solid rgba(198,241,53,.2)', fontFamily: 'var(--font-mono)', fontSize: 8, wordBreak: 'break-all' as const }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 6, letterSpacing: 1 }}>FIRST ITEM RESOLVES TO →</span>
                <span style={{ color: 'var(--acid)' }}>{url}{qs}</span>
              </div>;
            } catch { return null; }
          })()}
          {matchItems.length > 0 && <InlineStepIterator key={iterKey} title="MARKET ITERATION" accent={accent} items={matchItems} buildRequest={buildMarketRequest} onAccepted={handleAccepted} onComplete={handleIterComplete} sessionId={session.id} />}
          {firstItem && <div>
            <label style={s.label}>MARKETS FIELD MAPPINGS</label>
            <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-base)' }}>
              <FieldMapEditor fieldMap={storedFm} firstItem={firstItem} onChange={fm => onUpdate({ [`${prefix}_field_map`]: fm })} />
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPORTS Phase ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface SportIterResult { bk_sport_id: string; list_ok: boolean; list_count: number; live_list_ok: boolean; live_count: number; markets_ok: boolean; markets_count: number }

function SportsPhase({ session, onUpdate, onToast }: { session: OnboardingSession; onUpdate: (p: any) => Promise<void>; onToast: (m: string) => void }) {
  const mappings = session.sport_mappings || [];
  const [cursor, setCursor] = useState(0);
  const [results, setResults] = useState<Record<string, SportIterResult>>({});
  const [probing, setProbing] = useState<'list' | 'live' | 'markets' | null>(null);
  const [listResult, setListResult] = useState<any>(null);
  const [liveResult, setLiveResult] = useState<any>(null);
  const [matchItems, setMatchItems] = useState<IterItem[]>([]);
  const [iterKey, setIterKey] = useState(0);
  const [viewPhase, setViewPhase] = useState<'list' | 'markets'>('list');
  const sm = mappings[cursor];
  const hasLive = !!session.live_list_url, hasMarkets = !!session.markets_url_template;
  const dict = (obj: Record<string, string> | null | undefined): Record<string, string> => ({ ...(obj || {}) });

  const probeList = async (live = false) => {
    if (!sm) return; setProbing(live ? 'live' : 'list');
    const url     = live ? session.live_list_url    : session.list_url;
    const m       = live ? session.live_list_method : session.list_method;
    const h       = live ? session.live_list_headers : session.list_headers;
    const p       = dict(live ? session.live_list_params : session.list_params);
    const arr     = live ? session.live_list_array_path : session.list_array_path;
    const urlRaw  = live ? session.live_list_url_raw : session.list_url_raw;  // ← blueprint
    if (sm.param_in === 'query') p[sm.param_key] = sm.bk_sport_id;
    const res = await api(`/sessions/${session.id}/probe`, {
      method: 'POST',
      body: JSON.stringify({
        url, method: m || 'GET', headers: h || {}, params: p, body: null,
        url_raw: urlRaw || '',   // ← pass through for param order
      }),
    });
    if (live) setLiveResult(res); else setListResult(res);
    if (res.ok) {
      const items = arr ? (getNestedValue(res.parsed, arr) as any[] || []) : (Array.isArray(res.parsed) ? res.parsed : Object.values(res.parsed || {}).find(Array.isArray) as any[] || []);
      const fm = (live ? session.live_list_field_map : session.list_field_map) || {};
      const mip = fm['match_id'] || 'id', hp = fm['home_team'] || '', ap = fm['away_team'] || '';
      const built: IterItem[] = items.slice(0, 10).map((item, idx) => {
        const mid = getNestedValue(item, mip) ?? idx;
        return { id: String(mid), label: (hp && ap) ? `${String(getNestedValue(item, hp) || '')} v ${String(getNestedValue(item, ap) || '')}` : `Match ${mid}`, meta: { ...item, _live: live } };
      });
      if (!live) { setMatchItems(built); setIterKey(k => k + 1); }
      onToast(`✓ ${live ? 'Live' : 'Upcoming'} list for sport ${sm.bk_sport_id}: ${items.length} matches`);
    } else onToast(`✗ ${live ? 'Live ' : ''}List failed: ${res.error}`);
    setProbing(null);
  };

  const buildMarketReq = useCallback((item: IterItem) => {
    const live    = (item.meta as any)?._live;
    const tmpl    = live ? session.live_markets_url_template : session.markets_url_template;
    const mth     = live ? session.live_markets_method       : session.markets_method;
    const hdr     = live ? session.live_markets_headers      : session.markets_headers;
    const prm     = dict(live ? session.live_markets_params  : session.markets_params);
    const phm     = (live ? session.live_markets_placeholder_map : session.markets_placeholder_map) || {};
    const urlRaw  = live ? session.live_markets_url_raw      : session.markets_url_raw;  // ← blueprint
    let resolvedUrl = tmpl || '';
    let resolvedRaw = urlRaw || '';   // also resolve placeholders in the raw URL
    const vars = [...new Set([...(tmpl?.matchAll(/\{\{(\w+)\}\}/g) || [])].map(m => m[1]))];
    vars.forEach(varName => {
      const path  = phm[varName];
      const value = path ? String(getNestedValue(item.meta, path) ?? item.id) : String(item.id);
      resolvedUrl = resolvedUrl.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value);
      resolvedRaw = resolvedRaw.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value);
      Object.keys(prm).forEach(pk => { prm[pk] = prm[pk].replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value); });
    });
    return { url: resolvedUrl, method: mth || 'GET', headers: hdr || {}, params: prm,
             url_raw: resolvedRaw };  // ← passed to API fetch
  }, [session]);

  const acceptSport = async (_item: IterItem | null, mktsOk: boolean) => {
    if (!sm) return;
    const updated = mappings.map((m, i) => i === cursor ? { ...m, status: 'ok' as const, item_count: listResult?.array_length ?? 0 } : m);
    setResults(prev => ({ ...prev, [sm.bk_sport_id]: { bk_sport_id: sm.bk_sport_id, list_ok: listResult?.ok ?? false, list_count: listResult?.array_length ?? 0, live_list_ok: liveResult?.ok ?? false, live_count: liveResult?.array_length ?? 0, markets_ok: mktsOk, markets_count: 0 } }));
    await onUpdate({ sport_mappings: updated });
    if (cursor < mappings.length - 1) { setCursor(c => c + 1); setListResult(null); setLiveResult(null); setMatchItems([]); }
    else onToast(`✓ All ${mappings.length} sports done`);
  };

  if (!mappings.length) return <div style={{ padding: '32px 0', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>No sport mappings — configure them in the LIST phase first</div>;
  if (!session.list_ok) return <div style={{ padding: '24px', background: 'rgba(251,146,60,.04)', border: '1px solid rgba(251,146,60,.2)', fontFamily: 'var(--font-mono)', fontSize: 9, color: '#fb923c' }}>⚠ Complete the LIST and MARKETS phases first</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ padding: '8px 12px', background: 'rgba(198,241,53,.04)', border: '1px solid rgba(198,241,53,.2)', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)', lineHeight: 1.6 }}>
        For each sport: probe the list (upcoming{hasLive ? ' + live' : ''}), then iterate markets. Accept or skip each sport.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 0, border: '1px solid var(--border-dim)' }}>
        <div style={{ borderRight: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', overflowY: 'auto', maxHeight: 600 }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)' }}>SPORTS ({mappings.length})</div>
          {mappings.map((m, i) => { const r = results[m.bk_sport_id]; const isCur = i === cursor; const color = r?.list_ok ? 'var(--acid)' : isCur ? 'var(--cyan)' : 'var(--text-muted)'; return (
            <div key={i} onClick={() => setCursor(i)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: isCur ? 'rgba(6,182,212,.08)' : 'transparent', borderLeft: `3px solid ${isCur ? 'var(--cyan)' : 'transparent'}`, borderBottom: '1px solid var(--border-dim)', cursor: 'pointer' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{m.sport_name || m.bk_sport_id}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{m.bk_sport_id}</div>
              </div>
            </div>
          ); })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 700 }}>{sm?.sport_name || sm?.bk_sport_id}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <span style={pill(false)}>SPORT ID: {sm?.bk_sport_id}</span>
                <span style={pill(false)}>PARAM: {sm?.param_key} ({sm?.param_in})</span>
                {sm?.sport_id && <span style={pill(true)}>→ {sm.sport_name}</span>}
              </div>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{cursor + 1}/{mappings.length}</span>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', padding: '0 14px' }}>
            {(['list', 'markets'] as const).map(p => <button key={p} onClick={() => setViewPhase(p)} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, padding: '6px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${viewPhase === p ? 'var(--acid)' : 'transparent'}`, marginBottom: -1, color: viewPhase === p ? 'var(--acid)' : 'var(--text-muted)', cursor: 'pointer' }}>{p === 'list' ? `LIST${hasLive ? ' + LIVE' : ''}` : hasMarkets ? 'MARKETS' : 'MARKETS (not configured)'}</button>)}
          </div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {viewPhase === 'list' && <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                <button onClick={() => probeList(false)} disabled={probing === 'list'} style={{ ...s.btnAcid, fontSize: 9 }}>{probing === 'list' ? '⟳ PROBING…' : '▶ PROBE UPCOMING LIST'}</button>
                {hasLive && <button onClick={() => probeList(true)} disabled={probing === 'live'} style={{ ...s.btnCyan, fontSize: 9 }}>{probing === 'live' ? '⟳ PROBING…' : '▶ PROBE LIVE LIST'}</button>}
              </div>
              {listResult && <div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 }}>UPCOMING LIST</div><ProbeResultPanel result={listResult} accent="var(--acid)" /></div>}
              {hasLive && liveResult && <div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 }}>LIVE LIST</div><ProbeResultPanel result={liveResult} accent="var(--cyan)" /></div>}
              {listResult?.ok && <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button onClick={() => setViewPhase('markets')} style={{ ...s.btnAcid, fontSize: 9 }}>→ TEST MARKETS</button></div>}
            </>}
            {viewPhase === 'markets' && <>
              {!hasMarkets && <div style={{ padding: '16px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', textAlign: 'center' as const }}>Markets endpoint not configured — complete the MARKETS phase first</div>}
              {hasMarkets && <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => probeList(false)} disabled={!!probing} style={{ ...s.btnCyan, fontSize: 8 }}>{probing ? '⟳ REFRESHING…' : '↻ REFRESH MATCH LIST'}</button>
                  {matchItems.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)' }}>{matchItems.length} matches loaded</span>}
                </div>
                {matchItems.length > 0 && <InlineStepIterator key={`${iterKey}-${sm?.bk_sport_id}`} title={`MARKETS — ${sm?.sport_name || sm?.bk_sport_id}`} accent="#38bdf8" items={matchItems} buildRequest={buildMarketReq} onComplete={accepted => acceptSport(null, accepted.length > 0)} sessionId={session.id} />}
                {matchItems.length === 0 && <div style={{ padding: '24px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>Probe the list first to load matches</div>}
              </>}
            </>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border-dim)' }}>
              <button onClick={() => acceptSport(null, false)} style={{ ...s.btnGhost, fontSize: 8 }}>SKIP THIS SPORT →</button>
              <button onClick={() => acceptSport(null, listResult?.ok ?? false)} style={{ ...s.btnAcid, fontSize: 9 }}>✓ ACCEPT SPORT & {cursor < mappings.length - 1 ? 'NEXT →' : 'FINISH'}</button>
            </div>
          </div>
        </div>
      </div>
      {Object.keys(results).length > 0 && <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-surface)' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' }}>RESULTS SO FAR</div>
        {Object.values(results).map(r => (
          <div key={r.bk_sport_id} style={{ display: 'flex', gap: 10, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,.04)', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: r.list_ok ? 'var(--acid)' : 'var(--red)', width: 16 }}>{r.list_ok ? '✓' : '✗'}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)', flex: 1 }}>{r.bk_sport_id}</span>
            {r.list_ok && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(198,241,53,.6)' }}>{r.list_count} upcoming</span>}
            {r.live_list_ok && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(6,182,212,.6)' }}>{r.live_count} live</span>}
            {r.markets_ok && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(56,189,248,.7)' }}>✓ markets</span>}
          </div>
        ))}
      </div>}
    </div>
  );
}

// ─── ReviewPhase ──────────────────────────────────────────────────────────────

function ReviewPhase({ session, onSave, saving }: { session: OnboardingSession; onSave: () => Promise<void>; saving: boolean }) {
  const phases = [
    { label: 'Upcoming List', ok: session.list_ok, url: session.list_url, method: session.list_method },
    { label: 'Markets', ok: session.markets_ok, url: session.markets_url_template, method: session.markets_method },
    { label: 'Live List', ok: session.live_list_ok, url: session.live_list_url, method: session.live_list_method },
    { label: 'Live Markets', ok: session.live_markets_ok, url: session.live_markets_url_template, method: session.live_markets_method },
  ];
  const readyToSave = session.list_ok;
  const completedCount = phases.filter(p => p.ok).length;
  const sportsOk = (session.sport_mappings || []).filter(s => s.status === 'ok').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {session.is_complete && session.workflow_ids && <div style={{ padding: '14px 18px', background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.3)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--acid)', letterSpacing: 2 }}>✓ ONBOARDING COMPLETE</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)' }}>Upcoming: #{session.workflow_ids.upcoming} · {session.workflow_ids.live ? `Live: #${session.workflow_ids.live}` : 'No live workflow'}</span>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {phases.map((p, i) => (
          <div key={i} style={{ padding: '12px 14px', background: p.ok ? 'rgba(198,241,53,.04)' : 'rgba(255,255,255,.02)', border: `1px solid ${p.ok ? 'rgba(198,241,53,.2)' : 'var(--border-dim)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: p.ok ? 'var(--acid)' : 'var(--text-muted)' }}>{p.ok ? '✓' : '○'}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: p.ok ? 'var(--acid)' : 'var(--text-muted)', letterSpacing: 1 }}>{p.label}</span></div>
            {p.url ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', wordBreak: 'break-all' as const, opacity: .8 }}><span style={{ color: 'var(--cyan)', marginRight: 5 }}>{p.method}</span>{p.url.length > 60 ? p.url.slice(0, 60) + '…' : p.url}</div> : <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', fontStyle: 'italic' }}>not configured</div>}
          </div>
        ))}
      </div>
      <div>
        <label style={s.label}>SPORT MAPPINGS — {sportsOk}/{(session.sport_mappings || []).length} verified</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
          {(session.sport_mappings || []).map((sm, i) => <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '3px 10px', background: sm.sport_id ? 'rgba(198,241,53,.08)' : 'rgba(251,146,60,.06)', border: `1px solid ${sm.sport_id ? 'rgba(198,241,53,.3)' : 'rgba(251,146,60,.3)'}`, color: sm.sport_id ? 'var(--acid)' : '#fb923c' }}>bk:{sm.bk_sport_id} → {sm.sport_name || (sm.sport_id ? `Sport #${sm.sport_id}` : '?')}{sm.status === 'ok' && <span style={{ marginLeft: 5, opacity: .6 }}>✓ {sm.item_count}</span>}</span>)}
        </div>
      </div>
      {Object.keys(session.list_headers || {}).some(k => AUTH_RE.test(k)) && <div style={{ padding: '8px 12px', background: 'rgba(251,146,60,.04)', border: '1px solid rgba(251,146,60,.2)', fontFamily: 'var(--font-mono)', fontSize: 8, color: '#fb923c' }}>🔑 Auth tokens detected — stored in endpoint config</div>}
      <div style={{ padding: '14px 0', borderTop: '2px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: readyToSave ? 'var(--acid)' : 'var(--text-muted)', letterSpacing: 1 }}>{readyToSave ? `✓ ${completedCount}/4 PHASES + ${sportsOk} SPORTS — READY TO SAVE` : '✗ List phase required'}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', marginTop: 3 }}>Saves: HarvestWorkflow{session.live_list_ok ? ' + Live' : ''} · BookmakerEndpoints · Sport entity values</div>
        </div>
        <button onClick={onSave} disabled={!readyToSave || saving || session.is_complete} style={{ ...s.btnAcid, padding: '12px 28px', fontSize: 10, letterSpacing: 2, opacity: (readyToSave && !saving && !session.is_complete) ? 1 : .4 }}>{saving ? '⟳ SAVING…' : session.is_complete ? '✓ SAVED' : '✓ SAVE BOOKMAKER'}</button>
      </div>
    </div>
  );
}

// ─── PhaseStepper ─────────────────────────────────────────────────────────────

function PhaseStepper({ current, session, onChange }: { current: Phase; session: OnboardingSession; onChange: (p: Phase) => void }) {
  const ok: Record<Phase, boolean> = { LIST: session.list_ok, MARKETS: session.markets_ok, LIVE_LIST: session.live_list_ok, LIVE_MARKETS: session.live_markets_ok, SPORTS: (session.sport_mappings || []).some(s => s.status === 'ok'), REVIEW: session.is_complete };
  return (
    <div style={{ display: 'flex', borderBottom: '2px solid var(--border-dim)', background: 'var(--bg-elevated)', overflowX: 'auto' }}>
      {PHASES.map((phase, i) => { const isActive = phase === current; const isDone = ok[phase]; const color = isDone ? 'var(--acid)' : isActive ? 'var(--cyan)' : 'var(--text-muted)'; return (
        <button key={phase} onClick={() => onChange(phase)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', background: isActive ? 'var(--bg-surface)' : 'transparent', border: 'none', borderBottom: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`, marginBottom: -2, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isDone ? 'var(--acid)' : isActive ? 'rgba(6,182,212,.15)' : 'rgba(255,255,255,.06)', border: `1px solid ${color}`, fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 800, color: isDone ? '#0a0a0a' : color, flexShrink: 0 }}>{isDone ? '✓' : i + 1}</div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, color }}>{PHASE_LABELS[phase]}</span>
        </button>
      ); })}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BookmakerOnboarding({ bookmakers, sports }: { bookmakers: BookmakerOption[]; sports: SportOption[] }) {
  const [selectedBk, setSelectedBk] = useState<number | null>(null);
  const [session,    setSession]    = useState<OnboardingSession | null>(null);
  const [phase,      setPhase]      = useState<Phase>('LIST');
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [toast,      setToast]      = useState('');

  const loadSession = useCallback(async (bkId: number) => {
    setLoading(true);
    try {
      const res = await api(`/bookmakers/${bkId}/session`);
      if (res.ok) { setSession(res.session); const p = res.session.current_phase === 'COMPLETE' ? 'REVIEW' : (res.session.current_phase as Phase || 'LIST'); setPhase(p); }
      else { const c = await api('/sessions', { method: 'POST', body: JSON.stringify({ bookmaker_id: bkId }) }); if (c.ok) { setSession(c.session); setPhase('LIST'); } }
    } catch (e: any) { setToast(`✗ ${e.message}`); }
    setLoading(false);
  }, []);

  useEffect(() => { if (selectedBk) loadSession(selectedBk); else setSession(null); }, [selectedBk, loadSession]);

  const update = useCallback(async (patch: any) => {
    if (!session) return;
    const res = await api(`/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if (res.ok) setSession(res.session);
  }, [session]);

  const save = async () => {
    if (!session) return; setSaving(true);
    try {
      const res = await api(`/sessions/${session.id}/complete`, { method: 'POST' });
      if (res.ok) { setSession(res.session); setPhase('REVIEW'); setToast('✓ Bookmaker onboarded!'); }
      else { setToast(`✗ ${res.error ?? 'Save failed'}`); }
    } catch (e: any) { setToast(`✗ ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <Toast msg={toast} onClear={() => setToast('')} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, letterSpacing: 3, margin: 0, color: 'var(--acid)' }}>BOOKMAKER ONBOARDING</h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>CONFIGURE · TEST · WIRE · ITERATE · SAVE</p>
        </div>
        <a href="/dashboard/research" style={{ ...s.btnGhost, textDecoration: 'none', display: 'inline-block' }}>RESEARCH →</a>
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'flex-end' }}>
          <div>
            <label style={s.label}>BOOKMAKER</label>
            <select value={selectedBk ?? ''} onChange={e => setSelectedBk(e.target.value ? Number(e.target.value) : null)} style={s.input}>
              <option value="">— select bookmaker —</option>
              {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name} {b.domain ? `(${b.domain})` : ''}</option>)}
            </select>
          </div>
          {session && <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => loadSession(selectedBk!)} style={s.btnGhost}>↻ RELOAD</button>
            <button onClick={async () => { if (!confirm('Reset session?')) return; await api(`/sessions/${session.id}`, { method: 'DELETE' }); await loadSession(selectedBk!); }} style={{ ...s.btnGhost, borderColor: 'rgba(255,61,90,.3)', color: 'rgba(255,61,90,.6)' }}>✕ RESET</button>
          </div>}
        </div>
        {session && <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-dim)', flexWrap: 'wrap' as const }}>
          {(['list', 'markets', 'live_list', 'live_markets'] as const).map(p => { const ok = (session as any)[`${p}_ok`]; return <span key={p} style={pill(ok)}>{ok ? '✓' : '○'} {p.toUpperCase().replace('_', ' ')}</span>; })}
          <span style={pill((session.sport_mappings || []).some(s => s.status === 'ok'))}>○ {(session.sport_mappings || []).filter(s => s.status === 'ok').length}/{(session.sport_mappings || []).length} SPORTS</span>
        </div>}
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--acid)', letterSpacing: 4 }}>LOADING…</span></div>}
      {!loading && !selectedBk && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 0', gap: 12 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 4, color: 'var(--text-muted)' }}>SELECT A BOOKMAKER TO BEGIN</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', opacity: .5 }}>Configure API endpoints, sport IDs, and field mappings</div>
      </div>}

      {!loading && selectedBk && session && (
        <div style={{ border: '1px solid var(--border-dim)', background: 'var(--bg-surface)' }}>
          <PhaseStepper current={phase} session={session} onChange={setPhase} />
          <div style={{ padding: '18px 20px' }}>
            {phase === 'LIST'         && <ListPhase    session={session} phase="LIST"          sports={sports} onUpdate={update} onToast={setToast} />}
            {phase === 'MARKETS'      && <MarketsPhase session={session} phase="MARKETS"                       onUpdate={update} onToast={setToast} />}
            {phase === 'LIVE_LIST'    && <ListPhase    session={session} phase="LIVE_LIST"     sports={sports} onUpdate={update} onToast={setToast} />}
            {phase === 'LIVE_MARKETS' && <MarketsPhase session={session} phase="LIVE_MARKETS"                  onUpdate={update} onToast={setToast} />}
            {phase === 'SPORTS'       && <SportsPhase  session={session}                                       onUpdate={update} onToast={setToast} />}
            {phase === 'REVIEW'       && <ReviewPhase  session={session} onSave={save}         saving={saving} />}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border-dim)', background: 'var(--bg-elevated)' }}>
            <button onClick={() => { const i = PHASES.indexOf(phase); if (i > 0) setPhase(PHASES[i - 1]); }} disabled={phase === 'LIST'} style={{ ...s.btnGhost, opacity: phase === 'LIST' ? .3 : 1 }}>← PREV</button>
            <button onClick={() => { const i = PHASES.indexOf(phase); if (i < PHASES.length - 1) setPhase(PHASES[i + 1]); }} disabled={phase === 'REVIEW'} style={{ ...s.btnAcid, opacity: phase === 'REVIEW' ? .3 : 1 }}>NEXT →</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        textarea:focus, input:focus, select:focus { outline: none; border-color: rgba(198,241,53,.4) !important; }
        select option { background: var(--bg-elevated, #0c150c); color: var(--text-primary, #e2e8f0); }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}