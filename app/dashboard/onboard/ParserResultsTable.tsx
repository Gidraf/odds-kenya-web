// parser/ParserResultsTable.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Displays parsed rows from a parser test run.
// Priority columns first, colour-coded by role, sticky header.

import { useState } from 'react';
import type { ParsedRow } from './parserTypes';
import { countUniqueMarkets, countUniqueMatches } from './parserUtils';

// Column display config
const PRIORITY_COLS: { key: string; color: string; label: string }[] = [
  { key: 'parent_match_id', color: '#a3e635',      label: 'MATCH ID'   },
  { key: 'home_team',       color: '#34d399',      label: 'HOME'       },
  { key: 'away_team',       color: '#34d399',      label: 'AWAY'       },
  { key: 'market',          color: 'var(--cyan)',  label: 'MARKET'     },
  { key: 'specifier',       color: 'rgba(6,182,212,.6)',   label: 'SPECIFIER'  },
  { key: 'selection',       color: '#38bdf8',      label: 'SELECTION'  },
  { key: 'price',           color: '#fb923c',      label: 'PRICE'      },
  { key: 'sport',           color: 'var(--text-muted)', label: 'SPORT'   },
  { key: 'competition',     color: 'var(--text-muted)', label: 'COMP'   },
  { key: 'start_time',      color: 'var(--text-muted)', label: 'START'  },
];

const MAX_ROWS = 80;

interface ParserResultsTableProps {
  rows:  ParsedRow[];
  total: number;
}

export function ParserResultsTable({ rows, total }: ParserResultsTableProps) {
  const [showAll, setShowAll] = useState(false);
  const displayed  = showAll ? rows.slice(0, MAX_ROWS) : rows.slice(0, 20);
  const uniqueMkt  = countUniqueMarkets(rows);
  const uniqueMatch = countUniqueMatches(rows);

  if (rows.length === 0) return null;

  // Discover extra columns beyond priority
  const priorityKeys   = new Set(PRIORITY_COLS.map(c => c.key));
  const extraKeys: string[] = [];
  rows.slice(0, 10).forEach(r => {
    Object.keys(r).forEach(k => { if (!priorityKeys.has(k) && !extraKeys.includes(k)) extraKeys.push(k); });
  });

  const allCols = [
    ...PRIORITY_COLS,
    ...extraKeys.map(k => ({ key: k, color: 'rgba(167,243,208,.5)', label: k.toUpperCase() })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 10px', background: 'rgba(198,241,53,.04)', borderBottom: '1px solid var(--border-dim)' }}>
        <StatPill label="ROWS"    value={total}       color="var(--acid)" />
        <StatPill label="MARKETS" value={uniqueMkt}   color="var(--cyan)" />
        <StatPill label="MATCHES" value={uniqueMatch} color="#a3e635"     />
        {total > MAX_ROWS && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(251,146,60,.7)', alignSelf: 'center', marginLeft: 'auto' }}>
            showing {displayed.length} of {total}
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' as const }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
            <tr style={{ background: '#040b04' }}>
              <th style={{ width: 36, padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', textAlign: 'left' as const, borderBottom: '1px solid var(--border-dim)' }}>#</th>
              {allCols.map(c => (
                <th key={c.key} style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: c.color, textAlign: 'left' as const, borderBottom: '1px solid var(--border-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map((row, i) => (
              <tr key={i}
                style={{ borderBottom: '1px solid rgba(255,255,255,.03)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.025)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{i + 1}</td>
                {allCols.map(c => {
                  const v = row[c.key as keyof ParsedRow];
                  const isPrice = c.key === 'price';
                  const str = v === null || v === undefined ? '—' : isPrice ? Number(v).toFixed(2) : String(v);
                  return (
                    <td key={c.key} title={str} style={{
                      padding: '3px 8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: isPrice ? 9 : 8,
                      fontWeight: isPrice ? 700 : 400,
                      color: v === null || v === undefined ? 'rgba(255,255,255,.1)' : c.color,
                      maxWidth: isPrice ? 60 : 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap' as const,
                    }}>
                      {str}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Show more */}
      {rows.length > 20 && (
        <button
          onClick={() => setShowAll(s => !s)}
          style={{ background: 'none', border: 'none', borderTop: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, padding: '6px 0', cursor: 'pointer', textAlign: 'center' as const, width: '100%' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--acid)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          {showAll ? `▲ SHOW LESS` : `▼ SHOW MORE (${rows.length - 20} remaining, max ${MAX_ROWS})`}
        </button>
      )}
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color }}>{value}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 1.5, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}
