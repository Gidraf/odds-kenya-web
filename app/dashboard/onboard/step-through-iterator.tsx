/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * StepThroughIterator
 * ════════════════════
 * Replaces the auto-fire iteration in the onboarding wizard.
 * User controls each probe manually: inspect response → accept → next.
 *
 * Usage (sport iteration):
 *   <StepThroughIterator
 *     title="ITERATE SPORTS"
 *     items={sportMappings.map(sm => ({
 *       id:    sm.bk_sport_id,
 *       label: sm.our_sport_name ?? sm.bk_sport_id,
 *       meta:  sm,
 *     }))}
 *     buildRequest={(item) => ({
 *       url:     listUrlTemplate.replace('{{sport_id}}', item.id),
 *       method:  'GET',
 *       headers: sessionHeaders,
 *       params:  { ...baseParams, sport: item.id },
 *     })}
 *     onItemAccepted={(item, result) => handleSportResult(item, result)}
 *     onComplete={(results) => finaliseSportPhase(results)}
 *   />
 *
 * Usage (market iteration):
 *   <StepThroughIterator
 *     title="ITERATE MARKETS"
 *     items={matchList.slice(0, limit).map(m => ({
 *       id:    m.match_id,
 *       label: `${m.home_team} v ${m.away_team}`,
 *       meta:  m,
 *     }))}
 *     buildRequest={(item) => ({
 *       url:     marketsUrl.replace('{{match_id}}', item.id),
 *       method:  'GET',
 *       headers: sessionHeaders,
 *       params:  baseParams,
 *     })}
 *     onItemAccepted={(item, result) => handleMarketResult(item, result)}
 *     onComplete={(results) => finaliseMarketsPhase(results)}
 *   />
 */

import { useState, useRef, useCallback } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IteratorItem {
  id:    string | number;
  label: string;
  meta?: Record<string, unknown>;  // original object (sport mapping, match item, etc.)
}

export interface ProbeRequest {
  url:      string;
  method?:  string;
  headers?: Record<string, string>;
  params?:  Record<string, string>;
  body?:    string | null;
}

export interface ProbeResult {
  ok:           boolean;
  status:       number | null;
  latency_ms:   number | null;
  parsed:       unknown;
  first_item:   unknown;
  array_key:    string | null;
  array_length: number;
  size_bytes:   number;
  error:        string | null;
  curl:         string;
}

export interface ItemResult {
  item:    IteratorItem;
  request: ProbeRequest;
  result:  ProbeResult;
  accepted: boolean;  // true = user accepted, false = user skipped
}

interface Props {
  title:           string;
  accent?:         string;         // CSS colour, default var(--acid)
  items:           IteratorItem[];
  buildRequest:    (item: IteratorItem) => ProbeRequest;
  onItemAccepted?: (item: IteratorItem, result: ProbeResult) => void;
  onItemSkipped?:  (item: IteratorItem, result: ProbeResult) => void;
  onComplete?:     (results: ItemResult[]) => void;
  probeEndpoint?:  string;         // default /research/probe
}

type ItemStatus = 'pending' | 'probing' | 'done' | 'accepted' | 'skipped';

interface ItemState {
  status:  ItemStatus;
  result:  ProbeResult | null;
  request: ProbeRequest | null;
}

// ─── Shared mini styles ───────────────────────────────────────────────────────

const mono = (size = 9, color = 'var(--text-primary)'): React.CSSProperties => ({
  fontFamily: 'var(--font-mono)', fontSize: size, color,
});

const btn = (bg: string, fg: string, border?: string): React.CSSProperties => ({
  fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, fontWeight: 700,
  padding: '8px 18px', cursor: 'pointer', whiteSpace: 'nowrap',
  background: bg, color: fg,
  border: `1px solid ${border ?? bg}`,
});

// ─── JsonTree (inline, light version) ────────────────────────────────────────

function JsonTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [c, setC] = useState(depth > 1);
  if (data === null)             return <span style={mono(9, 'rgba(198,241,53,.45)')}>null</span>;
  if (typeof data === 'boolean') return <span style={mono(9, 'rgba(6,182,212,.8)')}>{String(data)}</span>;
  if (typeof data === 'number')  return <span style={mono(9, 'rgba(251,146,60,.9)')}>{data}</span>;
  if (typeof data === 'string')  return <span style={mono(9, 'rgba(167,243,208,.85)')} title={data}>"{data.length > 80 ? data.slice(0, 80) + '…' : data}"</span>;
  if (Array.isArray(data)) {
    if (!data.length) return <span style={mono(9, 'var(--text-muted)')}>[]</span>;
    return (
      <span>
        <span onClick={() => setC(x => !x)} style={{ ...mono(9, 'var(--text-muted)'), cursor: 'pointer', userSelect: 'none' }}>
          {c ? `▶ [${data.length}]` : '▾ ['}
        </span>
        {!c && (
          <div style={{ marginLeft: depth * 14 + 14 }}>
            {data.slice(0, 20).map((it, i) => <div key={i}><JsonTree data={it} depth={depth + 1} /></div>)}
            {data.length > 20 && <div style={mono(9, 'var(--text-muted)')}>…{data.length - 20} more</div>}
            <span style={mono(9, 'var(--text-muted)')}>]</span>
          </div>
        )}
      </span>
    );
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data as object);
    if (!keys.length) return <span style={mono(9, 'var(--text-muted)')}>{'{}'}</span>;
    return (
      <span>
        <span onClick={() => setC(x => !x)} style={{ ...mono(9, 'var(--text-muted)'), cursor: 'pointer', userSelect: 'none' }}>
          {c ? `▶ {${keys.length}}` : '▾ {'}
        </span>
        {!c && (
          <div style={{ marginLeft: depth * 14 + 14 }}>
            {keys.map((k, i) => (
              <div key={k} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <span style={mono(9, 'rgba(130,180,255,.8)')}>"{k}"</span>
                <span style={mono(9, 'var(--text-muted)')}>: </span>
                <JsonTree data={(data as Record<string, unknown>)[k]} depth={depth + 1} />
                {i < keys.length - 1 && <span style={mono(9, 'var(--text-muted)')}>,</span>}
              </div>
            ))}
            <span style={mono(9, 'var(--text-muted)')}></span>
          </div>
        )}
      </span>
    );
  }
  return <span style={mono(9)}>{String(data)}</span>;
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, httpStatus }: { status: ItemStatus; httpStatus?: number | null }) {
  const map: Record<ItemStatus, { label: string; color: string }> = {
    pending:  { label: '○ PENDING',  color: 'var(--text-muted)' },
    probing:  { label: '⟳ PROBING', color: 'rgba(251,146,60,.9)' },
    done:     { label: httpStatus ? `${httpStatus}` : '— DONE', color: httpStatus && httpStatus < 300 ? 'var(--acid)' : 'var(--red)' },
    accepted: { label: '✓ ACCEPTED', color: 'var(--acid)' },
    skipped:  { label: '— SKIPPED',  color: 'var(--text-muted)' },
  };
  const { label, color } = map[status];
  return (
    <span style={{ ...mono(8, color), border: `1px solid ${color}44`, padding: '1px 8px', letterSpacing: 1 }}>
      {label}
    </span>
  );
}

// ─── ItemRow — sidebar item in the list ──────────────────────────────────────

function ItemRow({ item, state, isCurrent, onClick }: {
  item:      IteratorItem;
  state:     ItemState;
  isCurrent: boolean;
  onClick:   () => void;
}) {
  const accent =
    state.status === 'accepted' ? 'var(--acid)' :
    state.status === 'skipped'  ? 'var(--text-muted)' :
    state.status === 'probing'  ? 'rgba(251,146,60,.9)' :
    state.status === 'done'     ? (state.result?.ok ? 'var(--acid)' : 'var(--red)') :
    'var(--text-muted)';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        background: isCurrent ? 'rgba(198,241,53,.07)' : 'transparent',
        borderLeft: `3px solid ${isCurrent ? 'var(--acid)' : 'transparent'}`,
        borderBottom: '1px solid var(--border-dim)',
        cursor: 'pointer', transition: 'background .1s',
      }}
      onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'rgba(255,255,255,.03)'; }}
      onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Status dot */}
      <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: accent, opacity: state.status === 'pending' ? .3 : 1 }} />

      {/* Label */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...mono(9, isCurrent ? 'var(--acid)' : 'var(--text-primary)'), fontWeight: isCurrent ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </div>
        <div style={mono(7, 'var(--text-muted)')}>
          {String(item.id)}
        </div>
      </div>

      {/* Stats when done */}
      {(state.status === 'done' || state.status === 'accepted' || state.status === 'skipped') && state.result && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          {state.result.array_length > 0 && (
            <span style={mono(7, 'rgba(198,241,53,.6)')}>{state.result.array_length} items</span>
          )}
          {state.result.latency_ms !== null && (
            <span style={mono(7, 'var(--text-muted)')}>{state.result.latency_ms}ms</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StepThroughIterator({
  title,
  accent = 'var(--acid)',
  items,
  buildRequest,
  onItemAccepted,
  onItemSkipped,
  onComplete,
  probeEndpoint = '/research/probe',
}: Props) {
  const [states,  setStates]  = useState<Record<string | number, ItemState>>(
    () => Object.fromEntries(items.map(it => [it.id, { status: 'pending', result: null, request: null }]))
  );
  const [cursor,     setCursor]     = useState<number>(0);           // index into items[]
  const [started,    setStarted]    = useState(false);
  const [finished,   setFinished]   = useState(false);
  const [viewRaw,    setViewRaw]    = useState(false);
  const [viewCurl,   setViewCurl]   = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const current = items[cursor] ?? null;
  const curState: ItemState = current ? (states[current.id] ?? { status: 'pending', result: null, request: null }) : { status: 'pending', result: null, request: null };

  const acceptedCount = items.filter(it => states[it.id]?.status === 'accepted').length;
  const skippedCount  = items.filter(it => states[it.id]?.status === 'skipped').length;
  const doneCount     = items.filter(it => ['accepted', 'skipped', 'done'].includes(states[it.id]?.status ?? '')).length;

  // ── Patch one item's state ────────────────────────────────────────────────
  const patch = useCallback((id: string | number, p: Partial<ItemState>) => {
    setStates(prev => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }, []);

  // ── Probe current item ────────────────────────────────────────────────────
  const probe = useCallback(async () => {
    if (!current || curState.status === 'probing') return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const req = buildRequest(current);
    patch(current.id, { status: 'probing', request: req, result: null });

    try {
      const res = await fetchWithAuth(probeEndpoint, {
        method:  'POST',
        signal:  ctrl.signal,
        body:    JSON.stringify({
          url:     req.url,
          method:  req.method  ?? 'GET',
          headers: req.headers ?? {},
          params:  req.params  ?? {},
          body:    req.body    ?? null,
        }),
      });
      const data: ProbeResult = await res.json();
      patch(current.id, { status: 'done', result: data });
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      patch(current.id, {
        status: 'done',
        result: {
          ok: false, status: null, latency_ms: null,
          parsed: null, first_item: null, array_key: null,
          array_length: 0, size_bytes: 0,
          error: e.message ?? 'Network error',
          curl: '',
        },
      });
    }
  }, [current, curState.status, buildRequest, patch, probeEndpoint]);

  // ── Accept current result and advance ─────────────────────────────────────
  const accept = useCallback(() => {
    if (!current || !curState.result) return;
    patch(current.id, { status: 'accepted' });
    onItemAccepted?.(current, curState.result);
    advance();
  }, [current, curState.result, patch, onItemAccepted]);

  // ── Skip current item ─────────────────────────────────────────────────────
  const skip = useCallback(() => {
    if (!current) return;
    const result = curState.result ?? { ok: false, status: null, latency_ms: null, parsed: null, first_item: null, array_key: null, array_length: 0, size_bytes: 0, error: 'skipped', curl: '' };
    patch(current.id, { status: 'skipped', result });
    onItemSkipped?.(current, result);
    advance();
  }, [current, curState.result, patch, onItemSkipped]);

  // ── Move to next item ─────────────────────────────────────────────────────
  const advance = useCallback(() => {
    const next = cursor + 1;
    if (next >= items.length) {
      setFinished(true);
      // Fire onComplete with all accepted results
      const results: ItemResult[] = items.map(it => {
        const st = states[it.id];
        return {
          item:     it,
          request:  st?.request ?? buildRequest(it),
          result:   st?.result  ?? { ok: false, status: null, latency_ms: null, parsed: null, first_item: null, array_key: null, array_length: 0, size_bytes: 0, error: 'not run', curl: '' },
          accepted: st?.status === 'accepted',
        };
      });
      onComplete?.(results);
    } else {
      setCursor(next);
      setViewRaw(false);
      setViewCurl(false);
    }
  }, [cursor, items, states, buildRequest, onComplete]);

  // ── Jump to a specific item ───────────────────────────────────────────────
  const jumpTo = useCallback((idx: number) => {
    setCursor(idx);
    setViewRaw(false);
    setViewCurl(false);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────

  const accentBorder = `${accent}44`;
  const accentBg     = `${accent}0d`;

  // ── NOT STARTED ───────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div style={{ border: `1px solid ${accentBorder}`, background: accentBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${accentBorder}` }}>
          <span style={{ ...mono(11, accent), fontWeight: 800, letterSpacing: 3 }}>{title}</span>
          <span style={mono(8, 'var(--text-muted)')}>MANUAL STEP-THROUGH · {items.length} ITEM{items.length !== 1 ? 'S' : ''}</span>
        </div>
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Preview list */}
          <div style={{ border: '1px solid var(--border-dim)', maxHeight: 200, overflowY: 'auto' }}>
            {items.map((it, i) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border-dim)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.02)' }}>
                <span style={mono(7, 'var(--text-muted)')}>{i + 1}</span>
                <span style={mono(9, 'var(--text-secondary)')}>{it.label}</span>
                <span style={{ ...mono(8, 'var(--text-muted)'), marginLeft: 'auto' }}>{String(it.id)}</span>
              </div>
            ))}
          </div>
          <div style={mono(8, 'var(--text-muted)')}>
            ↳ You will probe each item one at a time. Review the response, then accept or skip before moving to the next.
          </div>
          <button
            onClick={() => setStarted(true)}
            disabled={items.length === 0}
            style={{ ...btn(accent, '#0a0a0a'), alignSelf: 'flex-start', opacity: items.length > 0 ? 1 : .4 }}
          >
            ▶ START ITERATION
          </button>
        </div>
      </div>
    );
  }

  // ── FINISHED ──────────────────────────────────────────────────────────────
  if (finished) {
    return (
      <div style={{ border: `1px solid ${accentBorder}`, background: accentBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${accentBorder}` }}>
          <span style={{ ...mono(11, accent), fontWeight: 800, letterSpacing: 3 }}>✓ {title} COMPLETE</span>
        </div>
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Summary table */}
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 16px', border: `1px solid ${accentBorder}`, background: 'rgba(198,241,53,.04)' }}>
              <span style={mono(7, 'var(--text-muted)')}>ACCEPTED</span>
              <span style={{ ...mono(20, accent), fontWeight: 800 }}>{acceptedCount}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 16px', border: '1px solid var(--border-dim)' }}>
              <span style={mono(7, 'var(--text-muted)')}>SKIPPED</span>
              <span style={{ ...mono(20, 'var(--text-muted)'), fontWeight: 800 }}>{skippedCount}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 16px', border: '1px solid var(--border-dim)' }}>
              <span style={mono(7, 'var(--text-muted)')}>TOTAL</span>
              <span style={{ ...mono(20, 'var(--text-secondary)'), fontWeight: 800 }}>{items.length}</span>
            </div>
          </div>
          {/* Per-item result list */}
          <div style={{ border: '1px solid var(--border-dim)', maxHeight: 220, overflowY: 'auto' }}>
            {items.map(it => {
              const st = states[it.id];
              return (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border-dim)' }}>
                  <span style={{ ...mono(9, st?.status === 'accepted' ? 'var(--acid)' : 'var(--text-muted)'), flexShrink: 0 }}>
                    {st?.status === 'accepted' ? '✓' : st?.status === 'skipped' ? '—' : '?'}
                  </span>
                  <span style={mono(9, 'var(--text-primary)')}>{it.label}</span>
                  {st?.result?.array_length != null && st.result.array_length > 0 && (
                    <span style={{ ...mono(8, 'rgba(198,241,53,.6)'), marginLeft: 'auto' }}>{st.result.array_length} items</span>
                  )}
                  {st?.result?.latency_ms != null && (
                    <span style={mono(8, 'var(--text-muted)')}>{st.result.latency_ms}ms</span>
                  )}
                  {st?.result?.error && (
                    <span style={{ ...mono(8, 'var(--red)'), marginLeft: 'auto' }}>✗ {st.result.error}</span>
                  )}
                </div>
              );
            })}
          </div>
          <button onClick={() => { setStarted(false); setFinished(false); setCursor(0); setStates(Object.fromEntries(items.map(it => [it.id, { status: 'pending', result: null, request: null }]))); }}
            style={{ ...btn('transparent', 'var(--text-muted)', 'var(--border-dim)'), alignSelf: 'flex-start', fontSize: 8 }}>
            ↺ RESET
          </button>
        </div>
      </div>
    );
  }

  // ── MAIN ITERATION UI ─────────────────────────────────────────────────────
  const result = curState.result;
  const isProbing = curState.status === 'probing';
  const hasDone   = curState.status === 'done';

  return (
    <div style={{ border: `1px solid ${accentBorder}`, background: 'var(--bg-surface)' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', background: accentBg, borderBottom: `1px solid ${accentBorder}` }}>
        <span style={{ ...mono(10, accent), fontWeight: 800, letterSpacing: 2 }}>{title}</span>
        <span style={{ ...mono(8, 'var(--text-muted)'), marginLeft: 4 }}>
          {cursor + 1} / {items.length}
        </span>
        {/* Progress bar */}
        <div style={{ flex: 1, height: 3, background: 'var(--border-dim)', position: 'relative' as const }}>
          <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(doneCount / items.length) * 100}%`, background: accent, transition: 'width .3s' }} />
        </div>
        <span style={mono(7, 'var(--text-muted)')}>{acceptedCount} accepted · {skippedCount} skipped</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', minHeight: 400 }}>

        {/* ── Sidebar — item list ── */}
        <div style={{ borderRight: '1px solid var(--border-dim)', overflowY: 'auto', maxHeight: 600 }}>
          {items.map((it, i) => (
            <ItemRow
              key={it.id}
              item={it}
              state={states[it.id] ?? { status: 'pending', result: null, request: null }}
              isCurrent={i === cursor}
              onClick={() => jumpTo(i)}
            />
          ))}
        </div>

        {/* ── Main panel ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* Current item header */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...mono(12, 'var(--text-primary)'), fontWeight: 700 }}>{current?.label}</div>
              <div style={mono(8, 'var(--text-muted)')}>{String(current?.id)}</div>
            </div>
            <StatusBadge status={curState.status} httpStatus={result?.status} />
          </div>

          {/* Request URL preview */}
          {curState.request && (
            <div style={{ padding: '8px 16px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...mono(7, 'var(--text-muted)'), letterSpacing: 2 }}>REQUEST</span>
              <span style={{ ...mono(8, 'var(--cyan)'), flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={curState.request.url}>
                {curState.request.method ?? 'GET'} {curState.request.url}
              </span>
              {result?.latency_ms != null && (
                <span style={mono(8, 'var(--text-muted)')}>{result.latency_ms}ms</span>
              )}
              {result?.size_bytes != null && result.size_bytes > 0 && (
                <span style={mono(8, 'var(--text-muted)')}>{(result.size_bytes / 1024).toFixed(1)} KB</span>
              )}
            </div>
          )}

          {/* Response area */}
          <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Error */}
            {hasDone && result && !result.ok && (
              <div style={{ padding: '10px 14px', background: 'rgba(255,61,90,.04)', border: '1px solid rgba(255,61,90,.25)', ...mono(9, 'var(--red)') }}>
                ✗ {result.error ?? `HTTP ${result.status}`}
              </div>
            )}

            {/* Response tabs */}
            {hasDone && result && result.parsed !== null && (
              <div>
                {/* Tab bar */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 8, gap: 0 }}>
                  {([
                    ['tree', 'RESPONSE TREE'],
                    ['raw',  'RAW JSON'],
                    ['curl', 'CURL'],
                  ] as [string, string][]).map(([t, lbl]) => {
                    const active = t === 'curl' ? viewCurl : t === 'raw' ? (viewRaw && !viewCurl) : (!viewRaw && !viewCurl);
                    return (
                      <button key={t}
                        onClick={() => { if (t === 'curl') { setViewCurl(true); setViewRaw(false); } else if (t === 'raw') { setViewRaw(true); setViewCurl(false); } else { setViewRaw(false); setViewCurl(false); } }}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, padding: '6px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${active ? accent : 'transparent'}`, marginBottom: -1, color: active ? accent : 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                      >{lbl}</button>
                    );
                  })}
                  {/* Array info pill */}
                  {result.array_length > 0 && (
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ ...mono(8, accent), border: `1px solid ${accentBorder}`, padding: '2px 8px', letterSpacing: 1 }}>
                        {result.array_length} items{result.array_key ? ` @ ${result.array_key}` : ''}
                      </span>
                    </div>
                  )}
                </div>

                {/* Tree view */}
                {!viewRaw && !viewCurl && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {/* Full response */}
                    <div>
                      <div style={{ ...mono(7, 'var(--text-muted)'), letterSpacing: 2, marginBottom: 5 }}>FULL RESPONSE</div>
                      <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 300, overflowY: 'auto' }}>
                        <JsonTree data={result.parsed} />
                      </div>
                    </div>
                    {/* First item */}
                    <div>
                      <div style={{ ...mono(7, 'var(--text-muted)'), letterSpacing: 2, marginBottom: 5 }}>
                        FIRST ITEM{result.array_key ? ` (${result.array_key}[0])` : ''}
                      </div>
                      <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '8px 10px', maxHeight: 300, overflowY: 'auto' }}>
                        {result.first_item
                          ? <JsonTree data={result.first_item} />
                          : <span style={mono(8, 'var(--text-muted)')}>No array found in response</span>}
                      </div>
                    </div>
                  </div>
                )}

                {/* Raw JSON */}
                {viewRaw && !viewCurl && (
                  <div style={{ background: 'rgba(6,10,6,.9)', border: '1px solid var(--border-dim)', padding: '10px 12px', maxHeight: 340, overflowY: 'auto' }}>
                    <pre style={{ margin: 0, ...mono(9, 'rgba(167,243,208,.8)'), whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.6 }}>
                      {JSON.stringify(result.parsed, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Curl */}
                {viewCurl && (
                  <div style={{ background: 'rgba(6,10,6,.9)', border: '1px solid var(--border-dim)', padding: '10px 12px', maxHeight: 200, overflowY: 'auto' }}>
                    <pre style={{ margin: 0, ...mono(8, 'rgba(167,243,208,.8)'), whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const, lineHeight: 1.6 }}>
                      {result.curl || '(no curl captured)'}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Idle state */}
            {curState.status === 'pending' && !isProbing && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: .4 }}>
                <span style={mono(9, 'var(--text-muted)')}>↓ Click PROBE to fire the request</span>
              </div>
            )}

            {/* Probing spinner */}
            {isProbing && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                <span style={{ ...mono(11, 'rgba(251,146,60,.9)'), display: 'inline-block', animation: 'spin .7s linear infinite' }}>⟳</span>
                <span style={mono(9, 'rgba(251,146,60,.9)')}>Probing…</span>
              </div>
            )}
          </div>

          {/* ── Action bar ── */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-dim)', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-elevated)' }}>

            {/* Probe button */}
            {(curState.status === 'pending' || curState.status === 'done') && (
              <button
                onClick={probe}
                disabled={isProbing}
                style={{ ...btn(accent, '#0a0a0a'), fontSize: 9 }}
              >
                {curState.status === 'done' ? '↺ RE-PROBE' : '▶ PROBE'}
              </button>
            )}

            {isProbing && (
              <button onClick={() => abortRef.current?.abort()}
                style={{ ...btn('transparent', 'var(--red)', 'rgba(255,61,90,.4)') }}>
                ■ ABORT
              </button>
            )}

            <div style={{ flex: 1 }} />

            {/* Skip — always available */}
            <button
              onClick={skip}
              disabled={isProbing}
              style={{ ...btn('transparent', 'var(--text-muted)', 'var(--border-dim)'), opacity: isProbing ? .4 : 1, fontSize: 8 }}
            >
              SKIP →
            </button>

            {/* Accept — only when we have a good result */}
            {hasDone && result?.ok && (
              <button
                onClick={accept}
                style={{ ...btn('rgba(198,241,53,.15)', accent, `${accent}66`), letterSpacing: 2 }}
              >
                ✓ ACCEPT & {cursor < items.length - 1 ? 'NEXT →' : 'FINISH'}
              </button>
            )}

            {/* Accept anyway — bad response but user still wants to proceed */}
            {hasDone && !result?.ok && (
              <button
                onClick={accept}
                style={{ ...btn('rgba(251,146,60,.1)', '#fb923c', 'rgba(251,146,60,.4)'), fontSize: 8 }}
              >
                ACCEPT ANYWAY & {cursor < items.length - 1 ? 'NEXT →' : 'FINISH'}
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
      `}</style>
    </div>
  );
}