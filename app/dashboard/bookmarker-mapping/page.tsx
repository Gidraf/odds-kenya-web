'use client';
/**
 * SmartPathMapper.tsx
 * ═══════════════════
 * Drag-and-drop JSON path mapping tool.
 *
 * Features
 * ────────
 * • Paste / fetch live JSON → interactive explorer tree
 * • Drag any JSON node → drop onto a path field → path auto-populated
 * • Click a node → inspect value + path shown in status bar
 * • Smart suggestions: if bookmaker already has path config saved,
 *   pre-populate fields that match known structural patterns
 * • Market alias panel: pick a canonical market, drag the JSON key
 *   that represents it → alias auto-created
 * • Highlights all array-traversal points with [] notation
 * • Live preview row extraction as paths are filled
 */

import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EndpointMap {
  id?: number;
  bookmaker_id: number;
  bookmaker_name?: string;
  endpoint_type: string;
  curl_template?: string;
  sample_response?: string;
  match_list_array_path?: string;
  match_id_path?: string;
  home_team_path?: string;
  away_team_path?: string;
  start_time_path?: string;
  sport_path?: string;
  competition_path?: string;
  markets_array_path?: string;
  market_name_path?: string;
  specifier_path?: string;
  selections_array_path?: string;
  selection_name_path?: string;
  selection_price_path?: string;
}

interface Market { id: number; name: string; slug: string }
interface Bookmaker { id: number; name: string; domain: string }

interface PathField {
  key: keyof EndpointMap;
  label: string;
  hint: string;
  group: 'match' | 'market';
  example?: string;
}

// Drag context
interface DragState { path: string; value: unknown; isArray: boolean }
const DragCtx = createContext<{
  dragging: DragState | null;
  setDragging: (d: DragState | null) => void;
}>({ dragging: null, setDragging: () => {} });

const BASE = '/admin/mapping';
const apiFetch = (p: string, opts?: RequestInit) =>
  fetchWithAuth(`${BASE}${p}`, opts).then(r => r.json());

// ─── Path utils ───────────────────────────────────────────────────────────────

function buildPath(segments: { key: string | number; inArray: boolean }[]): string {
  let path = '';
  for (let i = 0; i < segments.length; i++) {
    const { key, inArray } = segments[i];
    if (typeof key === 'number') continue; // array index — handled by parent []
    if (path) path += '.';
    path += key;
    if (inArray) path += '[]';
  }
  return path;
}


function resolveValue(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const tokens = path.replace(/\[\]/g, ".[].").split(".").filter(Boolean);
  function walk(cur: unknown, idx: number): unknown {
    if (idx >= tokens.length) return cur;
    const tok = tokens[idx];
    if (tok === "[]") {
      if (!Array.isArray(cur)) return undefined;
      return cur.map(item => walk(item, idx + 1));
    }
    if (Array.isArray(cur)) {
      return (cur as unknown[]).map(item =>
        typeof item === "object" && item !== null
          ? walk((item as Record<string, unknown>)[tok], idx + 1)
          : undefined
      );
    }
    if (typeof cur === "object" && cur !== null) {
      return walk((cur as Record<string, unknown>)[tok], idx + 1);
    }
    return undefined;
  }
  return walk(obj, 0);
}

function sampleValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[…${v.length} items]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).slice(0, 3).join(', ')}…}`;
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

function inferType(v: unknown): 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as 'string' | 'number' | 'boolean' | 'object';
}

// Smart inference: given existing paths from this bookmaker, suggest paths for unknown fields
function smartInfer(existing: Partial<EndpointMap>, raw: unknown): Partial<EndpointMap> {
  const suggestions: Partial<EndpointMap> = {};
  if (!raw || typeof raw !== 'object') return suggestions;

  // If we know markets_array_path, try to infer selection paths from array structure
  const mktsPath = existing.markets_array_path;
  if (mktsPath && !existing.market_name_path) {
    const mktSample = resolveValue(raw, mktsPath);
    if (Array.isArray(mktSample) && mktSample.length > 0) {
      const m0 = mktSample[0];
      if (typeof m0 === 'object' && m0) {
        const keys = Object.keys(m0 as object);
        // Common name patterns
        const nameKey = keys.find(k => /^(name|type|market_?type|label|market_?name)$/i.test(k));
        if (nameKey) suggestions.market_name_path = nameKey;
        const specKey = keys.find(k => /^(specifier|line|handicap|total|value)$/i.test(k));
        if (specKey) suggestions.specifier_path = specKey;
        const selsKey = keys.find(k => /^(outcomes|selections|odds|choices|options|runners)$/i.test(k));
        if (selsKey) {
          suggestions.selections_array_path = selsKey;
          const sels = (m0 as Record<string, unknown>)[selsKey];
          if (Array.isArray(sels) && sels.length > 0) {
            const s0 = sels[0] as Record<string, unknown>;
            if (typeof s0 === 'object') {
              const skeys = Object.keys(s0);
              const snameKey = skeys.find(k => /^(name|label|description|outcome|selection|runner_?name)$/i.test(k));
              if (snameKey) suggestions.selection_name_path = snameKey;
              const spriceKey = skeys.find(k => /^(odds|price|decimal|dec_?odds|dec|fraction|value|rate|coefficient)$/i.test(k));
              if (spriceKey) suggestions.selection_price_path = spriceKey;
            }
          }
        }
      }
    }
  }

  // Infer match array from root
  const rootKeys = typeof raw === 'object' ? Object.keys(raw as object) : [];
  if (!existing.match_list_array_path) {
    const arrKey = rootKeys.find(k => {
      const v = (raw as Record<string, unknown>)[k];
      return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object';
    });
    if (arrKey) suggestions.match_list_array_path = arrKey;
  }

  // Infer match fields from first match item
  const arrPath = existing.match_list_array_path || suggestions.match_list_array_path;
  if (arrPath) {
    const arr = resolveValue(raw, arrPath);
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') {
      const item = arr[0] as Record<string, unknown>;
      const keys = Object.keys(item);
      if (!existing.match_id_path) {
        const k = keys.find(k => /^(id|match_?id|event_?id|fixture_?id|game_?id)$/i.test(k));
        if (k) suggestions.match_id_path = k;
      }
      if (!existing.home_team_path) {
        const k = keys.find(k => /^(home|home_?team|home_?name|home_?side)$/i.test(k)) ||
          (() => {
            // nested: try teams.home.name
            const teams = keys.find(k => /teams|competitors/i.test(k));
            if (teams) {
              const t = item[teams] as Record<string, unknown>;
              if (t && typeof t === 'object') {
                const hk = Object.keys(t).find(k => /home|team_?1|team_?a/i.test(k));
                if (hk) {
                  const hv = t[hk] as Record<string, unknown>;
                  if (hv && typeof hv === 'object') {
                    const nk = Object.keys(hv).find(k => /name|title/i.test(k));
                    if (nk) return `${teams}.${hk}.${nk}`;
                  }
                  return `${teams}.${hk}`;
                }
              }
            }
            return null;
          })();
        if (k) suggestions.home_team_path = k as string;
      }
      if (!existing.away_team_path) {
        const k = keys.find(k => /^(away|away_?team|away_?name|away_?side)$/i.test(k)) ||
          (() => {
            const teams = keys.find(k => /teams|competitors/i.test(k));
            if (teams) {
              const t = item[teams] as Record<string, unknown>;
              if (t && typeof t === 'object') {
                const ak = Object.keys(t).find(k => /away|team_?2|team_?b/i.test(k));
                if (ak) {
                  const av = t[ak] as Record<string, unknown>;
                  if (av && typeof av === 'object') {
                    const nk = Object.keys(av).find(k => /name|title/i.test(k));
                    if (nk) return `${teams}.${ak}.${nk}`;
                  }
                  return `${teams}.${ak}`;
                }
              }
            }
            return null;
          })();
        if (k) suggestions.away_team_path = k as string;
      }
      if (!existing.start_time_path) {
        const k = keys.find(k => /^(start|kick_?off|date|time|scheduled|commence|event_?date|fixture_?date|datetime|starts_?at)$/i.test(k));
        if (k) suggestions.start_time_path = k;
      }
      if (!existing.sport_path) {
        const k = keys.find(k => /^(sport|sport_?name|sport_?type)$/i.test(k)) ||
          (() => {
            const sk = keys.find(k => /^sport/i.test(k));
            if (sk) {
              const sv = item[sk];
              if (sv && typeof sv === 'object') {
                const nk = Object.keys(sv as object).find(k => /name|title/i.test(k));
                if (nk) return `${sk}.${nk}`;
              }
            }
            return null;
          })();
        if (k) suggestions.sport_path = k as string;
      }
      if (!existing.competition_path) {
        const k = keys.find(k => /^(competition|league|tournament|competition_?name|league_?name|category|group)$/i.test(k)) ||
          (() => {
            const lk = keys.find(k => /competition|league/i.test(k));
            if (lk) {
              const lv = item[lk];
              if (lv && typeof lv === 'object') {
                const nk = Object.keys(lv as object).find(k => /name|title/i.test(k));
                if (nk) return `${lk}.${nk}`;
              }
            }
            return null;
          })();
        if (k) suggestions.competition_path = k as string;
      }
      if (!existing.markets_array_path) {
        const k = keys.find(k => /^(markets|odds|markets_data|outcomes|bet_?offers|bet_?types)$/i.test(k));
        if (k) suggestions.markets_array_path = k;
      }
    }
  }

  return suggestions;
}

// ─── JSON Tree Node ───────────────────────────────────────────────────────────
//
// Path encoding rules (index-free):
//   • path   = the accessor path UP TO AND INCLUDING this node's key
//   • When a node is an array, its draggable path is `path + "[]"`
//   • When an array renders its children (the items), each item is a transparent
//     pass-through — it does NOT add its numeric index to the path.
//     Instead, the array node already emitted `[]`, so children just receive
//     `parentPath` = `arrayPath + "[]"` and continue building from there.
//
// Example for  { events: [ { id: 1, teams: { home: "Arsenal" } } ] }:
//   events            → draggable path  "events"          (object, no [])
//   events (array)    → draggable path  "events[]"        (array key itself)
//   [item 0]          → invisible pass-through; children use basePath "events[]"
//   id                → draggable path  "events[].id"
//   teams             → draggable path  "events[].teams"
//   home              → draggable path  "events[].teams.home"

function JsonNode({
  keyName,
  value,
  path,       // full path to THIS node (no trailing [])
  depth,
  insideArray, // true when this node is a direct child of an array (item slot)
}: {
  keyName: string | number;
  value: unknown;
  path: string;
  depth: number;
  insideArray: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const { setDragging } = useContext(DragCtx);

  const type   = inferType(value);
  const isArr  = type === 'array';
  const isObj  = type === 'object';
  const isLeaf = !isArr && !isObj;

  // ── If this is an array-item slot (keyName is numeric index), render as a
  //    transparent wrapper — no row of its own, just pass children through
  //    using the already-[] path from the parent.
  if (typeof keyName === 'number') {
    // Only show the first item's contents to represent the schema
    if (keyName > 0) return null;
    if (isObj) {
      return (
        <>
          {Object.entries(value as Record<string, unknown>).slice(0, 30).map(([k, v]) => (
            <JsonNode
              key={k}
              keyName={k}
              value={v}
              path={path ? `${path}.${k}` : k}
              depth={depth}          // same depth — item row is invisible
              insideArray={false}
            />
          ))}
        </>
      );
    }
    // Primitive array item — show as a leaf under the array's [] path
    return (
      <JsonNode
        keyName="[item]"
        value={value}
        path={path}
        depth={depth}
        insideArray={false}
      />
    );
  }

  // ── Normal named key ────────────────────────────────────────────────────────
  const indent = depth * 14;

  // The path the user drags onto a field:
  //   arrays  → "path[]"   (consumer iterates)
  //   others  → "path"
  const dragPath = isArr ? `${path}[]` : path;

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    setDragging({ path: dragPath, value, isArray: isArr });
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', dragPath);
  };

  const typeColor: Record<string, string> = {
    string: '#a3e635', number: '#38bdf8', boolean: '#f59e0b',
    null: '#94a3b8', array: '#c084fc', object: '#fb923c',
  };
  const cols = typeColor[type] || '#94a3b8';

  // Path suffix shown next to the key for clarity
  const pathSuffix = isArr ? '[]' : '';

  return (
    <div style={{ paddingLeft: indent, lineHeight: '22px', fontFamily: '"Fira Code", monospace', fontSize: 11 }}>
      <div
        draggable
        onDragStart={handleDragStart}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          cursor: 'grab', padding: '1px 4px', borderRadius: 2,
          transition: 'background .1s', userSelect: 'none',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.06)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        title={`path: ${dragPath}`}
      >
        {/* Expand/collapse toggle */}
        {(isArr || isObj) ? (
          <span
            onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
            style={{ color: '#475569', fontSize: 9, cursor: 'pointer', width: 10, display: 'inline-block' }}
          >
            {open ? '▾' : '▸'}
          </span>
        ) : (
          <span style={{ width: 10, display: 'inline-block' }} />
        )}

        {/* Key name */}
        <span style={{ color: '#c084fc' }}>{keyName}</span>
        {pathSuffix && <span style={{ color: '#c6f135', fontSize: 9 }}>{pathSuffix}</span>}
        <span style={{ color: '#334155' }}>:</span>

        {/* Value preview */}
        {isLeaf && <span style={{ color: cols }}>{sampleValue(value)}</span>}
        {isArr  && (
          <span style={{ color: cols, fontSize: 10 }}>
            [{(value as unknown[]).length}]
            <span style={{ color: '#334155', fontSize: 9, marginLeft: 4 }}>array</span>
          </span>
        )}
        {isObj && !isArr && (
          <span style={{ color: cols, fontSize: 10 }}>
            {'{'}{Object.keys(value as object).length}{' keys}'}
            <span style={{ color: '#334155', fontSize: 9, marginLeft: 4 }}>object</span>
          </span>
        )}

        {/* Drag handle */}
        <span style={{ color: '#1e3a5f', fontSize: 9, marginLeft: 2 }}>⠿</span>
      </div>

      {/* ── Array children ── render first item as schema representative */}
      {open && isArr && (
        <div>
          {(value as unknown[]).slice(0, 1).map((item, i) => (
            // Pass path WITH [] so children know they're inside an array traversal
            <JsonNode
              key={i}
              keyName={i}          // numeric → transparent pass-through
              value={item}
              path={`${path}[]`}  // ← THE FIX: [] already in path for all descendants
              depth={depth + 1}
              insideArray={true}
            />
          ))}
          {(value as unknown[]).length > 1 && (
            <div style={{ paddingLeft: (depth + 1) * 14, color: '#334155', fontSize: 10, lineHeight: '20px' }}>
              ⋯ {(value as unknown[]).length - 1} more items (same schema)
            </div>
          )}
        </div>
      )}

      {/* ── Object children ── */}
      {open && isObj && !isArr && (
        <div>
          {Object.entries(value as Record<string, unknown>).slice(0, 30).map(([k, v]) => (
            <JsonNode
              key={k}
              keyName={k}
              value={v}
              path={path ? `${path}.${k}` : k}
              depth={depth + 1}
              insideArray={false}
            />
          ))}
          {Object.keys(value as object).length > 30 && (
            <div style={{ paddingLeft: (depth + 1) * 14, color: '#334155', fontSize: 10 }}>
              ⋯ {Object.keys(value as object).length - 30} more keys
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Drop Zone Field ──────────────────────────────────────────────────────────

function DropField({
  field, value, onChange, suggested,
}: {
  field: PathField;
  value: string;
  onChange: (v: string) => void;
  suggested?: string;
}) {
  const { dragging } = useContext(DragCtx);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const path = e.dataTransfer.getData('text/plain');
    if (path) onChange(path);
    setOver(false);
  };

  const isFilled = !!value;
  const isSuggested = !isFilled && !!suggested;
  const isDragging = !!dragging;

  return (
    <div
      ref={ref}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      style={{
        marginBottom: 10,
        border: `1px dashed ${over ? '#c6f135' : isFilled ? 'rgba(198,241,53,.3)' : isDragging ? 'rgba(6,182,212,.4)' : 'rgba(255,255,255,.06)'}`,
        background: over ? 'rgba(198,241,53,.06)' : isFilled ? 'rgba(198,241,53,.03)' : 'rgba(255,255,255,.01)',
        padding: '8px 10px',
        transition: 'all .1s',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <label style={{
          fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2,
          color: isFilled ? '#c6f135' : 'var(--text-muted)', fontWeight: 700,
        }}>
          {field.label}
        </label>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {isSuggested && (
            <button
              onClick={() => onChange(suggested!)}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1,
                color: '#06b6d4', background: 'rgba(6,182,212,.08)',
                border: '1px solid rgba(6,182,212,.3)', padding: '1px 8px', cursor: 'pointer',
              }}
            >
              ⚡ {suggested}
            </button>
          )}
          {isFilled && (
            <button onClick={() => onChange('')}
              style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 12, padding: 0 }}>
              ×
            </button>
          )}
        </div>
      </div>

      {isFilled ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <code style={{
            fontFamily: '"Fira Code", monospace', fontSize: 11, color: '#c6f135',
            background: 'rgba(198,241,53,.08)', padding: '2px 8px',
            border: '1px solid rgba(198,241,53,.2)', flex: 1,
          }}>
            {value}
          </code>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            style={{
              position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none',
            }}
          />
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: over ? '#c6f135' : '#1e3a5f',
          fontFamily: '"Fira Code", monospace', fontSize: 10,
          padding: '2px 0',
        }}>
          <span style={{ fontSize: 14 }}>{over ? '◎' : isDragging ? '⊡' : '⊙'}</span>
          <span>
            {over ? 'Drop to assign path' : isDragging ? 'Drop here…' : (
              <span style={{ color: '#1e3a5f' }}>drag node here — or type: </span>
            )}
          </span>
          {!over && !isDragging && (
            <input
              value={value}
              onChange={e => onChange(e.target.value)}
              placeholder={field.example || 'e.g. events[].id'}
              style={{
                background: 'transparent', border: 'none', outline: 'none',
                fontFamily: '"Fira Code", monospace', fontSize: 10,
                color: 'var(--text-secondary)', flex: 1, padding: 0,
              }}
            />
          )}
        </div>
      )}

      {isFilled && (
        <div style={{ marginTop: 3, fontSize: 9, color: '#1e3a5f', fontFamily: 'var(--font-mono)' }}>
          {field.hint}
        </div>
      )}
    </div>
  );
}

// ─── Market Alias Drop Row ────────────────────────────────────────────────────

function MarketAliasRow({
  market, existingAlias, bookmakerId, onSaved,
}: {
  market: Market;
  existingAlias?: string;
  bookmakerId: number;
  onSaved: (marketId: number, alias: string) => void;
}) {
  const { dragging } = useContext(DragCtx);
  const [over, setOver]     = useState(false);
  const [alias, setAlias]   = useState(existingAlias || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved_]  = useState(!!existingAlias);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const raw = e.dataTransfer.getData('text/plain');
    // Use only the last segment as the alias value (the field name), not the path
    const seg = raw.split('.').pop()?.replace('[]', '') || raw;
    setAlias(seg);
    // Auto-save
    await doSave(seg);
  };

  const doSave = async (a = alias) => {
    if (!a.trim() || !bookmakerId) return;
    setSaving(true);
    await apiFetch(`/markets/${market.id}/aliases`, {
      method: 'POST',
      body: JSON.stringify({ bookmaker_id: bookmakerId, alias_name: a.trim() }),
    });
    setSaving(false);
    setSaved_(true);
    onSaved(market.id, a.trim());
  };

  const isDragging = !!dragging;

  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      style={{
        display: 'grid', gridTemplateColumns: '1fr 14px 1fr auto',
        alignItems: 'center', gap: 8, padding: '7px 10px',
        border: `1px dashed ${over ? '#c6f135' : saved ? 'rgba(198,241,53,.2)' : isDragging ? 'rgba(6,182,212,.3)' : 'rgba(255,255,255,.05)'}`,
        background: over ? 'rgba(198,241,53,.05)' : saved ? 'rgba(198,241,53,.02)' : 'rgba(255,255,255,.01)',
        marginBottom: 5, transition: 'all .1s',
      }}
    >
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: saved ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {market.name}
        <div style={{ fontFamily: '"Fira Code", monospace', fontSize: 9, color: '#334155' }}>{market.slug}</div>
      </div>

      <span style={{ color: '#1e3a5f', fontSize: 10, textAlign: 'center' }}>→</span>

      <div style={{ position: 'relative' }}>
        {over ? (
          <div style={{ fontFamily: '"Fira Code", monospace', fontSize: 10, color: '#c6f135', padding: '4px 6px' }}>
            Drop to assign alias
          </div>
        ) : (
          <input
            value={alias}
            onChange={e => { setAlias(e.target.value); setSaved_(false); }}
            onKeyDown={e => e.key === 'Enter' && doSave()}
            placeholder={isDragging ? '⊡ drop here…' : 'bookmaker market name'}
            style={{
              width: '100%', boxSizing: 'border-box' as const,
              background: 'var(--bg-base)', border: `1px solid ${alias ? 'rgba(198,241,53,.3)' : 'var(--border-dim)'}`,
              color: alias ? '#c6f135' : 'var(--text-muted)',
              fontFamily: '"Fira Code", monospace', fontSize: 11,
              padding: '5px 8px', outline: 'none',
            }}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        {saved ? (
          <span style={{ color: '#4ade80', fontSize: 12 }}>✓</span>
        ) : (
          <button
            onClick={() => doSave()}
            disabled={!alias.trim() || saving}
            style={{
              background: alias.trim() ? 'rgba(198,241,53,.1)' : 'transparent',
              border: `1px solid ${alias.trim() ? 'rgba(198,241,53,.3)' : 'var(--border-dim)'}`,
              color: alias.trim() ? '#c6f135' : '#334155',
              fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1,
              padding: '4px 10px', cursor: alias.trim() ? 'pointer' : 'default',
            }}
          >
            {saving ? '…' : 'SAVE'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const PATH_FIELDS: PathField[] = [
  { key: 'match_list_array_path', label: 'MATCHES ARRAY',   group: 'match',  hint: 'Path to the array of match objects',      example: 'events  or  data.events' },
  { key: 'match_id_path',         label: 'MATCH ID',         group: 'match',  hint: 'Unique match ID within each match item',  example: 'id' },
  { key: 'home_team_path',        label: 'HOME TEAM',        group: 'match',  hint: 'Home team name within match item',        example: 'home  or  teams.home.name' },
  { key: 'away_team_path',        label: 'AWAY TEAM',        group: 'match',  hint: 'Away team name within match item',        example: 'away  or  teams.away.name' },
  { key: 'start_time_path',       label: 'START TIME',       group: 'match',  hint: 'Kick-off / start datetime',               example: 'startTime' },
  { key: 'sport_path',            label: 'SPORT',            group: 'match',  hint: 'Sport name within match item',            example: 'sport.name' },
  { key: 'competition_path',      label: 'COMPETITION',      group: 'match',  hint: 'League / competition name',               example: 'league.name' },
  { key: 'markets_array_path',    label: 'MARKETS ARRAY',    group: 'market', hint: 'Path from match item to markets array',   example: 'markets' },
  { key: 'market_name_path',      label: 'MARKET NAME',      group: 'market', hint: 'Market type name within market item',     example: 'name' },
  { key: 'specifier_path',        label: 'SPECIFIER',        group: 'market', hint: 'Line / specifier within market item',     example: 'specifier' },
  { key: 'selections_array_path', label: 'SELECTIONS ARRAY', group: 'market', hint: 'Path from market item to selections',     example: 'outcomes' },
  { key: 'selection_name_path',   label: 'SELECTION NAME',   group: 'market', hint: 'Selection display name',                  example: 'name' },
  { key: 'selection_price_path',  label: 'PRICE / ODDS',     group: 'market', hint: 'Decimal price / odds value',              example: 'odds' },
];

export default function SmartPathMapper() {
  const [bookmakers, setBookmakers]   = useState<Bookmaker[]>([]);
  const [markets, setMarkets]         = useState<Market[]>([]);
  const [selBk, setSelBk]             = useState<number | ''>('');
  const [endpointMaps, setEMaps]      = useState<EndpointMap[]>([]);
  const [selEM, setSelEM]             = useState<number | ''>('');
  const [rawText, setRawText]         = useState('');
  const [rawJson, setRawJson]         = useState<unknown>(null);
  const [parseErr, setParseErr]       = useState('');
  const [paths, setPaths]             = useState<Partial<EndpointMap>>({});
  const [suggestions, setSuggestions] = useState<Partial<EndpointMap>>({});
  const [dragging, setDragging]       = useState<DragState | null>(null);
  const [previewRows, setPreview]     = useState<Record<string, unknown>[]>([]);
  const [saving, setSaving]           = useState(false);
  const [saved_, setSaved]            = useState(false);
  const [toast, setToast]             = useState('');
  const [mktAliases, setMktAliases]   = useState<Record<number, string>>({});
  const [activeTab, setTab]           = useState<'paths' | 'markets'>('paths');
  const [fetching, setFetching]       = useState(false);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2800); };

  // Load meta
  useEffect(() => {
    apiFetch('/meta/').then(r => {
      setBookmakers(r.bookmakers || []);
    });
    apiFetch('/markets/?per_page=200').then(r => setMarkets(r.items || []));
  }, []);

  // Load endpoint maps when bookmaker changes
  useEffect(() => {
    if (!selBk) { setEMaps([]); setSelEM(''); return; }
    apiFetch(`/endpoint-maps/?bookmaker_id=${selBk}&per_page=20`).then(r => {
      setEMaps(r.items || []);
    });
  }, [selBk]);

  // Load existing paths when endpoint map selected
  useEffect(() => {
    if (!selEM) return;
    apiFetch(`/endpoint-maps/${selEM}`).then(em => {
      const loaded: Partial<EndpointMap> = {};
      PATH_FIELDS.forEach(f => {
        if (em[f.key]) loaded[f.key] = em[f.key];
      });
      setPaths(loaded);
      if (em.sample_response) {
        setRawText(em.sample_response.slice(0, 50000));
        try {
          const j = JSON.parse(em.sample_response);
          setRawJson(j);
          setSuggestions(smartInfer(loaded, j));
        } catch {}
      }
    });
  }, [selEM]);

  // Auto-infer on JSON change or path change
  useEffect(() => {
    if (!rawJson) return;
    setSuggestions(smartInfer(paths, rawJson));
  }, [rawJson, paths]);

  // Live preview row extraction
  useEffect(() => {
    if (!rawJson || !paths.match_list_array_path) return;
    try {
      const items = resolveValue(rawJson, paths.match_list_array_path);
      if (!Array.isArray(items)) return;
      const rows: Record<string, unknown>[] = [];
      for (const item of items.slice(0, 3)) {
        if (typeof item !== 'object' || !item) continue;
        const meta: Record<string, unknown> = {
          match_id:    paths.match_id_path        ? resolveValue(item, paths.match_id_path)    : null,
          home_team:   paths.home_team_path       ? resolveValue(item, paths.home_team_path)   : null,
          away_team:   paths.away_team_path       ? resolveValue(item, paths.away_team_path)   : null,
          start_time:  paths.start_time_path      ? resolveValue(item, paths.start_time_path)  : null,
          sport:       paths.sport_path           ? resolveValue(item, paths.sport_path)       : null,
          competition: paths.competition_path     ? resolveValue(item, paths.competition_path) : null,
        };
        if (!paths.markets_array_path) { rows.push(meta); continue; }
        const mkts = resolveValue(item, paths.markets_array_path);
        if (!Array.isArray(mkts)) { rows.push(meta); continue; }
        for (const mkt of mkts.slice(0, 2)) {
          const mktName = paths.market_name_path ? resolveValue(mkt, paths.market_name_path) : null;
          const specifier = paths.specifier_path ? resolveValue(mkt, paths.specifier_path) : null;
          const sels = paths.selections_array_path ? resolveValue(mkt, paths.selections_array_path) : [];
          if (!Array.isArray(sels)) continue;
          for (const sel of sels.slice(0, 3)) {
            rows.push({
              ...meta,
              market: mktName,
              specifier,
              selection: paths.selection_name_path  ? resolveValue(sel, paths.selection_name_path)  : null,
              price:     paths.selection_price_path ? resolveValue(sel, paths.selection_price_path) : null,
            });
          }
        }
      }
      setPreview(rows.slice(0, 12));
    } catch {}
  }, [paths, rawJson]);

  const parseJson = (text: string) => {
    if (!text.trim()) { setRawJson(null); return; }
    try {
      const j = JSON.parse(text);
      setRawJson(j);
      setParseErr('');
      setSuggestions(smartInfer(paths, j));
    } catch (e) {
      setParseErr(String(e));
      setRawJson(null);
    }
  };

  const handleFetch = async () => {
    if (!selEM) return;
    setFetching(true);
    const r = await apiFetch(`/fetch-sample`, {
      method: 'POST',
      body: JSON.stringify({ endpoint_map_id: selEM }),
    });
    setFetching(false);
    if (r.ok === false) { showToast('✗ ' + r.error); return; }
    // Reload the endpoint map (sample now stored)
    const em = await apiFetch(`/endpoint-maps/${selEM}`);
    if (em.sample_response) {
      setRawText(em.sample_response.slice(0, 50000));
      try {
        const j = JSON.parse(em.sample_response);
        setRawJson(j);
      } catch {}
    }
    showToast('✓ Sample fetched');
  };

  const handleAutoFill = () => {
    const merged = { ...paths };
    (Object.keys(suggestions) as (keyof EndpointMap)[]).forEach(k => {
      if (!merged[k] && suggestions[k]) merged[k as keyof EndpointMap] = suggestions[k] as never;
    });
    setPaths(merged);
    showToast('✓ Auto-filled suggested paths');
  };

  const filledCount = PATH_FIELDS.filter(f => !!paths[f.key]).length;
  const suggestCount = PATH_FIELDS.filter(f => !paths[f.key] && !!suggestions[f.key]).length;

  const save = async () => {
    if (!selEM) return;
    setSaving(true);
    await apiFetch(`/endpoint-maps/${selEM}`, {
      method: 'PUT',
      body: JSON.stringify({ ...paths }),
    });
    setSaving(false);
    setSaved(true);
    showToast('✓ Paths saved');
    setTimeout(() => setSaved(false), 2000);
  };

  const matchFields = PATH_FIELDS.filter(f => f.group === 'match');
  const marketFields = PATH_FIELDS.filter(f => f.group === 'market');

  return (
    <DragCtx.Provider value={{ dragging, setDragging }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
        .drag-active { animation: pulse 1s infinite; }
      `}</style>

      <div style={s.page} onDragEnd={() => setDragging(null)}>
        {/* Toast */}
        {toast && (
          <div style={s.toast}>{toast}</div>
        )}

        {/* Header */}
        <div style={s.header}>
          <div>
            <h1 style={s.title}>PATH MAPPER</h1>
            <p style={s.subtitle}>Drag JSON nodes → drop onto fields to auto-populate accessor paths</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {suggestCount > 0 && (
              <button onClick={handleAutoFill} style={s.autoBtn}>
                ⚡ AUTO-FILL {suggestCount} FIELDS
              </button>
            )}
            <button
              onClick={save}
              disabled={saving || !selEM || filledCount === 0}
              style={{ ...s.saveBtn, opacity: (!selEM || filledCount === 0) ? 0.4 : 1 }}
            >
              {saving ? '◌' : saved_ ? '✓' : '⊕'} SAVE PATHS
            </button>
          </div>
        </div>

        {/* Bookmaker + Endpoint selector */}
        <div style={s.selectors}>
          <div style={s.selectGroup}>
            <label style={s.selLabel}>BOOKMAKER</label>
            <select value={selBk} onChange={e => { setSelBk(e.target.value ? Number(e.target.value) : ''); setPaths({}); }}
              style={s.sel}>
              <option value="">— select bookmaker —</option>
              {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
            </select>
          </div>

          {endpointMaps.length > 0 && (
            <div style={s.selectGroup}>
              <label style={s.selLabel}>ENDPOINT</label>
              <select value={selEM} onChange={e => setSelEM(e.target.value ? Number(e.target.value) : '')}
                style={s.sel}>
                <option value="">— select endpoint —</option>
                {endpointMaps.map(em => (
                  <option key={em.id} value={em.id}>{em.endpoint_type}</option>
                ))}
              </select>
            </div>
          )}

          {selEM && (
            <button onClick={handleFetch} disabled={fetching} style={s.fetchBtn}>
              {fetching ? '◌ FETCHING…' : '⬇ FETCH LIVE SAMPLE'}
            </button>
          )}

          <div style={s.progressBar}>
            <div style={{ ...s.progressFill, width: `${(filledCount / PATH_FIELDS.length) * 100}%` }} />
            <span style={s.progressLabel}>{filledCount}/{PATH_FIELDS.length} fields mapped</span>
          </div>
        </div>

        {/* Drag hint bar */}
        {dragging && (
          <div style={s.dragHint} className="drag-active">
            <span style={{ color: '#c6f135' }}>⠿ DRAGGING</span>
            <code style={s.dragPath}>{dragging.path}</code>
            <span style={{ color: '#64748b', fontSize: 9 }}>
              → {dragging.isArray ? 'array path' : 'value path'} — drop on any field
            </span>
          </div>
        )}

        {/* Main layout */}
        <div style={s.layout}>
          {/* ── Left: JSON Explorer ──────────────────────────────────────── */}
          <div style={s.explorerPane}>
            <div style={s.paneHead}>
              <span>JSON EXPLORER</span>
              {rawJson && (
                <span style={{ color: '#4ade80', fontSize: 9 }}>
                  ✓ parsed — drag any node →
                </span>
              )}
            </div>

            {!rawJson ? (
              <div style={{ padding: 16 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>
                  PASTE JSON RESPONSE
                </div>
                <textarea
                  value={rawText}
                  onChange={e => { setRawText(e.target.value); parseJson(e.target.value); }}
                  placeholder={'{\n  "events": [\n    { "id": 123, ... }\n  ]\n}'}
                  style={s.jsonPaste}
                />
                {parseErr && (
                  <div style={{ color: '#ff3d5a', fontFamily: '"Fira Code", monospace', fontSize: 9, marginTop: 6 }}>
                    {parseErr}
                  </div>
                )}
                {selEM && (
                  <button onClick={handleFetch} disabled={fetching} style={{ ...s.fetchBtn, marginTop: 10, width: '100%' }}>
                    {fetching ? '◌ FETCHING…' : '⬇ FETCH FROM ENDPOINT'}
                  </button>
                )}
              </div>
            ) : (
              <div style={s.treeScroll}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px 2px' }}>
                  <button onClick={() => { setRawJson(null); setRawText(''); setSuggestions({}); }}
                    style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: 11 }}>
                    ✕ clear
                  </button>
                </div>
                {typeof rawJson === 'object' && rawJson !== null && (
                  Array.isArray(rawJson)
                    // Root is a bare array of matches — show schema of first item, paths start with []
                    ? (() => {
                        const arr = rawJson as unknown[];
                        const first = arr[0];
                        return (
                          <>
                            <div style={{ paddingLeft: 6, fontFamily: '"Fira Code", monospace', fontSize: 10, color: '#c084fc', lineHeight: '24px' }}>
                              <span style={{ color: '#475569' }}>[</span>
                              <span style={{ color: '#38bdf8' }}> {arr.length} </span>
                              <span style={{ color: '#475569' }}>items]</span>
                              <span style={{ color: '#c6f135', fontSize: 9, marginLeft: 4 }}>[]</span>
                              <span style={{ color: '#334155', fontSize: 9, marginLeft: 6 }}>root array — paths start with []</span>
                            </div>
                            {first && typeof first === 'object' &&
                              Object.entries(first as Record<string, unknown>).slice(0, 30).map(([k, v]) => (
                                <JsonNode key={k} keyName={k} value={v} path={`[].${k}`} depth={1} insideArray={false} />
                              ))
                            }
                          </>
                        );
                      })()
                    : Object.entries(rawJson as Record<string, unknown>).map(([k, v]) => (
                        <JsonNode key={k} keyName={k} value={v} path={k} depth={0} insideArray={false} />
                      ))
                )}
              </div>
            )}
          </div>

          {/* ── Right: Fields + Tabs ──────────────────────────────────────── */}
          <div style={s.fieldsPane}>
            {/* Tabs */}
            <div style={s.tabs}>
              <button onClick={() => setTab('paths')} style={{ ...s.tab, ...(activeTab === 'paths' ? s.tabActive : {}) }}>
                PATH FIELDS
                <span style={{ ...s.tabCount, background: filledCount === PATH_FIELDS.length ? '#4ade8020' : 'rgba(255,255,255,.04)' }}>
                  {filledCount}/{PATH_FIELDS.length}
                </span>
              </button>
              <button onClick={() => setTab('markets')} style={{ ...s.tab, ...(activeTab === 'markets' ? s.tabActive : {}) }}>
                MARKET ALIASES
                <span style={s.tabCount}>{Object.values(mktAliases).filter(Boolean).length}/{markets.length}</span>
              </button>
            </div>

            {/* PATH FIELDS TAB */}
            {activeTab === 'paths' && (
              <div style={s.fieldsBody}>
                {/* Group: Match */}
                <div style={s.groupHead}>
                  <div style={s.groupLine} />
                  <span>MATCH FIELDS</span>
                  <div style={s.groupLine} />
                </div>
                {matchFields.map(f => (
                  <DropField
                    key={f.key as string}
                    field={f}
                    value={(paths[f.key] as string) || ''}
                    onChange={v => setPaths(p => ({ ...p, [f.key]: v }))}
                    suggested={(suggestions[f.key] as string) || undefined}
                  />
                ))}

                {/* Group: Market */}
                <div style={{ ...s.groupHead, marginTop: 20 }}>
                  <div style={s.groupLine} />
                  <span>MARKET FIELDS</span>
                  <div style={s.groupLine} />
                </div>
                {marketFields.map(f => (
                  <DropField
                    key={f.key as string}
                    field={f}
                    value={(paths[f.key] as string) || ''}
                    onChange={v => setPaths(p => ({ ...p, [f.key]: v }))}
                    suggested={(suggestions[f.key] as string) || undefined}
                  />
                ))}

                {/* Live preview */}
                {previewRows.length > 0 && (
                  <div style={s.preview}>
                    <div style={s.previewHead}>LIVE PREVIEW — {previewRows.length} rows extracted</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, fontFamily: '"Fira Code", monospace' }}>
                        <thead>
                          <tr>
                            {['home', 'away', 'market', 'selection', 'price', 'sport'].map(col => (
                              <th key={col} style={{ padding: '4px 8px', color: '#334155', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,.04)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2 }}>
                                {col.toUpperCase()}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((r, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,.03)' }}>
                              <td style={s.previewCell}>{String(r.home_team ?? '—').slice(0, 18)}</td>
                              <td style={s.previewCell}>{String(r.away_team ?? '—').slice(0, 18)}</td>
                              <td style={{ ...s.previewCell, color: '#06b6d4' }}>{String(r.market ?? '—').slice(0, 16)}</td>
                              <td style={{ ...s.previewCell, color: '#a3e635' }}>{String(r.selection ?? '—').slice(0, 14)}</td>
                              <td style={{ ...s.previewCell, color: '#f59e0b' }}>{r.price != null ? String(r.price) : '—'}</td>
                              <td style={{ ...s.previewCell, color: '#c084fc' }}>{String(r.sport ?? '—').slice(0, 12)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* MARKET ALIASES TAB */}
            {activeTab === 'markets' && (
              <div style={s.fieldsBody}>
                {!selBk ? (
                  <div style={s.emptyState}>Select a bookmaker to map market aliases</div>
                ) : (
                  <>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 16, padding: '8px 12px', background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
                      Drag a JSON node from the tree into the right column — the field name becomes the alias automatically.
                      Or type the bookmaker's name for each market and press Enter.
                    </div>

                    {/* Header */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 14px 1fr auto', gap: 8, padding: '4px 10px', marginBottom: 4 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: '#334155' }}>CANONICAL MARKET</span>
                      <span />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: '#334155' }}>BOOKMAKER ALIAS</span>
                      <span />
                    </div>

                    {markets.map(m => (
                      <MarketAliasRow
                        key={m.id}
                        market={m}
                        existingAlias={mktAliases[m.id]}
                        bookmakerId={Number(selBk)}
                        onSaved={(id, alias) => setMktAliases(p => ({ ...p, [id]: alias }))}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </DragCtx.Provider>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:     { maxWidth: 1400, padding: '0 0 60px', position: 'relative' },
  header:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  title:    { fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: 3, margin: 0 },
  subtitle: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2, marginTop: 4 },

  selectors:{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' },
  selectGroup:{ display: 'flex', flexDirection: 'column', gap: 5 },
  selLabel: { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)' },
  sel:      { background: 'var(--bg-surface)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', minWidth: 200 },

  progressBar: { flex: 1, height: 3, background: 'var(--border-dim)', position: 'relative', alignSelf: 'center', minWidth: 120 },
  progressFill:{ height: '100%', background: '#c6f135', transition: 'width .3s' },
  progressLabel:{ position: 'absolute', top: 6, right: 0, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1, whiteSpace: 'nowrap' },

  autoBtn:  { background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.4)', color: '#06b6d4', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: '9px 18px', cursor: 'pointer' },
  saveBtn:  { background: '#c6f135', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 800, letterSpacing: 1.5, padding: '9px 22px', cursor: 'pointer' },
  fetchBtn: { background: 'transparent', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1, padding: '9px 16px', cursor: 'pointer', alignSelf: 'flex-end' },

  dragHint: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', marginBottom: 12, background: 'rgba(198,241,53,.04)', border: '1px dashed rgba(198,241,53,.3)', fontFamily: 'var(--font-mono)', fontSize: 10 },
  dragPath: { fontFamily: '"Fira Code", monospace', fontSize: 11, color: '#06b6d4', background: 'rgba(6,182,212,.1)', padding: '2px 10px', border: '1px solid rgba(6,182,212,.3)' },

  layout:   { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, border: '1px solid var(--border-dim)', minHeight: 620 },

  explorerPane:{ borderRight: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column' },
  paneHead:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border-dim)', background: 'rgba(255,255,255,.02)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: '#c6f135' },
  treeScroll:  { flex: 1, overflowY: 'auto', padding: '8px 6px', background: '#070c14' },
  jsonPaste:   { width: '100%', boxSizing: 'border-box' as const, height: 340, background: '#070c14', border: '1px solid rgba(255,255,255,.06)', color: '#a3e635', fontFamily: '"Fira Code", monospace', fontSize: 11, padding: '10px', outline: 'none', resize: 'vertical' as const, lineHeight: 1.6 },

  fieldsPane:  { display: 'flex', flexDirection: 'column' },
  tabs:        { display: 'flex', borderBottom: '1px solid var(--border-dim)' },
  tab:         { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, cursor: 'pointer' },
  tabActive:   { color: '#c6f135', borderBottomColor: '#c6f135' },
  tabCount:    { fontFamily: 'var(--font-mono)', fontSize: 8, padding: '1px 6px', background: 'rgba(255,255,255,.04)', color: 'var(--text-muted)' },
  fieldsBody:  { flex: 1, overflowY: 'auto', padding: '16px 18px' },

  groupHead:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, color: '#334155' },
  groupLine:   { flex: 1, height: 1, background: 'var(--border-dim)' },

  preview:     { marginTop: 18, border: '1px solid rgba(198,241,53,.15)', background: 'rgba(198,241,53,.02)' },
  previewHead: { padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: '#c6f135', borderBottom: '1px solid rgba(198,241,53,.1)' },
  previewCell: { padding: '4px 8px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' as const, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' },

  emptyState:  { padding: '40px 20px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 11, color: '#334155' },

  toast:  { position: 'fixed' as const, top: 20, right: 24, zIndex: 9999, background: 'var(--bg-surface)', border: '1px solid rgba(198,241,53,.5)', color: '#c6f135', padding: '10px 20px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 4px 24px rgba(0,0,0,.5)' },
};