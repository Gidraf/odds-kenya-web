/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

/**
 * EndpointResearch  —  /dashboard/research
 * ==========================================
 * Step 1: Build match-list request + optional markets request.
 * Step 2: 4-stage AI generation pipeline with live contract validation.
 *
 * Stage 1: AI generates parse_match_list  → validated independently
 * Stage 2: AI generates parse_markets     → validated independently
 * Stage 3: AI combines both into parse_data(match_list_raw, markets_raw)
 * Stage 4: Combined function executed + every output row checked against
 *          agent contract (REQUIRED_PARSER_KEYS)
 *
 * Contract errors are shown inline in the editor columns.
 * APPROVE & SAVE is blocked until all 4 stages pass.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookmakerOption { id: number; name: string; domain: string }
interface SportOption     { id: number; name: string; slug?: string }
interface KV              { key: string; value: string }

interface ProbeResult {
  ok:            boolean;
  status:        number | null;
  response_raw:  string;
  response_json: any;
  content_type:  string;
  size_bytes:    number;
  latency_ms:    number;
  curl:          string;
  error:         string | null;
}

interface EndpointConfig {
  url:         string;
  method:      string;
  headers:     KV[];
  params:      KV[];
  body:        string;
  probeResult: ProbeResult | null;
}

// Contract validation state for a single parser
interface ContractState {
  passed:  boolean | null;   // null = not yet checked
  errors:  string[];
  rows:    number;
}

const emptyContract = (): ContractState => ({ passed: null, errors: [], rows: 0 });

// 4-stage pipeline state
interface StageState {
  status:  'idle' | 'running' | 'passed' | 'failed';
  label:   string;
  rows?:   number;
  errors?: string[];
}

const STAGE_LABELS = [
  'Generate parse_match_list',
  'Generate parse_markets',
  'Combine → parse_data(ml, mk)',
  'Validate combined output',
];

// SSE stream event shapes
interface SseStatusEvent  { type: 'status';       message: string; step: number; total: number }
interface SseUploadStart  { type: 'upload_start'; label: string; size_kb: number; message: string }
interface SseUploadDone   { type: 'upload_done';  label: string; upload_ms?: number; fallback?: boolean; message: string }
interface SseContextInfo  {
  type: 'context_info';
  ml_tier: number; mk_tier: number;
  ml_strategy: string; mk_strategy: string;
  ml_size_kb: number; mk_size_kb: number;
}
interface SseMlCodeEvent  { type: 'ml_code'; code: string; rows: any[]; error: string | null; tier: number; strategy: string }
interface SseMkCodeEvent  { type: 'mk_code'; code: string; rows: any[]; error: string | null; tier: number; strategy: string }
interface SseResultEvent  {
  type: 'result';
  match_list_rows:  any[];
  markets_rows:     any[];
  grouped:          any[];
  grouped_raw:      string;
  match_list_error: string | null;
  markets_error:    string | null;
  model_used:       string;
  ml_tier:          number;
  mk_tier:          number;
  ml_strategy:      string;
  mk_strategy:      string;
  warnings:         string[];
}
interface SseErrorEvent   { type: 'error'; message: string }
interface SseDoneEvent    { type: 'done' }
type SseEvent =
  | SseStatusEvent | SseUploadStart | SseUploadDone | SseContextInfo
  | SseMlCodeEvent | SseMkCodeEvent | SseResultEvent | SseErrorEvent | SseDoneEvent;

interface UploadState {
  active: boolean; done: boolean; fallback: boolean;
  size_kb: number; upload_ms: number | null; message: string;
}
const emptyUpload = (): UploadState => ({ active: false, done: false, fallback: false, size_kb: 0, upload_ms: null, message: '' });

type Step = 1 | 2;

// ─── cURL parser ──────────────────────────────────────────────────────────────

function parseCurl(raw: string): Omit<EndpointConfig, 'probeResult'> {
  const cmd = raw.replace(/\\\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === ' ') { i++; continue; }
    if (cmd[i] === "'") { const end = cmd.indexOf("'", i + 1); tokens.push(end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end)); i = end === -1 ? cmd.length : end + 1; }
    else if (cmd[i] === '"') { const end = cmd.indexOf('"', i + 1); tokens.push(end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end)); i = end === -1 ? cmd.length : end + 1; }
    else { const sp = cmd.indexOf(' ', i); tokens.push(sp === -1 ? cmd.slice(i) : cmd.slice(i, sp)); i = sp === -1 ? cmd.length : sp; }
  }
  let url = '', method = 'GET', body = '';
  const rawHeaders: KV[] = [];
  let t = 0;
  if (tokens[0]?.toLowerCase() === 'curl') t = 1;
  while (t < tokens.length) {
    const tok = tokens[t];
    if (tok === '-X' || tok === '--request') { method = (tokens[++t] ?? 'GET').toUpperCase(); }
    else if (tok === '-H' || tok === '--header') { const hdr = tokens[++t] ?? ''; const col = hdr.indexOf(':'); if (col !== -1) rawHeaders.push({ key: hdr.slice(0, col).trim(), value: hdr.slice(col + 1).trim() }); }
    else if (['-d', '--data', '--data-raw', '--data-binary'].includes(tok)) { body = tokens[++t] ?? ''; if (method === 'GET') method = 'POST'; }
    else if (['--compressed', '-L', '--location', '-s', '--silent', '-i', '-v', '-k', '--insecure'].includes(tok)) { /* no-arg */ }
    else if (tok === '--url') { url = tokens[++t] ?? ''; }
    else if (['-m', '--max-time', '-o', '--output', '-A', '--user-agent', '-x', '--proxy', '-b', '--cookie', '-u', '--user'].includes(tok)) { t++; }
    else if (!tok.startsWith('-') && !url) { url = tok; }
    t++;
  }
  let cleanUrl = url;
  const parsedParams: KV[] = [];
  try { const u = new URL(url); u.searchParams.forEach((v, k) => parsedParams.push({ key: k, value: v })); u.search = ''; cleanUrl = u.toString(); } catch { /* keep */ }
  return { url: cleanUrl, method, headers: rawHeaders.length > 0 ? rawHeaders : [{ key: '', value: '' }], params: parsedParams.length > 0 ? parsedParams : [{ key: '', value: '' }], body };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const kvToObj = (pairs: KV[]): Record<string, string> =>
  Object.fromEntries(pairs.filter(p => p.key.trim()).map(p => [p.key.trim(), p.value]));
const fmtKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// ─── SSE reader ───────────────────────────────────────────────────────────────

async function* readSseStream(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { yield JSON.parse(line.slice(6)) as SseEvent; } catch { /* malformed */ }
      }
    }
  } finally { reader.releaseLock(); }
}

// ─── Contract badge ───────────────────────────────────────────────────────────

function ContractBadge({ contract, label }: { contract: ContractState; label?: string }) {
  if (contract.passed === null) return null;
  const ok = contract.passed;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
      padding: '2px 8px',
      background: ok ? 'rgba(198,241,53,.1)' : 'rgba(255,61,90,.1)',
      border: `1px solid ${ok ? 'rgba(198,241,53,.5)' : 'rgba(255,61,90,.5)'}`,
      color: ok ? 'var(--acid)' : 'var(--red)',
    }}>
      {ok ? '✓ CONTRACT' : '✗ CONTRACT'}
      {ok && contract.rows > 0 && <span style={{ opacity: .6 }}>{contract.rows} rows</span>}
      {label && <span style={{ opacity: .5 }}>{label}</span>}
    </span>
  );
}

// ─── Contract error panel ─────────────────────────────────────────────────────

function ContractErrors({ errors, title }: { errors: string[]; title: string }) {
  if (!errors.length) return null;
  return (
    <div style={{
      background: 'rgba(255,61,90,.04)', border: '1px solid rgba(255,61,90,.25)',
      padding: '8px 12px', marginTop: 4,
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'rgba(255,61,90,.7)', marginBottom: 5 }}>
        ✗ {title}
      </div>
      {errors.slice(0, 6).map((e, i) => (
        <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)', lineHeight: 1.7, paddingLeft: 8, borderLeft: '2px solid rgba(255,61,90,.3)', marginBottom: 2 }}>
          {e}
        </div>
      ))}
      {errors.length > 6 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 4 }}>
          +{errors.length - 6} more errors
        </div>
      )}
    </div>
  );
}

// ─── Stage pipeline panel ─────────────────────────────────────────────────────

function StagePipeline({ stages }: { stages: StageState[] }) {
  const anyActive = stages.some(s => s.status === 'running' || s.status === 'passed' || s.status === 'failed');
  if (!anyActive) return null;

  const statusColor = (s: StageState['status']) => ({
    idle:    'var(--text-muted)',
    running: 'rgba(251,146,60,.9)',
    passed:  'var(--acid)',
    failed:  'var(--red)',
  }[s]);

  const statusIcon = (s: StageState['status']) => ({
    idle:    '○',
    running: '⟳',
    passed:  '✓',
    failed:  '✗',
  }[s]);

  return (
    <div style={{
      background: 'rgba(10,10,10,.6)',
      border: '1px solid var(--border-dim)',
      padding: '10px 14px',
      marginBottom: 6,
      display: 'flex', flexDirection: 'column', gap: 0,
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 8 }}>
        GENERATION PIPELINE
      </div>
      {stages.map((stage, idx) => {
        const c = statusColor(stage.status);
        return (
          <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: idx < stages.length - 1 ? 6 : 0 }}>
            {/* connector line */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0 }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, color: c, lineHeight: 1,
                animation: stage.status === 'running' ? 'spin .8s linear infinite' : 'none',
              }}>{statusIcon(stage.status)}</span>
              {idx < stages.length - 1 && (
                <div style={{ width: 1, flex: 1, minHeight: 10, background: stage.status === 'passed' ? 'rgba(198,241,53,.3)' : 'var(--border-dim)', marginTop: 2 }} />
              )}
            </div>
            <div style={{ flex: 1, paddingBottom: idx < stages.length - 1 ? 4 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: c, letterSpacing: .5 }}>
                  {stage.label}
                </span>
                {stage.status === 'passed' && stage.rows !== undefined && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>
                    {stage.rows} rows
                  </span>
                )}
              </div>
              {stage.status === 'failed' && stage.errors && stage.errors.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {stage.errors.slice(0, 3).map((e, i) => (
                    <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)', paddingLeft: 8, lineHeight: 1.6 }}>
                      {e.length > 120 ? e.slice(0, 120) + '…' : e}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Combined parser panel ────────────────────────────────────────────────────

function CombinedParserPanel({
  code, contractPassed, rowErrors, runError, totalRows, combinedRaw,
  onChange, isLoading, fallbackUsed,
}: {
  code: string;
  contractPassed: boolean | null;
  rowErrors: string[];
  runError: string | null;
  totalRows: number;
  combinedRaw: string;
  onChange?: (v: string) => void;
  isLoading?: boolean;
  fallbackUsed?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState<'code' | 'output'>('code');

  if (!code && !isLoading) return null;

  const ok = contractPassed === true;
  const accent = ok ? 'var(--acid)' : 'var(--red)';

  return (
    <div style={{
      border: `1px solid ${ok ? 'rgba(198,241,53,.3)' : 'rgba(255,61,90,.3)'}`,
      background: ok ? 'rgba(198,241,53,.02)' : 'rgba(255,61,90,.02)',
      marginTop: 4,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 12px', borderBottom: `1px solid ${ok ? 'rgba(198,241,53,.15)' : 'rgba(255,61,90,.15)'}`,
        cursor: 'pointer',
      }} onClick={() => setExpanded(e => !e)}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: accent }}>
          {ok ? '✓' : '✗'} COMBINED PARSER
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>
          parse_data(match_list_raw, markets_raw)
        </span>
        {ok && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--acid)', marginLeft: 'auto' }}>
            {totalRows} rows · all keys ✓
          </span>
        )}
        {!ok && (runError || rowErrors.length > 0) && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--red)', marginLeft: 'auto' }}>
            {runError ? 'runtime error' : `${rowErrors.length} rows failed`}
          </span>
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginLeft: ok ? 0 : 'auto' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Body */}
      {expanded && (
        <div>
          {/* Tabs + copy */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-dim)' }}>
            {(['output', 'code'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                ...s.tabBtn, fontSize: 7,
                color: tab === t ? accent : 'var(--text-muted)',
                borderBottomColor: tab === t ? accent : 'transparent',
              }}>
                {t === 'output' ? 'VALIDATED ROWS' : 'COMBINED CODE'}
              </button>
            ))}
            <div style={{ marginLeft: 'auto', padding: '0 10px' }}>
              <CopyButton text={tab === 'code' ? code : combinedRaw} size={7} />
            </div>
          </div>

          {/* Run error */}
          {runError && (
            <div style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)', lineHeight: 1.6 }}>
              {runError}
            </div>
          )}

          {/* Row errors */}
          {!runError && rowErrors.length > 0 && (
            <div style={{ padding: '8px 12px' }}>
              <ContractErrors errors={rowErrors} title={`${rowErrors.length} rows failed agent contract`} />
            </div>
          )}

          {/* Content */}
          {tab === 'output' && !runError && rowErrors.length === 0 && (
            <pre style={{ margin: 0, padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 9, color: ok ? 'var(--acid)' : 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
              {combinedRaw || '[]'}
            </pre>
          )}

          {tab === 'code' && (
            <div style={{ position: 'relative', overflow: 'hidden', maxHeight: 400 }}>
              {fallbackUsed && (
                <div style={{ padding: '4px 12px', background: 'rgba(255,180,0,.07)', borderBottom: '1px solid rgba(255,180,0,.2)', fontFamily: 'var(--font-mono)', fontSize: 7, color: '#fbbf24', letterSpacing: 1 }}>
                  ⚠ DETERMINISTIC FALLBACK — AI failed to combine; review the merge logic
                </div>
              )}
              {onChange ? (
                <textarea
                  value={code}
                  onChange={e => onChange(e.target.value)}
                  spellCheck={false}
                  style={{
                    display: 'block', width: '100%', minHeight: 280, resize: 'vertical',
                    border: 'none', outline: 'none', padding: '10px 14px',
                    fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.6,
                    background: ok ? 'rgba(10,20,10,.97)' : 'rgba(255,61,90,.04)',
                    color: ok ? 'var(--text-secondary)' : 'var(--red)',
                    boxSizing: 'border-box' as const,
                  }}
                />
              ) : (
                <pre style={{ margin: 0, padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflow: 'auto', background: 'rgba(10,20,10,.97)' }}>
                  {code}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text, size = 8 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button onClick={handleCopy} title="Copy to clipboard" style={{
      background: 'none', border: `1px solid ${copied ? 'rgba(198,241,53,.5)' : 'var(--border-dim)'}`,
      color: copied ? 'var(--acid)' : 'var(--text-muted)',
      fontFamily: 'var(--font-mono)', fontSize: size, letterSpacing: 1,
      padding: '2px 7px', cursor: 'pointer', flexShrink: 0,
      transition: 'all .2s',
    }}>
      {copied ? '✓ COPIED' : '⎘ COPY'}
    </button>
  );
}

// ─── JSON viewer ──────────────────────────────────────────────────────────────
// Read-only syntax-coloured JSON with copy button and optional field removal.

type JsonNode =
  | { kind: 'primitive'; value: unknown }
  | { kind: 'array';     items: JsonNode[]; collapsed: boolean }
  | { kind: 'object';    entries: { key: string; node: JsonNode; removed: boolean }[]; collapsed: boolean };

function parseNode(v: unknown): JsonNode {
  if (v === null || typeof v !== 'object') return { kind: 'primitive', value: v };
  if (Array.isArray(v)) return { kind: 'array', items: v.map(parseNode), collapsed: false };
  return {
    kind: 'object',
    collapsed: false,
    entries: Object.entries(v as Record<string, unknown>).map(([key, val]) => ({
      key, node: parseNode(val), removed: false,
    })),
  };
}

function nodeToJson(node: JsonNode): unknown {
  if (node.kind === 'primitive') return node.value;
  if (node.kind === 'array')     return node.items.map(nodeToJson);
  const obj: Record<string, unknown> = {};
  for (const e of node.entries) {
    if (!e.removed) obj[e.key] = nodeToJson(e.node);
  }
  return obj;
}

/** Render a JSON tree. `onUpdate` fires when a node is mutated (remove / collapse). */
function JsonTree({
  node, depth, path, editable, onUpdate,
}: {
  node: JsonNode;
  depth: number;
  path: string;
  editable: boolean;
  onUpdate: (path: string, patch: Partial<JsonNode> | { entryRemove?: string; entryCollapse?: string }) => void;
}) {
  const indent = depth * 14;

  if (node.kind === 'primitive') {
    const raw = JSON.stringify(node.value);
    const color =
      node.value === null            ? 'rgba(198,241,53,.45)' :
      typeof node.value === 'boolean'? 'rgba(6,182,212,.8)'   :
      typeof node.value === 'number' ? 'rgba(251,146,60,.9)'  :
                                       'rgba(167,243,208,.85)';
    return <span style={{ color, fontFamily: 'var(--font-mono)', fontSize: 9 }}>{raw}</span>;
  }

  if (node.kind === 'array') {
    if (node.collapsed) {
      return (
        <span
          onClick={() => onUpdate(path, { collapsed: false } as any)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}
        >
          [{node.items.length}]
        </span>
      );
    }
    return (
      <span>
        <span
          onClick={() => onUpdate(path, { collapsed: true } as any)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
        >▾ [</span>
        {node.items.map((item, i) => (
          <div key={i} style={{ marginLeft: indent + 14 }}>
            <JsonTree node={item} depth={depth + 1} path={`${path}[${i}]`} editable={editable} onUpdate={onUpdate} />
            {i < node.items.length - 1 && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>,</span>}
          </div>
        ))}
        <div style={{ marginLeft: indent }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>]</span></div>
      </span>
    );
  }

  // object
  if (node.collapsed) {
    return (
      <span
        onClick={() => onUpdate(path, { collapsed: false } as any)}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}
      >
        {'{'}…{'}'}
      </span>
    );
  }

  const visible = node.entries.filter(e => !e.removed);
  return (
    <span>
      <span
        onClick={() => onUpdate(path, { collapsed: true } as any)}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
      >▾ {'{'}</span>
      {visible.map((entry, i) => (
        <div key={entry.key} style={{ marginLeft: indent + 14, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
          {editable && (
            <button
              onClick={() => onUpdate(path, { entryRemove: entry.key } as any)}
              title={`Remove "${entry.key}"`}
              style={{
                background: 'none', border: 'none', color: 'rgba(255,61,90,.45)',
                fontFamily: 'var(--font-mono)', fontSize: 8, cursor: 'pointer',
                padding: '0 2px', lineHeight: 1.6, flexShrink: 0,
                transition: 'color .15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.45)')}
            >✕</button>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(130,180,255,.8)' }}>"{entry.key}"</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>: </span>
          <JsonTree node={entry.node} depth={depth + 1} path={`${path}.${entry.key}`} editable={editable} onUpdate={onUpdate} />
          {i < visible.length - 1 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>,</span>}
        </div>
      ))}
      <div style={{ marginLeft: indent }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{'}'}</span></div>
    </span>
  );
}

/**
 * JsonPanel — viewer + optional editor.
 * editable=true adds ✕ buttons on every key so you can remove fields.
 * Shows copy button for the (possibly pruned) JSON.
 */
function JsonPanel({
  raw, label, accent = 'var(--acid)', editable = false, maxHeight = 220,
}: {
  raw: string; label?: string; accent?: string; editable?: boolean; maxHeight?: number;
}) {
  const [root, setRoot] = useState<JsonNode | null>(null);
  const [parseErr, setParseErr] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  // Parse whenever raw changes
  useEffect(() => {
    if (!raw || raw === '—') { setRoot(null); setParseErr(''); return; }
    try {
      const parsed = JSON.parse(raw);
      setRoot(parseNode(parsed));
      setParseErr('');
    } catch {
      setRoot(null);
      setParseErr('');      // fall back to plain pre
    }
  }, [raw]);

  // Build the current pruned JSON string
  const currentJson = root ? JSON.stringify(nodeToJson(root), null, 2) : raw;

  // Deep-update a node by path string (simplified: handles root + first-level keys)
  const handleUpdate = (path: string, patch: any) => {
    if (!root) return;
    setRoot(prev => {
      if (!prev) return prev;
      // path === 'root' means the root itself
      const updateNode = (node: JsonNode, segments: string[]): JsonNode => {
        if (segments.length === 0) {
          if ('collapsed' in patch) return { ...node, collapsed: patch.collapsed } as JsonNode;
          return node;
        }
        if (node.kind === 'object') {
          if (patch.entryRemove && segments.length === 0) {
            return { ...node, entries: node.entries.map(e => e.key === patch.entryRemove ? { ...e, removed: true } : e) };
          }
          // Handle entryRemove at current level
          if (patch.entryRemove && segments[0] === '') {
            return { ...node, entries: node.entries.map(e => e.key === patch.entryRemove ? { ...e, removed: true } : e) };
          }
          if ('collapsed' in patch && segments.length === 0) return { ...node, collapsed: patch.collapsed };
          return node;
        }
        return node;
      };

      // Simple approach: rebuild root with the mutation
      if (path === 'root') {
        if ('collapsed' in patch) return { ...prev, collapsed: patch.collapsed } as JsonNode;
        if (patch.entryRemove && prev.kind === 'object') {
          return { ...prev, entries: prev.entries.map((e: any) => e.key === patch.entryRemove ? { ...e, removed: true } : e) };
        }
      }
      // Handle nested path like root.keyName
      if (prev.kind === 'object' && path.startsWith('root.')) {
        const topKey = path.slice(5).split('.')[0].split('[')[0];
        return {
          ...prev,
          entries: prev.entries.map(e => {
            if (e.key !== topKey) return e;
            const subPath = path.slice(5 + topKey.length);
            if (!subPath) {
              // action on this entry's node
              if ('collapsed' in patch) return { ...e, node: { ...e.node, collapsed: patch.collapsed } as JsonNode };
              if (patch.entryRemove && e.node.kind === 'object') {
                return { ...e, node: { ...e.node, entries: (e.node as any).entries.map((ee: any) => ee.key === patch.entryRemove ? { ...ee, removed: true } : ee) } };
              }
            }
            return e;
          }),
        };
      }
      return prev;
    });
  };

  if (!raw || raw === '—') return (
    <div style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>—</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
        {label && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', flex: 1 }}>{label}</span>}
        {editable && root && (
          <button onClick={() => { try { setRoot(parseNode(JSON.parse(raw))); } catch {} }} style={{
            background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1, padding: '2px 7px', cursor: 'pointer',
          }}>↺ RESET</button>
        )}
        <button onClick={() => setShowRaw(r => !r)} style={{
          background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1, padding: '2px 7px', cursor: 'pointer',
        }}>{showRaw ? 'TREE' : 'RAW'}</button>
        <CopyButton text={currentJson} size={7} />
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', maxHeight, padding: '8px 12px', background: 'rgba(10,14,10,.97)' }}>
        {showRaw || !root ? (
          <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: accent, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>
            {raw.slice(0, 8000)}{raw.length > 8000 ? '\n… (truncated)' : ''}
          </pre>
        ) : (
          <JsonTree node={root} depth={0} path="root" editable={editable} onUpdate={handleUpdate} />
        )}
      </div>

      {/* Removed-keys summary */}
      {editable && root && root.kind === 'object' && root.entries.some(e => e.removed) && (
        <div style={{ padding: '4px 12px', borderTop: '1px solid rgba(255,61,90,.2)', background: 'rgba(255,61,90,.03)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--red)', letterSpacing: 1 }}>REMOVED:</span>
          {root.entries.filter(e => e.removed).map(e => (
            <span key={e.key} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(255,61,90,.6)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {e.key}
              <button onClick={() => setRoot(prev => prev && prev.kind === 'object' ? { ...prev, entries: prev.entries.map(en => en.key === e.key ? { ...en, removed: false } : en) } : prev)} style={{ background: 'none', border: 'none', color: 'rgba(198,241,53,.5)', fontSize: 8, cursor: 'pointer', padding: 0 }}>↩</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Response sampler ─────────────────────────────────────────────────────────
/**
 * ResponseSampler wraps the JSON response column.
 * When the root response is an array (or has a top-level array key),
 * the user can:
 *   • Pick a single item by index
 *   • Multi-select individual items (checkboxes)
 *   • Take first N items
 * The selected slice is what gets sent to the AI.
 *
 * onSampleChange fires every time the selection changes,
 * passing the JSON string that should be used as response_raw.
 */
interface SamplerState {
  mode:        'all' | 'first' | 'pick' | 'single';
  firstN:      number;
  picked:      Set<number>;
  singleIndex: number;
  arrayKey:    string | null;  // null = root is array; string = key containing array
}

function detectArray(raw: string): { isArray: boolean; arrayKey: string | null; items: unknown[] } {
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return { isArray: true, arrayKey: null, items: p };
    if (p && typeof p === 'object') {
      // find first key whose value is an array with ≥2 items
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length >= 2) return { isArray: true, arrayKey: k, items: v };
      }
    }
    return { isArray: false, arrayKey: null, items: [] };
  } catch {
    return { isArray: false, arrayKey: null, items: [] };
  }
}

function applySample(raw: string, state: SamplerState): string {
  try {
    const { isArray, arrayKey, items } = detectArray(raw);
    if (!isArray || items.length === 0) return raw;

    let selected: unknown[];
    if (state.mode === 'all')    selected = items;
    else if (state.mode === 'first') selected = items.slice(0, Math.max(1, state.firstN));
    else if (state.mode === 'single') selected = [items[state.singleIndex] ?? items[0]];
    else selected = items.filter((_, i) => state.picked.has(i));
    if (selected.length === 0) selected = [items[0]];

    if (arrayKey === null) return JSON.stringify(selected, null, 2);

    // Rebuild the wrapper object with the sliced array
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, [arrayKey]: selected }, null, 2);
  } catch {
    return raw;
  }
}

function ResponseSampler({
  raw, accent, label, onSampleChange,
}: {
  raw: string;
  accent: string;
  label: string;
  onSampleChange: (sampled: string) => void;
}) {
  const { isArray, arrayKey, items } = detectArray(raw);
  const totalItems = items.length;

  const [state, setState] = useState<SamplerState>({
    mode: 'all', firstN: 1, picked: new Set([0]), singleIndex: 0, arrayKey,
  });

  // Fire parent on mount and whenever state changes
  useEffect(() => {
    onSampleChange(applySample(raw, state));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, state]);

  const update = (patch: Partial<SamplerState>) =>
    setState(prev => ({ ...prev, ...patch }));

  const togglePick = (i: number) => {
    setState(prev => {
      const next = new Set(prev.picked);
      if (next.has(i)) { if (next.size > 1) next.delete(i); }
      else next.add(i);
      return { ...prev, picked: next, mode: 'pick' };
    });
  };

  const selectedCount =
    state.mode === 'all'    ? totalItems
    : state.mode === 'first' ? Math.min(state.firstN, totalItems)
    : state.mode === 'single' ? 1
    : state.picked.size;

  if (!isArray || totalItems === 0) {
    // Non-array: just show the JSON panel directly
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <JsonPanel raw={raw} accent={accent} editable maxHeight={9999} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Sampler toolbar */}
      <div style={{
        background: 'rgba(10,18,10,.97)', borderBottom: '1px solid var(--border-dim)',
        padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
      }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', flex: 1 }}>
            {label.toUpperCase()} · {totalItems} ITEMS{arrayKey ? ` in "${arrayKey}"` : ''}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
            color: accent, border: `1px solid ${accent}55`, padding: '1px 8px',
          }}>
            {selectedCount} / {totalItems} SELECTED
          </span>
          <CopyButton text={applySample(raw, state)} size={7} />
        </div>

        {/* Mode selector */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
          {([
            ['all',    'ALL'],
            ['first',  `FIRST N`],
            ['pick',   'PICK'],
            ['single', 'SINGLE'],
          ] as const).map(([mode, label2]) => (
            <button
              key={mode}
              onClick={() => update({ mode })}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
                padding: '2px 8px', cursor: 'pointer',
                background: state.mode === mode ? `${accent}18` : 'transparent',
                border: `1px solid ${state.mode === mode ? accent + '88' : 'var(--border-dim)'}`,
                color: state.mode === mode ? accent : 'var(--text-muted)',
              }}
            >{label2}</button>
          ))}

          {/* firstN slider */}
          {state.mode === 'first' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              <input
                type="range" min={1} max={Math.min(totalItems, 20)} value={state.firstN}
                onChange={e => update({ firstN: Number(e.target.value) })}
                style={{ width: 80, accentColor: accent }}
              />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, minWidth: 20 }}>{state.firstN}</span>
            </div>
          )}

          {/* single index */}
          {state.mode === 'single' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>IDX</span>
              <input
                type="number" min={0} max={totalItems - 1} value={state.singleIndex}
                onChange={e => update({ singleIndex: Math.max(0, Math.min(totalItems - 1, Number(e.target.value))) })}
                style={{ ...sS.numInput, width: 48, color: accent }}
              />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>/ {totalItems - 1}</span>
            </div>
          )}
        </div>

        {/* Pick mode: item checkboxes */}
        {state.mode === 'pick' && (
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 3, maxHeight: 60, overflow: 'auto' }}>
            {items.map((item, i) => {
              const checked = state.picked.has(i);
              const preview = typeof item === 'object' && item !== null
                ? Object.values(item as Record<string, unknown>).find(v => typeof v === 'string') as string ?? `#${i}`
                : String(item);
              return (
                <button key={i} onClick={() => togglePick(i)} style={{
                  fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 7px', cursor: 'pointer',
                  background: checked ? `${accent}18` : 'transparent',
                  border: `1px solid ${checked ? accent + '88' : 'var(--border-dim)'}`,
                  color: checked ? accent : 'var(--text-muted)',
                  maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                }} title={JSON.stringify(item).slice(0, 200)}>
                  {checked ? '✓ ' : ''}{i}: {preview.slice(0, 18)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* JSON tree — shows only the selected items */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <JsonPanel raw={applySample(raw, state)} accent={accent} editable maxHeight={9999} />
      </div>
    </div>
  );
}

// Minimal style for number input in sampler
const sS = {
  numInput: {
    background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
    padding: '2px 5px', fontFamily: 'var(--font-mono)', fontSize: 9, outline: 'none',
  } as React.CSSProperties,
};

// ─── Lint badge + auto-lint pass ─────────────────────────────────────────────

type LintStatus = 'idle' | 'running' | 'fixed' | 'clean' | 'error';

function LintBadge({ status, fixes }: { status: LintStatus; fixes: number }) {
  if (status === 'idle') return null;
  const cfg: Record<LintStatus, { color: string; label: string }> = {
    idle:    { color: 'var(--text-muted)',           label: '' },
    running: { color: 'rgba(251,146,60,.8)',          label: '⟳ LINTING' },
    fixed:   { color: 'var(--acid)',                  label: `✓ LINTED (${fixes} fixes)` },
    clean:   { color: 'rgba(198,241,53,.4)',           label: '✓ CLEAN' },
    error:   { color: 'var(--red)',                   label: '⚠ LINT ERR' },
  };
  const { color, label } = cfg[status];
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1,
      color, border: `1px solid ${color}55`, padding: '1px 7px',
      animation: status === 'running' ? 'pulse 1s infinite' : 'none',
    }}>{label}</span>
  );
}

// ─── Generation round history ─────────────────────────────────────────────────

interface GenRound {
  round:        number;
  sampleSize:   number;   // how many items were sent
  contractOk:   boolean;
  lintFixes:    number;
  code:         string;
  timestamp:    string;
}

function RoundHistory({
  rounds, currentRound, onRestore,
}: {
  rounds: GenRound[];
  currentRound: number;
  onRestore: (code: string, round: number) => void;
}) {
  if (rounds.length === 0) return null;
  return (
    <div style={{ padding: '4px 12px', borderTop: '1px solid var(--border-dim)', background: 'rgba(10,10,10,.4)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, overflow: 'auto' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 2, flexShrink: 0 }}>ROUNDS:</span>
      {rounds.map(r => (
        <button
          key={r.round}
          onClick={() => onRestore(r.code, r.round)}
          title={`Round ${r.round} · ${r.sampleSize} items · ${r.timestamp}`}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 8px', cursor: 'pointer', flexShrink: 0,
            background: r.round === currentRound ? 'rgba(198,241,53,.12)' : 'transparent',
            border: `1px solid ${r.round === currentRound ? 'rgba(198,241,53,.4)' : 'var(--border-dim)'}`,
            color: r.round === currentRound ? 'var(--acid)' : 'var(--text-muted)',
          }}
        >
          R{r.round}
          {r.contractOk  && <span style={{ color: 'var(--acid)',    marginLeft: 4 }}>✓</span>}
          {!r.contractOk && <span style={{ color: 'var(--red)',     marginLeft: 4 }}>✗</span>}
          {r.lintFixes > 0 && <span style={{ color: 'rgba(251,146,60,.7)', marginLeft: 3 }}>~{r.lintFixes}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Tier badge ───────────────────────────────────────────────────────────────

function TierBadge({ tier, strategy }: { tier: number; strategy: string }) {
  const colors: Record<number, string> = { 1: 'rgba(198,241,53,.7)', 2: 'rgba(6,182,212,.7)', 3: 'rgba(251,146,60,.8)' };
  const c = colors[tier] ?? 'var(--text-muted)';
  return (
    <span title={`Tier ${tier}: ${strategy}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1, color: c, border: `1px solid ${c}`, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      T{tier} {strategy.toUpperCase()}
    </span>
  );
}

// ─── Upload progress panel ────────────────────────────────────────────────────

function UploadPanel({ ml, mk }: { ml: UploadState; mk: UploadState }) {
  const active = ml.active || mk.active || (ml.done && !ml.fallback) || (mk.done && !mk.fallback);
  if (!active) return null;
  const Row = ({ label, u }: { label: string; u: UploadState }) => {
    if (!u.active && !u.done) return null;
    const color = u.fallback ? 'var(--red)' : u.done ? 'var(--acid)' : 'rgba(251,146,60,.8)';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)', width: 80 }}>{label.toUpperCase()}</span>
        {u.active && !u.done && <div style={{ width: 10, height: 10, border: `1px solid rgba(251,146,60,.4)`, borderTopColor: 'rgba(251,146,60,.9)', borderRadius: '50%', animation: 'spin .7s linear infinite', flexShrink: 0 }} />}
        {u.done && <span style={{ color, fontSize: 9 }}>{u.fallback ? '⚠' : '✓'}</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color, flex: 1 }}>{u.message}</span>
        {u.done && !u.fallback && u.upload_ms !== null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{u.upload_ms} ms</span>}
      </div>
    );
  };
  return (
    <div style={{ background: 'rgba(251,146,60,.04)', border: '1px solid rgba(251,146,60,.2)', padding: '8px 14px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'rgba(251,146,60,.7)', marginBottom: 2 }}>GEMINI FILE API</div>
      <Row label="match list" u={ml} />
      <Row label="markets"    u={mk} />
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (!msg) return; const t = setTimeout(onClear, 5000); return () => clearTimeout(t); }, [msg, onClear]);
  if (!msg) return null;
  const err = msg.startsWith('✗');
  const warn = msg.startsWith('⚠');
  const color = err ? 'rgba(255,61,90,.6)' : warn ? 'rgba(251,146,60,.6)' : 'rgba(198,241,53,.6)';
  const textColor = err ? 'var(--red)' : warn ? 'rgba(251,146,60,.9)' : 'var(--acid)';
  return (
    <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 9999, background: 'var(--bg-elevated)', border: `1px solid ${color}`, color: textColor, padding: '11px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 8px 32px rgba(0,0,0,.7)', letterSpacing: 1, maxWidth: 480 }}>
      {msg}
    </div>
  );
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: number | null }) {
  if (!status) return null;
  const c = status < 300 ? 'var(--acid)' : status < 400 ? 'var(--cyan)' : 'var(--red)';
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: c, border: `1px solid ${c}`, padding: '2px 8px', letterSpacing: 1 }}>{status}</span>;
}

// ─── Stream progress ──────────────────────────────────────────────────────────

function StreamProgress({ status, step, total, visible }: { status: string; step: number; total: number; visible: boolean }) {
  if (!visible) return null;
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  const LABELS = ['Schema', 'ML Parser', 'MK Parser', 'Merge', 'Verify', 'Done'];
  return (
    <div style={{ background: 'rgba(198,241,53,.04)', border: '1px solid rgba(198,241,53,.2)', padding: '10px 16px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)', animation: pct < 100 ? 'pulse 1.4s ease-in-out infinite' : 'none' }}>{pct < 100 ? '✦' : '✓'}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--acid)', letterSpacing: 1 }}>{status}</span>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{step}/{total}</span>
      </div>
      <div style={{ height: 2, background: 'rgba(198,241,53,.15)', borderRadius: 1, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--acid)' : 'linear-gradient(90deg, rgba(198,241,53,.6), var(--acid))', transition: 'width 0.5s ease', boxShadow: pct < 100 ? '0 0 8px rgba(198,241,53,.5)' : 'none' }} />
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {LABELS.slice(0, total + 1).map((label, idx) => (
          <div key={idx} style={{ flex: 1, padding: '3px 0', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: .5, color: idx <= step ? 'var(--acid)' : 'var(--text-muted)', opacity: idx > step ? 0.4 : 1, borderBottom: `1px solid ${idx <= step ? 'var(--acid)' : 'var(--border-dim)'}`, transition: 'all 0.3s ease' }}>
            {idx < step ? '✓ ' : idx === step ? '⟳ ' : ''}{label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── KV Table ─────────────────────────────────────────────────────────────────

function KVTable({ rows, onChange, placeholder }: { rows: KV[]; onChange: (r: KV[]) => void; placeholder: [string, string] }) {
  const set = (i: number, k: keyof KV, v: string) => onChange(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  return (
    <div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
          <input value={row.key}   onChange={e => set(i, 'key',   e.target.value)} placeholder={placeholder[0]} style={{ ...s.miniInput, flex: '0 0 36%' }} />
          <input value={row.value} onChange={e => set(i, 'value', e.target.value)} placeholder={placeholder[1]} style={{ ...s.miniInput, flex: 1 }} />
          <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} style={s.iconBtn}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { key: '', value: '' }])} style={s.addBtn}>⊕ ADD</button>
    </div>
  );
}

// ─── Endpoint Builder ─────────────────────────────────────────────────────────

function EndpointBuilder({ label, accent, cfg, onChange, onProbe, probing }: {
  label: string; accent: string; cfg: EndpointConfig;
  onChange: (p: Partial<EndpointConfig>) => void; onProbe: () => void; probing: boolean;
}) {
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'body'>('params');

  const importCurl = (text: string) => {
    if (!text.trim()) return;
    try { const p = parseCurl(text); onChange(p); setCurlOpen(false); setCurlText(''); if (p.params.some(x => x.key)) setActiveTab('params'); else if (p.headers.some(x => x.key)) setActiveTab('headers'); else if (p.body) setActiveTab('body'); } catch { /* */ }
  };

  const paramCount  = Object.keys(kvToObj(cfg.params)).filter(Boolean).length;
  const headerCount = Object.keys(kvToObj(cfg.headers)).filter(Boolean).length;

  return (
    <div style={{ border: `1px solid ${accent}33`, background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: `1px solid ${accent}22`, background: `${accent}08` }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: accent }}>{label}</span>
        {cfg.probeResult && <StatusPill status={cfg.probeResult.status} />}
        {cfg.probeResult?.ok && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{cfg.probeResult.latency_ms}ms · {fmtKb(cfg.probeResult.size_bytes)}</span>}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={() => setCurlOpen(o => !o)} style={{ width: '100%', background: curlOpen ? `${accent}10` : 'transparent', border: `1px solid ${curlOpen ? accent + '55' : 'var(--border-dim)'}`, color: curlOpen ? accent : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '6px 10px', cursor: 'pointer', textAlign: 'left' as const, display: 'flex', justifyContent: 'space-between' }}>
          <span>⊕ IMPORT FROM CURL</span><span style={{ opacity: .5 }}>{curlOpen ? '▲' : '▼'}</span>
        </button>
        {curlOpen && (
          <div style={{ border: `1px solid ${accent}22`, borderTop: 'none', background: `${accent}05`, padding: '8px 10px' }}>
            <textarea value={curlText} onChange={e => setCurlText(e.target.value)} onPaste={e => { setTimeout(() => { const v = e.clipboardData?.getData('text') ?? ''; if ((v || curlText).trim().toLowerCase().startsWith('curl')) importCurl(v || curlText); }, 80); }} rows={4} placeholder={`curl -X GET 'https://api.example.com/events' \\\n  -H 'Authorization: Bearer TOKEN'`} spellCheck={false} style={{ ...s.miniInput, width: '100%', resize: 'vertical', boxSizing: 'border-box' as const, lineHeight: 1.5, fontSize: 10 }} />
            <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
              <button onClick={() => { setCurlOpen(false); setCurlText(''); }} style={s.btnGhost}>CANCEL</button>
              <button onClick={() => importCurl(curlText)} disabled={!curlText.trim()} style={{ ...s.btnPrimary, flex: 1, opacity: curlText.trim() ? 1 : .4, fontSize: 8, padding: '6px 0' }}>IMPORT & POPULATE</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 5 }}>
          <select value={cfg.method} onChange={e => onChange({ method: e.target.value })} style={{ ...s.miniInput, flex: '0 0 80px', color: 'var(--cyan)', fontWeight: 700 }}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
          </select>
          <input value={cfg.url} onChange={e => onChange({ url: e.target.value })} placeholder="https://api.bookmaker.com/…" style={{ ...s.miniInput, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') onProbe(); }} />
        </div>
        <div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 6 }}>
            {(['params', 'headers', 'body'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ ...s.tabBtn, fontSize: 7, color: activeTab === tab ? accent : 'var(--text-muted)', borderBottomColor: activeTab === tab ? accent : 'transparent' }}>
                {tab === 'params' && `PARAMS${paramCount ? ` (${paramCount})` : ''}`}
                {tab === 'headers' && `HEADERS${headerCount ? ` (${headerCount})` : ''}`}
                {tab === 'body' && 'BODY'}
              </button>
            ))}
          </div>
          {activeTab === 'params'  && <KVTable rows={cfg.params}  onChange={p => onChange({ params: p })}  placeholder={['param', 'value']} />}
          {activeTab === 'headers' && <KVTable rows={cfg.headers} onChange={h => onChange({ headers: h })} placeholder={['Header', 'value']} />}
          {activeTab === 'body'    && <textarea value={cfg.body} onChange={e => onChange({ body: e.target.value })} rows={4} placeholder={'{\n  "key": "value"\n}'} style={{ ...s.miniInput, width: '100%', resize: 'vertical', boxSizing: 'border-box' as const, lineHeight: 1.5 }} />}
        </div>
        <button onClick={onProbe} disabled={probing || !cfg.url.trim()} style={{ ...s.btnPrimary, width: '100%', padding: '8px 0', background: accent, color: '#0a0a0a', opacity: (probing || !cfg.url.trim()) ? .5 : 1, fontSize: 8, letterSpacing: 2 }}>
          {probing ? '⟳ SENDING…' : `▶ SEND ${label}`}
        </button>
        {cfg.probeResult && (
          <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', maxHeight: 140, overflow: 'hidden' }}>
            {cfg.probeResult.error
              ? <div style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)' }}>✗ {cfg.probeResult.error}</div>
              : <JsonPanel raw={cfg.probeResult.response_raw} accent="#78d5ff" editable={false} maxHeight={130} />
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepBar({ step }: { step: Step }) {
  return (
    <div style={{ display: 'flex', gap: 0, alignItems: 'stretch', marginBottom: 24 }}>
      {[{ n: 1, l: 'BUILD & PROBE' }, { n: 2, l: 'PARSE & APPROVE' }].map((st, i) => {
        const active = step === st.n, done = step > st.n;
        return (
          <div key={st.n} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <div style={{ width: 36, height: 1, background: done ? 'var(--acid)' : 'var(--border-dim)' }} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: active ? 'rgba(198,241,53,.08)' : 'transparent', border: `1px solid ${active ? 'rgba(198,241,53,.3)' : 'var(--border-dim)'}` }}>
              <div style={{ width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, background: done ? 'var(--acid)' : active ? 'rgba(198,241,53,.2)' : 'var(--bg-base)', border: `1px solid ${done || active ? 'var(--acid)' : 'var(--border-dim)'}`, color: done ? '#0a0a0a' : active ? 'var(--acid)' : 'var(--text-muted)' }}>
                {done ? '✓' : st.n}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: active ? 'var(--acid)' : done ? 'var(--text-secondary)' : 'var(--text-muted)' }}>{st.l}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Code editor column ───────────────────────────────────────────────────────

function CodeCol({ title, accent, code, onChange, contract, modelUsed, isLoading, isStreaming, tier, strategy, lintStatus, lintFixes, rounds, currentRound, onRestoreRound }: {
  title: string; accent: string; code: string; onChange: (v: string) => void;
  contract: ContractState; modelUsed?: string;
  isLoading: boolean; isStreaming?: boolean;
  tier?: number; strategy?: string;
  lintStatus?: LintStatus; lintFixes?: number;
  rounds?: GenRound[]; currentRound?: number; onRestoreRound?: (code: string, round: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)', border: '1px solid var(--border-dim)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 12px', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: accent }}>{title}</span>
          {tier !== undefined && strategy && <TierBadge tier={tier} strategy={strategy} />}
          {lintStatus && <LintBadge status={lintStatus} fixes={lintFixes ?? 0} />}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {modelUsed && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{modelUsed}</span>}
          <ContractBadge contract={contract} />
          {code && <CopyButton text={code} size={7} />}
        </div>
      </div>

      {/* Code area */}
      {isLoading && !code ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {isStreaming
            ? <><div style={{ width: 28, height: 28, border: `2px solid ${accent}33`, borderTopColor: accent, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /><span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: accent, letterSpacing: 3, opacity: .7 }}>WAITING…</span></>
            : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: accent, letterSpacing: 4, animation: 'pulse 1s ease-in-out infinite' }}>AI WORKING…</span>
          }
        </div>
      ) : !code ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', textAlign: 'center' as const, lineHeight: 2 }}>
            NO PARSER YET<br /><span style={{ opacity: .5 }}>Generate with AI or write manually</span>
          </span>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <textarea
            value={code} onChange={e => onChange(e.target.value)} spellCheck={false}
            style={{
              position: 'absolute', inset: 0, resize: 'none', border: 'none', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.6,
              background: contract.passed === false ? 'rgba(255,61,90,.04)' : 'rgba(10,20,10,.97)',
              color: contract.passed === false ? 'var(--red)' : accent,
              padding: '12px 14px', width: '100%', height: '100%', boxSizing: 'border-box' as const,
            }}
          />
        </div>
      )}

      {/* Contract errors inline under editor */}
      {contract.passed === false && contract.errors.length > 0 && code && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid rgba(255,61,90,.2)', background: 'rgba(255,61,90,.04)', flexShrink: 0 }}>
          <ContractErrors errors={contract.errors} title="Contract errors" />
        </div>
      )}

      {/* Round history */}
      {rounds && rounds.length > 0 && onRestoreRound && (
        <RoundHistory rounds={rounds} currentRound={currentRound ?? 0} onRestore={onRestoreRound} />
      )}
    </div>
  );
}

// ─── Warnings banner ──────────────────────────────────────────────────────────

function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div style={{ background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.3)', padding: '6px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)', letterSpacing: 1 }}>⚠ WARNINGS</span>
      {warnings.map((w, i) => <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.7)' }}>{w}</span>)}
    </div>
  );
}

// ─── STEP 1 ───────────────────────────────────────────────────────────────────

const EMPTY_EP = (): EndpointConfig => ({ url: '', method: 'GET', headers: [{ key: '', value: '' }], params: [{ key: '', value: '' }], body: '', probeResult: null });

function Step1({ bookmakers, sports, requestTypes, onNext }: {
  bookmakers: BookmakerOption[]; sports: SportOption[]; requestTypes: string[];
  onNext: (d: any) => void;
}) {
  const [bookmarkerId, setBookmarkerId] = useState(bookmakers[0]?.id ?? 0);
  const [sportId,      setSportId]      = useState<number | null>(null);
  const [endpointType, setEndpointType] = useState('MATCH_LIST');
  const [withMarkets,  setWithMarkets]  = useState(false);
  const [matchList,    setMatchList]    = useState<EndpointConfig>(EMPTY_EP());
  const [markets,      setMarkets]      = useState<EndpointConfig>(EMPTY_EP());
  const [probingML,    setProbingML]    = useState(false);
  const [probingMK,    setProbingMK]    = useState(false);
  const [toast,        setToast]        = useState('');

  const bookmakerName = bookmakers.find(b => b.id === bookmarkerId)?.name ?? '';
  const sportName     = sports.find(s => s.id === sportId)?.name ?? '';

  const doProbe = async (cfg: EndpointConfig, setProbing: (v: boolean) => void, setCfg: (c: EndpointConfig) => void) => {
    if (!cfg.url.trim()) { setToast('✗ URL is required'); return; }
    setProbing(true);
    try {
      const res  = await fetchWithAuth('/research/probe', { method: 'POST', body: JSON.stringify({ url: cfg.url, method: cfg.method, headers: kvToObj(cfg.headers), params: kvToObj(cfg.params), body: cfg.body || null }) });
      const data = await res.json();
      setCfg({ ...cfg, probeResult: data });
      if (!data.ok && data.error) setToast(`✗ ${data.error}`);
      else setToast(`✓ ${data.status} — ${fmtKb(data.size_bytes)}`);
    } catch (e: any) { setToast(`✗ ${e.message}`); }
    finally { setProbing(false); }
  };

  const canAdvance = matchList.probeResult?.ok && (!withMarkets || markets.probeResult?.ok);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Toast msg={toast} onClear={() => setToast('')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div style={s.fieldWrap}>
          <label style={s.label}>BOOKMAKER</label>
          <select value={bookmarkerId} onChange={e => setBookmarkerId(Number(e.target.value))} style={s.input}>
            {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name} — {b.domain}</option>)}
          </select>
        </div>
        <div style={s.fieldWrap}>
          <label style={s.label}>SPORT <span style={{ color: 'var(--text-muted)', fontSize: 7 }}>(AI context)</span></label>
          <select value={sportId ?? ''} onChange={e => setSportId(e.target.value ? Number(e.target.value) : null)} style={s.input}>
            <option value=''>— All / Not specified —</option>
            {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
          </select>
        </div>
        <div style={s.fieldWrap}>
          <label style={s.label}>MATCH LIST TYPE</label>
          <select value={endpointType} onChange={e => setEndpointType(e.target.value)} style={s.input}>
            {requestTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: withMarkets ? '1fr 1fr' : '1fr', gap: 10 }}>
        <EndpointBuilder label="MATCH LIST" accent="var(--acid)" cfg={matchList} onChange={p => setMatchList(c => ({ ...c, ...p }))} onProbe={() => doProbe(matchList, setProbingML, c => setMatchList(c))} probing={probingML} />
        {withMarkets && <EndpointBuilder label="MARKETS (per-match odds)" accent="var(--cyan)" cfg={markets} onChange={p => setMarkets(c => ({ ...c, ...p }))} onProbe={() => doProbe(markets, setProbingMK, c => setMarkets(c))} probing={probingMK} />}
      </div>
      {!withMarkets
        ? <button onClick={() => setWithMarkets(true)} style={{ ...s.btnGhost, alignSelf: 'flex-start', borderStyle: 'dashed', color: 'var(--cyan)', borderColor: 'rgba(6,182,212,.4)' }}>⊕ LINK MARKETS ENDPOINT</button>
        : <button onClick={() => { setWithMarkets(false); setMarkets(EMPTY_EP()); }} style={{ ...s.btnGhost, alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: 8 }}>✕ REMOVE MARKETS ENDPOINT</button>
      }
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8, borderTop: '1px solid var(--border-dim)' }}>
        {!canAdvance && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1, marginRight: 16, alignSelf: 'center' }}>
          {!matchList.probeResult?.ok ? 'Probe match list first' : 'Probe markets endpoint too'}
        </span>}
        <button onClick={() => { if (!canAdvance) { setToast('✗ Probe all endpoints first'); return; } onNext({ bookmarkerId, bookmarkerName: bookmakerName, sportId, sportName, endpointType, matchList, markets: withMarkets ? markets : null }); }} disabled={!canAdvance} style={{ ...s.btnPrimary, padding: '10px 24px', opacity: canAdvance ? 1 : .4 }}>
          NEXT — CREATE PARSERS →
        </button>
      </div>
    </div>
  );
}

// ─── STEP 2 ───────────────────────────────────────────────────────────────────
//
// Sequential 3-step generation flow:
//   genStep 0 = nothing submitted yet
//   genStep 1 = ML submitted   → ML code visible (even on error)
//   genStep 2 = MK submitted   → MK code visible (even on error)
//   genStep 3 = Combined done  → combined code visible (even on error)

function GenStepBar({ step }: { step: 0|1|2|3 }) {
  const steps = [
    { n: 1 as const, label: 'MATCH LIST',  color: 'var(--acid)' },
    { n: 2 as const, label: 'MARKETS',     color: 'var(--cyan)' },
    { n: 3 as const, label: 'COMBINED',    color: '#d8b4fe'     },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 12 }}>
      {steps.map((st, i) => {
        const done    = step > st.n;
        const active  = step === st.n;
        const pending = step < st.n;
        return (
          <div key={st.n} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <div style={{ width: 28, height: 1, background: done ? st.color : 'var(--border-dim)' }} />
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px',
              background: active ? `${st.color}12` : 'transparent',
              border: `1px solid ${active ? st.color + '55' : done ? st.color + '33' : 'var(--border-dim)'}`,
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
                background: done ? st.color : active ? `${st.color}22` : 'var(--bg-base)',
                border: `1px solid ${done || active ? st.color : 'var(--border-dim)'}`,
                color: done ? '#0a0a0a' : active ? st.color : 'var(--text-muted)',
                flexShrink: 0,
              }}>
                {done ? '✓' : st.n}
              </div>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2,
                color: active ? st.color : done ? 'var(--text-secondary)' : 'var(--text-muted)',
              }}>{st.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Step2({ bookmarkerId, bookmarkerName, sportName, endpointType, matchList, markets, onBack, onSaved }: {
  bookmarkerId: number; bookmarkerName: string; sportName: string; endpointType: string;
  matchList: EndpointConfig; markets: EndpointConfig | null;
  onBack: () => void; onSaved: (mlId: number, mkId?: number) => void;
}) {
  const isPair = markets !== null;

  const [saving,      setSaving]      = useState(false);
  const [testing,     setTesting]     = useState(false);
  const [toast,       setToast]       = useState('');

  // Sequential gen step: 0=none, 1=ml submitted, 2=mk submitted, 3=combined done
  const [genStep,     setGenStep]     = useState<0|1|2|3>(0);
  const [submittingML,  setSubmittingML]  = useState(false);
  const [submittingMK,  setSubmittingMK]  = useState(false);
  const [submittingCombined, setSubmittingCombined] = useState(false);

  // ── ML parser state ──────────────────────────────────────────────────────
  const [mlCode,      setMlCode]      = useState('');
  const [mlContract,  setMlContract]  = useState<ContractState>(emptyContract());
  const [mlRows,      setMlRows]      = useState<any[]>([]);

  // ── MK parser state ──────────────────────────────────────────────────────
  const [mkCode,      setMkCode]      = useState('');
  const [mkContract,  setMkContract]  = useState<ContractState>(emptyContract());
  const [mkRows,      setMkRows]      = useState<any[]>([]);

  // ── Combined parser state ─────────────────────────────────────────────────
  const [combinedCode,      setCombinedCode]      = useState('');
  const [combinedContract,  setCombinedContract]  = useState<ContractState>(emptyContract());
  const [combinedRunError,  setCombinedRunError]  = useState<string | null>(null);
  const [combinedRowErrors, setCombinedRowErrors] = useState<string[]>([]);
  const [combinedRaw,       setCombinedRaw]       = useState('');
  const [totalCombinedRows, setTotalCombinedRows] = useState(0);
  const [fallbackUsed,      setFallbackUsed]      = useState(false);

  // ── Stage pipeline (for StagePipeline panel display) ─────────────────────
  const [stages, setStages] = useState<StageState[]>(
    STAGE_LABELS.map(label => ({ status: 'idle' as const, label }))
  );

  const setStage = (idx: number, patch: Partial<StageState>) =>
    setStages(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));

  // ── Grouped output ────────────────────────────────────────────────────────
  const [grouped,    setGrouped]    = useState<any[]>([]);
  const [groupedRaw, setGroupedRaw] = useState('');
  const [outTab,     setOutTab]     = useState<'combined' | 'grouped' | 'matches' | 'markets'>('combined');

  // ── Sampler ───────────────────────────────────────────────────────────────
  const [sampledMl,  setSampledMl]  = useState<string>('');
  const [sampledMk,  setSampledMk]  = useState<string>('');

  // ── Lint ──────────────────────────────────────────────────────────────────
  const [mlLintStatus, setMlLintStatus] = useState<LintStatus>('idle');
  const [mkLintStatus, setMkLintStatus] = useState<LintStatus>('idle');
  const [mlLintFixes,  setMlLintFixes]  = useState(0);
  const [mkLintFixes,  setMkLintFixes]  = useState(0);

  // ── Round history ─────────────────────────────────────────────────────────
  const [mlRounds,       setMlRounds]       = useState<GenRound[]>([]);
  const [mkRounds,       setMkRounds]       = useState<GenRound[]>([]);
  const [mlCurrentRound, setMlCurrentRound] = useState(0);
  const [mkCurrentRound, setMkCurrentRound] = useState(0);
  const roundCounterRef = useRef(0);

  const abortRef = useRef<AbortController | null>(null);

  // Tier / model context
  const [mlTier,     setMlTier]     = useState<number | undefined>(undefined);
  const [mkTier,     setMkTier]     = useState<number | undefined>(undefined);
  const [mlStrategy, setMlStrategy] = useState<string | undefined>(undefined);
  const [mkStrategy, setMkStrategy] = useState<string | undefined>(undefined);
  const [modelUsed,  setModelUsed]  = useState('');
  const [warnings,   setWarnings]   = useState<string[]>([]);

  // Upload panels (kept for UI parity)
  const [mlUpload, setMlUpload] = useState<UploadState>(emptyUpload());
  const [mkUpload, setMkUpload] = useState<UploadState>(emptyUpload());
  const [mlArrived, setMlArrived] = useState(false);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const countItems = (s: string): number => {
    try { const p = JSON.parse(s); return Array.isArray(p) ? p.length : 1; } catch { return 1; }
  };

  const autoLint = async (
    code: string,
    setCode: (c: string) => void,
    setStatus: (s: LintStatus) => void,
    setFixes: (n: number) => void,
  ): Promise<string> => {
    if (!code.trim()) return code;
    setStatus('running');
    try {
      const res = await fetchWithAuth('/research/lint-parser', {
        method: 'POST',
        body: JSON.stringify({ parser_code: code }),
      });
      if (!res.ok) { setStatus('error'); return code; }
      const d = await res.json();
      const fixed: string = d.fixed_code ?? code;
      const fixes: number = d.fixes_applied ?? 0;
      setCode(fixed);
      setFixes(fixes);
      setStatus(fixes > 0 ? 'fixed' : 'clean');
      return fixed;
    } catch {
      setStatus('error');
      return code;
    }
  };

  const recordRound = (
    code: string, contractOk: boolean, lintFixes: number, sampleSize: number,
    setRounds: (fn: (prev: GenRound[]) => GenRound[]) => void,
    setCurrentRound: (n: number) => void,
  ) => {
    roundCounterRef.current += 1;
    const r = roundCounterRef.current;
    setCurrentRound(r);
    setRounds(prev => [...prev.slice(-9), {
      round: r, sampleSize, contractOk, lintFixes,
      code, timestamp: new Date().toLocaleTimeString(),
    }]);
  };

  // ── STEP 1: Submit match list ─────────────────────────────────────────────

  const handleSubmitML = async () => {
    const mlRaw = (sampledMl || matchList.probeResult?.response_raw) ?? '';
    if (!mlRaw) { setToast('✗ Probe match list endpoint first'); return; }

    setSubmittingML(true);
    setMlCode(''); setMlContract(emptyContract()); setMlRows([]);
    setStage(0, { status: 'running', label: STAGE_LABELS[0] });

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetchWithAuth('/research/step/match-list', {
        method: 'POST', signal: abort.signal,
        body: JSON.stringify({
          response_raw:   mlRaw,
          bookmaker_name: bookmarkerName,
          sport_name:     sportName,
        }),
      });
      const d = await res.json();

      // Always show code even on error
      let code = d.parser_code ?? '';
      if (code) {
        code = await autoLint(code, setMlCode, setMlLintStatus, setMlLintFixes);
      } else {
        setMlCode('');
      }

      const passed = d.contract_passed ?? false;
      const errors = d.contract_errors ?? [];
      const rows   = d.rows ?? [];

      setMlContract({ passed: code ? passed : null, errors, rows: rows.length });
      setMlRows(rows);
      setStage(0, {
        status: code ? (passed ? 'passed' : 'failed') : 'failed',
        rows: rows.length, errors,
      });

      recordRound(code, passed, mlLintFixes, countItems(mlRaw), setMlRounds, setMlCurrentRound);

      if (d.error && !code) {
        setToast(`✗ ML generation failed: ${d.error}`);
        setStage(0, { status: 'failed', errors: [d.error] });
      } else if (!passed && code) {
        setToast(`⚠ ML parser generated — contract errors (edit and resubmit to fix)`);
      } else if (passed) {
        setToast(`✓ Step 1 done — ${rows.length} rows verified`);
      }

      // Advance to step 1 regardless of contract (code is available)
      if (code) setGenStep(prev => prev < 1 ? 1 : prev);
      setOutTab('matches');

    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setToast(`✗ ${e.message}`);
        setStage(0, { status: 'failed', errors: [e.message] });
      }
    } finally {
      setSubmittingML(false);
    }
  };

  // ── STEP 2: Submit markets ────────────────────────────────────────────────

  const handleSubmitMK = async () => {
    if (!isPair) return;
    const mkRaw = (sampledMk || markets?.probeResult?.response_raw) ?? '';
    const mlRaw = (sampledMl || matchList.probeResult?.response_raw) ?? '';
    if (!mkRaw) { setToast('✗ Probe markets endpoint first'); return; }

    setSubmittingMK(true);
    setMkCode(''); setMkContract(emptyContract()); setMkRows([]);
    setStage(1, { status: 'running', label: STAGE_LABELS[1] });

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetchWithAuth('/research/step/markets', {
        method: 'POST', signal: abort.signal,
        body: JSON.stringify({
          response_raw:    mkRaw,
          ml_response_raw: mlRaw,
          ml_parser_code:  mlCode,   // send current ML code for context
          bookmaker_name:  bookmarkerName,
          sport_name:      sportName,
        }),
      });
      const d = await res.json();

      let code = d.parser_code ?? '';
      if (code) {
        code = await autoLint(code, setMkCode, setMkLintStatus, setMkLintFixes);
      } else {
        setMkCode('');
      }

      const passed = d.contract_passed ?? false;
      const errors = d.contract_errors ?? [];
      const rows   = d.rows ?? [];

      setMkContract({ passed: code ? passed : null, errors, rows: rows.length });
      setMkRows(rows);
      setStage(1, {
        status: code ? (passed ? 'passed' : 'failed') : 'failed',
        rows: rows.length, errors,
      });

      recordRound(code, passed, mkLintFixes, countItems(mkRaw), setMkRounds, setMkCurrentRound);

      if (d.error && !code) {
        setToast(`✗ MK generation failed: ${d.error}`);
        setStage(1, { status: 'failed', errors: [d.error] });
      } else if (!passed && code) {
        setToast(`⚠ Markets parser generated — contract errors (edit and resubmit to fix)`);
      } else if (passed) {
        setToast(`✓ Step 2 done — ${rows.length} rows verified`);
      }

      if (code) setGenStep(prev => prev < 2 ? 2 : prev);
      setOutTab('markets');

    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setToast(`✗ ${e.message}`);
        setStage(1, { status: 'failed', errors: [e.message] });
      }
    } finally {
      setSubmittingMK(false);
    }
  };

  // ── STEP 3: Submit combined ───────────────────────────────────────────────

  const handleSubmitCombined = async () => {
    if (!mlCode) { setToast('✗ Submit match list first (Step 1)'); return; }
    if (isPair && !mkCode) { setToast('✗ Submit markets first (Step 2)'); return; }

    const mlRaw = (sampledMl || matchList.probeResult?.response_raw) ?? '';
    const mkRaw = (sampledMk || markets?.probeResult?.response_raw) ?? '';
    if (!mlRaw) { setToast('✗ No match list response available'); return; }
    if (isPair && !mkRaw) { setToast('✗ No markets response available'); return; }

    setSubmittingCombined(true);
    setCombinedCode(''); setCombinedContract(emptyContract());
    setCombinedRunError(null); setCombinedRowErrors([]);
    setStage(2, { status: 'running', label: STAGE_LABELS[2] });
    setStage(3, { status: 'idle',    label: STAGE_LABELS[3] });

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetchWithAuth('/research/step/combine', {
        method: 'POST', signal: abort.signal,
        body: JSON.stringify({
          ml_parser_code:  mlCode,
          mk_parser_code:  isPair ? mkCode : mlCode,
          ml_response_raw: mlRaw,
          mk_response_raw: isPair ? mkRaw : mlRaw,
          bookmaker_name:  bookmarkerName,
          sport_name:      sportName,
        }),
      });
      const d = await res.json();

      // Always show combined code even on error
      const code    = d.combined_parser_code ?? '';
      const passed  = d.contract_passed ?? false;
      const rowErrs = d.contract_errors ?? [];
      const runErr  = d.run_error ?? null;
      const rows    = d.rows ?? [];
      const total   = d.total_rows ?? 0;

      setCombinedCode(code);
      setCombinedContract({ passed: code ? passed : null, errors: rowErrs, rows: total });
      setCombinedRunError(runErr);
      setCombinedRowErrors(rowErrs);
      setCombinedRaw(JSON.stringify(rows, null, 2));
      setTotalCombinedRows(total);
      setFallbackUsed(d.fallback_used ?? false);

      setStage(2, { status: 'passed', rows: 0 });
      setStage(3, {
        status: passed ? 'passed' : 'failed',
        rows: total,
        errors: rowErrs.length ? rowErrs : (runErr ? [runErr] : []),
      });

      if (runErr && !rows.length) {
        setToast(`⚠ Combined parser has runtime error — see code (edit & resubmit)`);
      } else if (!passed && code) {
        setToast(`⚠ Combined generated — contract errors (edit and resubmit to fix)`);
      } else if (passed) {
        setToast(`✓ All 3 steps done — ${total} rows verified${d.fallback_used ? ' (deterministic combiner)' : ''}`);
      }

      if (code) setGenStep(3);
      setOutTab('combined');

    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setToast(`✗ ${e.message}`);
        setStage(2, { status: 'failed', errors: [e.message] });
      }
    } finally {
      setSubmittingCombined(false);
    }
  };

  // ── Validate (manual re-test) ─────────────────────────────────────────────

  const handleTest = async () => {
    setTesting(true);
    try {
      if (isPair && mlCode && mkCode) {
        const res = await fetchWithAuth('/research/test-parser-pair', {
          method: 'POST',
          body: JSON.stringify({
            match_list_parser: mlCode, markets_parser: mkCode,
            match_list_raw: matchList.probeResult!.response_raw,
            markets_raw: markets!.probeResult!.response_raw,
          }),
        });
        const d = await res.json();
        setMlRows(d.match_list_rows ?? []); setMkRows(d.markets_rows ?? []);
        setGrouped(d.grouped ?? []); setGroupedRaw(d.grouped_raw ?? '');
        setMlContract({ passed: d.match_list_contract_passed ?? false, errors: d.match_list_contract_errors ?? [], rows: (d.match_list_rows ?? []).length });
        setMkContract({ passed: d.markets_contract_passed   ?? false, errors: d.markets_contract_errors   ?? [], rows: (d.markets_rows   ?? []).length });
        setStage(0, { status: d.match_list_contract_passed ? 'passed' : 'failed', rows: (d.match_list_rows ?? []).length, errors: d.match_list_contract_errors ?? [] });
        setStage(1, { status: d.markets_contract_passed    ? 'passed' : 'failed', rows: (d.markets_rows   ?? []).length, errors: d.markets_contract_errors   ?? [] });
        const bothOk = d.match_list_contract_passed && d.markets_contract_passed;
        setToast(bothOk ? `✓ Both parsers valid` : `⚠ Contract errors — check column headers`);
      } else {
        const res = await fetchWithAuth('/research/test-parser', {
          method: 'POST',
          body: JSON.stringify({ parser_code: mlCode, response_raw: matchList.probeResult!.response_raw }),
        });
        const d = await res.json();
        setMlRows(d.unified_sample ?? []);
        setMlContract({ passed: d.contract_passed ?? false, errors: d.contract_errors ?? [], rows: (d.unified_sample ?? []).length });
        setStage(0, { status: d.contract_passed ? 'passed' : 'failed', rows: d.total_rows ?? 0, errors: d.contract_errors ?? [] });
        setToast(d.contract_passed ? `✓ ${d.total_rows} rows valid` : `⚠ Contract errors`);
      }
    } catch (e: any) { setToast(`✗ ${e.message}`); }
    finally { setTesting(false); }
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const canSave = isPair
    ? !!(combinedCode && combinedContract.passed === true)
    : !!(mlCode && mlContract.passed === true);

  const handleSave = async () => {
    if (!canSave) {
      setToast(isPair
        ? '✗ Combined parser must pass Step 3 before saving'
        : '✗ Parser must pass contract validation before saving'
      );
      return;
    }
    setSaving(true);
    try {
      if (isPair) {
        const res = await fetchWithAuth('/research/save-pair', {
          method: 'POST',
          body: JSON.stringify({
            bookmaker_id: bookmarkerId, sport_name: sportName,
            match_list: {
              url: matchList.url, method: matchList.method,
              headers: kvToObj(matchList.headers), params: kvToObj(matchList.params),
              body: matchList.body || null,
              parser_code: mlCode,
              sample_response: matchList.probeResult!.response_raw.slice(0, 4000),
            },
            markets: {
              url: markets!.url, method: markets!.method,
              headers: kvToObj(markets!.headers), params: kvToObj(markets!.params),
              body: markets!.body || null,
              parser_code: mkCode,
              sample_response: markets!.probeResult!.response_raw.slice(0, 4000),
            },
          }),
        });
        const d = await res.json();
        if (d.ok) {
          setToast(`✓ Saved #${d.match_list_endpoint_id} + #${d.markets_endpoint_id}`);
          onSaved(d.match_list_endpoint_id, d.markets_endpoint_id);
        } else {
          const details = d.details || {};
          const mlErr = details.match_list?.[0];
          const mkErr = details.markets?.[0];
          setToast(`✗ ${d.error || 'Save failed'}${mlErr ? ` · ML: ${mlErr}` : ''}${mkErr ? ` · MK: ${mkErr}` : ''}`);
          if (details.match_list) setMlContract({ passed: false, errors: details.match_list, rows: mlRows.length });
          if (details.markets)    setMkContract({ passed: false, errors: details.markets,    rows: mkRows.length });
        }
      } else {
        const res = await fetchWithAuth('/research/save', {
          method: 'POST',
          body: JSON.stringify({
            bookmaker_id: bookmarkerId, endpoint_type: endpointType,
            url: matchList.url, method: matchList.method,
            headers: kvToObj(matchList.headers), params: kvToObj(matchList.params),
            body: matchList.body || null,
            parser_code: mlCode,
            sample_response: matchList.probeResult!.response_raw.slice(0, 4000),
          }),
        });
        const d = await res.json();
        if (d.ok) {
          setToast(`✓ Saved #${d.endpoint_id} — ${d.rows_verified ?? 0} rows verified`);
          onSaved(d.endpoint_id);
        } else {
          setToast(`✗ ${d.error || 'Save failed'}`);
          if (d.details) setMlContract({ passed: false, errors: d.details, rows: mlRows.length });
        }
      }
    } catch (e: any) { setToast(`✗ ${e.message}`); }
    finally { setSaving(false); }
  };

  const isSubmitting = submittingML || submittingMK || submittingCombined;
  const hasCode = !!(mlCode || mkCode || combinedCode);
  const REQUIRED_KEYS = ['parent_match_id', 'home_team', 'away_team', 'market', 'selection', 'price', 'start_time', 'sport', 'competition', 'specifier'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <Toast msg={toast} onClear={() => setToast('')} />

      {/* ── Action bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-dim)', marginBottom: 8, flexWrap: 'wrap' as const }}>
        <button onClick={() => { abortRef.current?.abort(); onBack(); }} style={s.btnGhost}>← BACK</button>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1 }}>
          {bookmarkerName} · {sportName || 'all sports'}
          {isPair && <span style={{ color: 'var(--cyan)', marginLeft: 8 }}>PAIR MODE · 3-STEP</span>}
        </div>
        <div style={{ flex: 1 }} />

        {/* STEP 1: Submit match list */}
        <button
          onClick={handleSubmitML}
          disabled={isSubmitting}
          style={{
            ...s.btnGhost,
            opacity: isSubmitting ? .5 : 1,
            borderColor: 'rgba(198,241,53,.5)',
            color: 'var(--acid)',
          }}
        >
          {submittingML ? '⟳ GENERATING ML…' : (() => {
            const n = sampledMl ? countItems(sampledMl) : (matchList.probeResult ? '?' : 0);
            return `① SUBMIT MATCH LIST${n ? ` (${n} items)` : ''}`;
          })()}
        </button>

        {/* STEP 2: Submit markets (only in pair mode) */}
        {isPair && (
          <button
            onClick={handleSubmitMK}
            disabled={isSubmitting || genStep < 1}
            title={genStep < 1 ? 'Submit match list first (Step 1)' : ''}
            style={{
              ...s.btnGhost,
              opacity: (isSubmitting || genStep < 1) ? .4 : 1,
              borderColor: genStep >= 1 ? 'rgba(6,182,212,.5)' : 'var(--border-dim)',
              color: genStep >= 1 ? 'var(--cyan)' : 'var(--text-muted)',
            }}
          >
            {submittingMK ? '⟳ GENERATING MK…' : (() => {
              const n = sampledMk ? countItems(sampledMk) : (markets?.probeResult ? '?' : 0);
              return `② SUBMIT MARKETS${n ? ` (${n} items)` : ''}`;
            })()}
          </button>
        )}

        {/* STEP 3: Submit combined */}
        <button
          onClick={handleSubmitCombined}
          disabled={isSubmitting || (isPair ? genStep < 2 : genStep < 1)}
          title={isPair && genStep < 2 ? 'Submit markets first (Step 2)' : !isPair && genStep < 1 ? 'Submit match list first (Step 1)' : ''}
          style={{
            ...s.btnGhost,
            opacity: (isSubmitting || (isPair ? genStep < 2 : genStep < 1)) ? .4 : 1,
            borderColor: (isPair ? genStep >= 2 : genStep >= 1) ? 'rgba(216,180,254,.5)' : 'var(--border-dim)',
            color: (isPair ? genStep >= 2 : genStep >= 1) ? '#d8b4fe' : 'var(--text-muted)',
          }}
        >
          {submittingCombined ? '⟳ COMBINING…' : `③ SUBMIT COMBINED`}
        </button>

        {/* Validate + Approve */}
        {hasCode && (
          <>
            <button onClick={handleTest} disabled={testing || isSubmitting} style={{ ...s.btnGhost, opacity: (testing || isSubmitting) ? .5 : 1 }}>
              {testing ? '⟳' : '▶ VALIDATE'}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || isSubmitting || !canSave}
              title={!canSave ? (isPair ? 'Step 3 must pass before saving' : 'Contract must pass before saving') : ''}
              style={{ ...s.btnApprove, opacity: (saving || isSubmitting || !canSave) ? .4 : 1 }}
            >
              {saving ? 'SAVING…' : `✓ APPROVE & SAVE${isPair ? ' BOTH' : ''}`}
            </button>
          </>
        )}
      </div>

      {/* ── Gen step tracker ── */}
      {isPair && <GenStepBar step={genStep} />}

      {/* ── Stage pipeline ── */}
      {!isSubmitting && <StagePipeline stages={stages} />}

      {/* ── Warnings ── */}
      {!isSubmitting && warnings.length > 0 && <WarningsBanner warnings={warnings} />}

      {/* ── Main 4-column grid ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isPair ? '1fr 1fr 1fr 1fr' : '1fr 1fr',
        gap: 1, background: 'var(--border-dim)',
        height: 'calc(100vh - 380px)',
      }}>

        {/* Col 1: Match list response + sampler */}
        <div style={{ background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={s.colHead}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--acid)' }}>MATCH LIST RESPONSE</span>
              {matchList.probeResult && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{fmtKb(matchList.probeResult.size_bytes)}</span>}
            </div>
            <StatusPill status={matchList.probeResult?.status ?? null} />
          </div>
          {matchList.probeResult
            ? <ResponseSampler
                raw={matchList.probeResult.response_raw}
                accent="var(--acid)"
                label="match list"
                onSampleChange={setSampledMl}
              />
            : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>—</span>
              </div>
          }
        </div>

        {/* Col 2: Match list parser */}
        <CodeCol
          title="① MATCH LIST PARSER" accent="#a8ff78"
          code={mlCode} onChange={v => { setMlCode(v); setMlContract(emptyContract()); }}
          contract={mlContract}
          isLoading={submittingML} isStreaming={false}
          tier={mlTier} strategy={mlStrategy}
          lintStatus={mlLintStatus} lintFixes={mlLintFixes}
          rounds={mlRounds} currentRound={mlCurrentRound}
          onRestoreRound={(code, round) => { setMlCode(code); setMlCurrentRound(round); setMlContract(emptyContract()); }}
        />

        {isPair && (
          <>
            {/* Col 3: Markets response + sampler */}
            <div style={{ background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={s.colHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--cyan)' }}>MARKETS RESPONSE</span>
                  {markets?.probeResult && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{fmtKb(markets.probeResult.size_bytes)}</span>}
                </div>
                <StatusPill status={markets?.probeResult?.status ?? null} />
              </div>
              {markets?.probeResult
                ? <ResponseSampler
                    raw={markets.probeResult.response_raw}
                    accent="var(--cyan)"
                    label="markets"
                    onSampleChange={setSampledMk}
                  />
                : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>—</span>
                  </div>
              }
            </div>

            {/* Col 4: Markets parser */}
            <CodeCol
              title="② MARKETS PARSER" accent="var(--cyan)"
              code={mkCode} onChange={v => { setMkCode(v); setMkContract(emptyContract()); }}
              contract={mkContract}
              isLoading={submittingMK} isStreaming={false}
              tier={mkTier} strategy={mkStrategy}
              lintStatus={mkLintStatus} lintFixes={mkLintFixes}
              rounds={mkRounds} currentRound={mkCurrentRound}
              onRestoreRound={(code, round) => { setMkCode(code); setMkCurrentRound(round); setMkContract(emptyContract()); }}
            />
          </>
        )}
      </div>

      {/* ── Combined parser panel ── */}
      {isPair && (
        <CombinedParserPanel
          code={combinedCode}
          contractPassed={combinedContract.passed}
          runError={combinedRunError}
          rowErrors={combinedRowErrors}
          totalRows={totalCombinedRows}
          combinedRaw={combinedRaw}
          fallbackUsed={fallbackUsed}
          isLoading={submittingCombined}
          onChange={v => { setCombinedCode(v); setCombinedContract(emptyContract()); setCombinedRunError(null); setCombinedRowErrors([]); }}
        />
      )}

      {/* ── Output panel ── */}
      <div style={{ borderTop: '1px solid var(--border-dim)', background: 'var(--bg-elevated)' }}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-dim)' }}>
          {([
            { id: 'combined', label: 'COMBINED OUTPUT' },
            { id: 'grouped',  label: 'GROUPED VIEW'   },
            { id: 'matches',  label: 'MATCH ROWS'     },
            { id: 'markets',  label: 'MARKET ROWS'    },
          ] as const).map(({ id, label }) => (
            <button key={id} onClick={() => setOutTab(id)} style={{
              ...s.tabBtn, fontSize: 7,
              color: outTab === id ? 'var(--acid)' : 'var(--text-muted)',
              borderBottomColor: outTab === id ? 'var(--acid)' : 'transparent',
            }}>
              {label}
              {id === 'combined' && totalCombinedRows > 0 && <span style={{ marginLeft: 6, color: combinedContract.passed ? 'var(--acid)' : 'var(--red)', fontSize: 8 }}>({totalCombinedRows})</span>}
              {id === 'grouped'  && grouped.length   > 0 && <span style={{ marginLeft: 6, color: 'var(--acid)', fontSize: 8 }}>({grouped.length})</span>}
              {id === 'matches'  && mlRows.length    > 0 && <span style={{ marginLeft: 6, color: 'var(--acid)', fontSize: 8 }}>({mlRows.length})</span>}
              {id === 'markets'  && mkRows.length    > 0 && <span style={{ marginLeft: 6, color: 'var(--cyan)', fontSize: 8 }}>({mkRows.length})</span>}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', padding: '6px 14px', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <span style={{ color: 'rgba(198,241,53,.4)', letterSpacing: 1 }}>REQUIRED:</span>
            {REQUIRED_KEYS.map(k => <span key={k} style={{ color: 'rgba(198,241,53,.3)' }}>{k}</span>)}
          </div>
        </div>

        <div style={{ maxHeight: 220, overflow: 'auto' }}>
          {!hasCode
            ? <div style={{ padding: '24px', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 2, textAlign: 'center' as const }}>
                OUTPUT WILL APPEAR AFTER PARSER IS GENERATED
              </div>
            : (() => {
                const outRaw =
                  outTab === 'combined' ? (combinedRaw || '[]')
                  : outTab === 'grouped'  ? (groupedRaw || '[]')
                  : outTab === 'matches'  ? JSON.stringify(mlRows.slice(0, 5), null, 2)
                  : JSON.stringify(mkRows.slice(0, 5), null, 2);
                return <JsonPanel raw={outRaw} accent="#78d5ff" editable={false} maxHeight={220} />;
              })()
          }
        </div>

        {outTab === 'combined' && combinedContract.passed === false && (
          <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(255,61,90,.2)' }}>
            {combinedRunError && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)', padding: '6px 0' }}>{combinedRunError}</div>
            )}
            <ContractErrors errors={combinedRowErrors} title="Combined parser output failed agent contract" />
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      {hasCode && !isSubmitting && (
        <div style={{ padding: '8px 0', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1, lineHeight: 1.8 }}>
          ℹ Edit parsers inline · <strong style={{ color: 'var(--acid)' }}>▶ VALIDATE</strong> re-runs contract checks ·{' '}
          <strong style={{ color: canSave ? 'var(--acid)' : 'var(--text-muted)' }}>✓ APPROVE & SAVE</strong>{' '}
          {canSave ? 'ready — all contracts passed.' : isPair ? 'blocked until Step 3 passes.' : 'blocked until contract passes.'}
          {isPair && combinedCode && <span> Combined <code>parse_data(ml, mk)</code> is what agents will call.</span>}
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        textarea:focus, input:focus, select:focus { outline:none; border-color:rgba(198,241,53,.4)!important; }
      `}</style>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EndpointResearch() {
  const [step,       setStep]       = useState<Step>(1);
  const [bookmakers, setBookmakers] = useState<BookmakerOption[]>([]);
  const [sports,     setSports]     = useState<SportOption[]>([]);
  const [reqTypes,   setReqTypes]   = useState<string[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [toast,      setToast]      = useState('');
  const [handoff,    setHandoff]    = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth('/research/meta');
        if (res.ok) { const d = await res.json(); setBookmakers(d.bookmakers); setSports(d.sports ?? []); setReqTypes(d.request_types); }
      } catch { setToast('✗ Could not load metadata'); }
      finally { setLoading(false); }
    })();
  }, []);

  const handleSaved = (mlId: number, mkId?: number) => {
    setToast(`✓ Saved${mkId ? ` #${mlId} + #${mkId}` : ` #${mlId}`}. Going to Endpoint Manager…`);
    setTimeout(() => { window.location.href = '/dashboard/endpoints'; }, 2000);
  };

  return (
    <div style={s.root}>
      <Toast msg={toast} onClear={() => setToast('')} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h1 style={s.pageTitle}>ENDPOINT RESEARCH</h1>
          <p style={s.pageSubtitle}>BUILD · PROBE · 4-STAGE AI PIPELINE · CONTRACT VALIDATE · APPROVE</p>
        </div>
        <a href="/dashboard/endpoints" style={s.btnSecondary}>ENDPOINT MANAGER →</a>
      </div>
      <StepBar step={step} />
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--acid)', letterSpacing: 4 }}>LOADING…</span>
        </div>
      ) : step === 1 ? (
        <Step1 bookmakers={bookmakers} sports={sports} requestTypes={reqTypes} onNext={d => { setHandoff(d); setStep(2); }} />
      ) : handoff ? (
        <Step2 bookmarkerId={handoff.bookmarkerId} bookmarkerName={handoff.bookmarkerName} sportName={handoff.sportName} endpointType={handoff.endpointType} matchList={handoff.matchList} markets={handoff.markets} onBack={() => setStep(1)} onSaved={handleSaved} />
      ) : null}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:         { display: 'flex', flexDirection: 'column', gap: 0 },
  pageTitle:    { fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: 3, margin: 0 },
  pageSubtitle: { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, color: 'var(--text-muted)', marginTop: 4 },
  fieldWrap:    { display: 'flex', flexDirection: 'column', gap: 4 },
  label:        { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' },
  input:        { width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '7px 11px', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none' },
  miniInput:    { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none' },
  codePre:      { margin: 0, padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  colHead:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' },
  tabBtn:       { background: 'none', border: 'none', borderBottom: '2px solid', marginBottom: -1, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  iconBtn:      { background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, padding: '4px 7px', cursor: 'pointer', flexShrink: 0 },
  addBtn:       { background: 'none', border: '1px dashed var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, padding: '3px 10px', cursor: 'pointer', marginTop: 3 },
  btnPrimary:   { background: 'var(--acid)', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: 2, padding: '8px 16px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnGhost:     { background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1, padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnSecondary: { display: 'inline-block', textDecoration: 'none', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-base)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, padding: '8px 16px', whiteSpace: 'nowrap' as const },
  btnAi:        { background: 'rgba(198,241,53,.08)', border: '1px solid rgba(198,241,53,.4)', color: 'var(--acid)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '8px 18px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnApprove:   { background: 'rgba(198,241,53,.15)', border: '1px solid var(--acid)', color: 'var(--acid)', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: 2, padding: '8px 18px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
};