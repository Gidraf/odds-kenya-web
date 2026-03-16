/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

/**
 * ParentMatchIdSelector
 * =====================
 * Lets the operator pick which field in the probed API response maps to the
 * cross-bookmaker canonical match ID (parent_match_id).
 *
 * - Auto-suggests field names from the probed JSON, ranked by ID-likelihood.
 * - Works for both flat objects and arrays (inspects the first item).
 * - Nested paths can be typed manually (e.g. "data.event.id").
 * - The compiled `expression` (e.g. `item['event_id']`) is threaded into every
 *   AI prompt so the generated parser always uses the right join key.
 */

import { useEffect, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParentIdConfig {
  /** Raw field name as it appears in the response, e.g. "event_id" */
  field: string;
  /**
   * Optional full accessor override the operator can type manually,
   * e.g. "item['data']['event_id']"  — if blank, the field alone is sent.
   */
  expression: string;
}

export const emptyParentId = (): ParentIdConfig => ({ field: '', expression: '' });

interface Suggestion {
  key:       string;
  path:      string;   // dot-path to item, e.g. "events[0].event_id"
  sampleVal: string;   // stringified sample value for display
  score:     number;   // higher = more ID-like
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreKey(key: string): number {
  const k = key.toLowerCase();
  if (/^(event_id|match_id|game_id|fixture_id)$/.test(k)) return 100;
  if (/^id$/.test(k))                                       return 90;
  if (/(event|match|game|fixture).*id/.test(k))             return 80;
  if (/id$/.test(k))                                        return 70;
  if (/^(key|uid|ref|code)$/.test(k))                       return 60;
  if (/(key|uid|ref)/.test(k))                              return 40;
  return 0;
}

function extractSuggestions(raw: string): Suggestion[] {
  if (!raw) return [];
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return []; }

  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();

  const inspect = (target: any, pathPrefix: string) => {
    if (!target || typeof target !== 'object') return;

    // If array → inspect first item
    if (Array.isArray(target)) {
      if (target.length > 0 && typeof target[0] === 'object') {
        inspect(target[0], `${pathPrefix}[0]`);
      }
      return;
    }

    for (const [k, v] of Object.entries(target)) {
      const dotPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      const isPrimitive = v === null || typeof v !== 'object';

      if (isPrimitive && !seen.has(k)) {
        seen.add(k);
        suggestions.push({
          key:       k,
          path:      dotPath,
          sampleVal: String(v).slice(0, 30),
          score:     scoreKey(k),
        });
      }

      // Recurse one level into objects, not arrays of primitives
      if (v && typeof v === 'object' && !Array.isArray(v) && pathPrefix === '') {
        inspect(v, k);
      }
    }
  };

  // Top-level
  inspect(obj, '');

  // Also inspect the first item of the first array value we find
  if (!Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        inspect(v[0], `${k}[0]`);
        break;
      }
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 24);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParentMatchIdSelector({
  value,
  onChange,
  responseRaw,
  accent = 'var(--acid)',
  label = 'PARENT MATCH ID',
}: {
  value:        ParentIdConfig;
  onChange:     (v: ParentIdConfig) => void;
  responseRaw:  string;
  accent?:      string;
  label?:       string;
}) {
  const [open,        setOpen]        = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [filterText,  setFilterText]  = useState('');
  const [hoveredKey,  setHoveredKey]  = useState<string | null>(null);

  // Re-derive suggestions whenever the probed response changes
  useEffect(() => {
    setSuggestions(extractSuggestions(responseRaw));
  }, [responseRaw]);

  const isSet      = value.field.trim().length > 0;
  const accentDim  = accent + '55';
  const accentFill = accent + '15';

  const filtered = filterText
    ? suggestions.filter(s =>
        s.key.toLowerCase().includes(filterText.toLowerCase()) ||
        s.path.toLowerCase().includes(filterText.toLowerCase())
      )
    : suggestions;

  const topSuggestions  = filtered.filter(s => s.score >= 70);
  const restSuggestions = filtered.filter(s => s.score < 70);

  const selectSuggestion = (s: Suggestion) => {
    onChange({ field: s.key, expression: '' });
    setFilterText('');
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(emptyParentId());
    setFilterText('');
  };

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>

      {/* ── Collapsed pill / header ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display:     'flex',
          alignItems:  'center',
          gap:         8,
          padding:     '6px 11px',
          border:      `1px solid ${isSet ? accentDim : 'var(--border-dim)'}`,
          background:  isSet ? accentFill : 'var(--bg-surface)',
          cursor:      'pointer',
          transition:  'all .15s',
          minWidth:    0,
        }}
      >
        {/* Icon */}
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color:      isSet ? accent : 'rgba(255,210,60,.5)',
          flexShrink: 0,
        }}>
          {isSet ? '⬡' : '⬡'}
        </span>

        {/* Label */}
        <span style={{
          fontFamily:   'var(--font-mono)',
          fontSize:     7,
          letterSpacing: 2,
          color:        isSet ? accent : 'var(--text-muted)',
          flexShrink:   0,
        }}>
          {label}
        </span>

        {/* Value badge  */}
        {isSet ? (
          <span style={{
            fontFamily:  'var(--font-mono)', fontSize: 9,
            color:       accent,
            background:  accent + '18',
            padding:     '1px 8px',
            border:      `1px solid ${accentDim}`,
            maxWidth:    160,
            overflow:    'hidden',
            textOverflow:'ellipsis',
            whiteSpace:  'nowrap',
          }}>
            {value.expression || value.field}
          </span>
        ) : (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 8,
            color:      'rgba(255,180,0,.55)',
            fontStyle:  'italic',
          }}>
            not set — AI will guess
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Clear button */}
        {isSet && (
          <button
            onClick={clear}
            title="Clear"
            style={{
              background: 'none', border: 'none', padding: '0 2px',
              color: 'rgba(255,61,90,.4)', cursor: 'pointer', fontSize: 10,
              lineHeight: 1, flexShrink: 0, transition: 'color .15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,61,90,.4)')}
          >
            ✕
          </button>
        )}

        {/* Chevron */}
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 7,
          color: 'var(--text-muted)', flexShrink: 0,
          transition: 'transform .15s',
          transform: open ? 'rotate(180deg)' : 'none',
          display: 'inline-block',
        }}>
          ▼
        </span>
      </div>

      {/* ── Expanded panel ── */}
      {open && (
        <div style={{
          position:   'absolute',
          top:        '100%',
          left:       0,
          right:      0,
          zIndex:     200,
          border:     `1px solid ${accentDim}`,
          borderTop:  'none',
          background: 'var(--bg-elevated)',
          boxShadow:  '0 8px 32px rgba(0,0,0,.6)',
          display:    'flex',
          flexDirection: 'column',
          gap:        0,
        }}>

          {/* Description */}
          <div style={{
            padding:    '8px 12px 6px',
            fontFamily: 'var(--font-mono)', fontSize: 8,
            color:      'var(--text-muted)', lineHeight: 1.7,
            borderBottom: '1px solid var(--border-dim)',
          }}>
            The field that <span style={{ color: accent }}>uniquely identifies a match</span> across all bookmakers.
            Every parser will use this as{' '}
            <code style={{ color: accent, background: accent + '10', padding: '0 4px' }}>
              parent_match_id
            </code>{' '}
            — the key that joins data in <code style={{ color: 'var(--cyan)' }}>UnifiedMatch</code>.
          </div>

          {/* Manual field input */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-dim)',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 7,
              letterSpacing: 2, color: 'var(--text-muted)', flexShrink: 0, width: 80,
            }}>
              FIELD
            </span>
            <input
              value={value.field}
              onChange={e => onChange({ ...value, field: e.target.value })}
              onFocus={() => setFilterText(value.field)}
              placeholder="e.g.  event_id"
              autoFocus
              style={{
                flex: 1, background: 'var(--bg-base)',
                border: `1px solid ${value.field ? accentDim : 'var(--border-dim)'}`,
                color: 'var(--text-primary)',
                padding: '5px 9px',
                fontFamily: 'var(--font-mono)', fontSize: 11,
                outline: 'none', transition: 'border-color .15s',
              }}
            />
          </div>

          {/* Optional expression override */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px 8px',
            borderBottom: '1px solid var(--border-dim)',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 7,
              letterSpacing: 2, color: 'var(--text-muted)', flexShrink: 0, width: 80,
            }}>
              EXPR <span style={{ opacity: .4 }}>(opt)</span>
            </span>
            <input
              value={value.expression}
              onChange={e => onChange({ ...value, expression: e.target.value })}
              placeholder="e.g.  item['data']['event_id']   — leave blank to auto"
              style={{
                flex: 1, background: 'var(--bg-base)',
                border: '1px solid var(--border-dim)',
                color: 'var(--text-secondary)',
                padding: '5px 9px',
                fontFamily: 'var(--font-mono)', fontSize: 10,
                outline: 'none',
              }}
            />
          </div>

          {/* Suggestion search + list */}
          {suggestions.length > 0 && (
            <div>
              {/* Filter input */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px',
                borderBottom: '1px solid var(--border-dim)',
                background: 'rgba(0,0,0,.2)',
              }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 8,
                  color: 'var(--text-muted)', flexShrink: 0,
                }}>
                  🔍
                </span>
                <input
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                  placeholder="filter detected fields…"
                  style={{
                    flex: 1, background: 'transparent', border: 'none',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)', fontSize: 9,
                    outline: 'none',
                  }}
                />
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 7,
                  color: 'var(--text-muted)',
                }}>
                  {filtered.length} field{filtered.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Suggestion rows */}
              <div style={{ maxHeight: 220, overflow: 'auto' }}>

                {/* Top ID-like suggestions */}
                {topSuggestions.length > 0 && (
                  <div>
                    <div style={{
                      padding: '4px 12px 2px',
                      fontFamily: 'var(--font-mono)', fontSize: 7,
                      letterSpacing: 2, color: accent + 'aa',
                      background: accent + '06',
                    }}>
                      LIKELY MATCH IDs
                    </div>
                    {topSuggestions.map(s => (
                      <SuggestionRow
                        key={s.key}
                        s={s}
                        isSelected={value.field === s.key}
                        isHovered={hoveredKey === s.key}
                        accent={accent}
                        onSelect={() => selectSuggestion(s)}
                        onHover={setHoveredKey}
                      />
                    ))}
                  </div>
                )}

                {/* Remaining fields */}
                {restSuggestions.length > 0 && (
                  <div>
                    <div style={{
                      padding: '4px 12px 2px',
                      fontFamily: 'var(--font-mono)', fontSize: 7,
                      letterSpacing: 2, color: 'var(--text-muted)',
                      borderTop: topSuggestions.length > 0 ? '1px solid var(--border-dim)' : 'none',
                    }}>
                      OTHER FIELDS
                    </div>
                    {restSuggestions.map(s => (
                      <SuggestionRow
                        key={s.key}
                        s={s}
                        isSelected={value.field === s.key}
                        isHovered={hoveredKey === s.key}
                        accent={accent}
                        onSelect={() => selectSuggestion(s)}
                        onHover={setHoveredKey}
                      />
                    ))}
                  </div>
                )}

                {filtered.length === 0 && (
                  <div style={{
                    padding: '12px', fontFamily: 'var(--font-mono)',
                    fontSize: 8, color: 'var(--text-muted)', textAlign: 'center' as const,
                  }}>
                    No fields match "{filterText}"
                  </div>
                )}
              </div>
            </div>
          )}

          {suggestions.length === 0 && (
            <div style={{
              padding: '10px 12px', fontFamily: 'var(--font-mono)',
              fontSize: 8, color: 'var(--text-muted)',
            }}>
              No suggestions — probe the endpoint first to auto-detect fields.
            </div>
          )}

          {/* Footer buttons */}
          <div style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '8px 12px',
            borderTop: '1px solid var(--border-dim)',
            background: 'rgba(0,0,0,.2)',
          }}>
            {isSet && (
              <button onClick={clear} style={{
                background: 'none',
                border: '1px solid rgba(255,61,90,.3)',
                color: 'var(--red)',
                fontFamily: 'var(--font-mono)', fontSize: 7,
                letterSpacing: 1, padding: '4px 12px', cursor: 'pointer',
              }}>
                CLEAR
              </button>
            )}
            <button onClick={() => setOpen(false)} style={{
              background: isSet ? accentFill : 'none',
              border: `1px solid ${isSet ? accentDim : 'var(--border-dim)'}`,
              color: isSet ? accent : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)', fontSize: 7,
              letterSpacing: 1, padding: '4px 14px', cursor: 'pointer',
            }}>
              {isSet ? '✓ DONE' : 'CLOSE'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Suggestion row sub-component ─────────────────────────────────────────────

function SuggestionRow({
  s, isSelected, isHovered, accent, onSelect, onHover,
}: {
  s:          Suggestion;
  isSelected: boolean;
  isHovered:  boolean;
  accent:     string;
  onSelect:   () => void;
  onHover:    (key: string | null) => void;
}) {
  const isIdLike = s.score >= 70;
  const bg = isSelected
    ? accent + '18'
    : isHovered ? 'rgba(255,255,255,.03)' : 'transparent';
  const keyColor = isSelected
    ? accent
    : isIdLike ? 'rgba(255,210,60,.85)' : 'var(--text-secondary)';

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => onHover(s.key)}
      onMouseLeave={() => onHover(null)}
      style={{
        display:    'flex',
        alignItems: 'center',
        gap:        10,
        padding:    '5px 12px',
        cursor:     'pointer',
        background: bg,
        borderLeft: isSelected ? `2px solid ${accent}` : '2px solid transparent',
        transition: 'background .1s',
      }}
    >
      {/* Key name */}
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9,
        color:      keyColor, minWidth: 120, flexShrink: 0,
        fontWeight: isSelected ? 700 : 400,
      }}>
        {isIdLike && !isSelected && (
          <span style={{ color: 'rgba(255,210,60,.5)', marginRight: 4 }}>⬡</span>
        )}
        {isSelected && (
          <span style={{ color: accent, marginRight: 4 }}>✓</span>
        )}
        {s.key}
      </span>

      {/* Path */}
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 7,
        color: 'var(--text-muted)', flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
      }}>
        {s.path}
      </span>

      {/* Sample value */}
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 8,
        color: 'rgba(6,182,212,.7)',
        maxWidth: 100,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
        flexShrink: 0,
      }}>
        {s.sampleVal}
      </span>
    </div>
  );
}