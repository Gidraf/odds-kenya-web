// parser/MarketCoveragePanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Displays market coverage results from the parser test API.
// Shows coverage percentage, missing markets list (all of them),
// extra markets, and catalogue viewer.

import { useState, useEffect } from 'react';
import type { MarketCoverageResult, MarketDef, MarketCatalogueResponse } from './parserTypes';

const s = {
  mono:  { fontFamily: 'var(--font-mono)', fontSize: 9 } as React.CSSProperties,
  label: { fontFamily: 'var(--font-mono)', fontSize: 7, letterSpacing: 2, color: 'var(--text-muted)' } as React.CSSProperties,
};

// ─── Coverage bar ─────────────────────────────────────────────────────────────

function CoverageBar({ pct, ok }: { pct: number; ok: boolean }) {
  const fill  = ok ? 'var(--acid)' : pct > 25 ? 'rgba(251,146,60,.9)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,.06)', position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${Math.min(100, pct)}%`,
          background: fill,
          transition: 'width .6s ease',
        }} />
        {/* 50% marker */}
        <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: 1, background: 'rgba(255,255,255,.15)' }} />
      </div>
      <span style={{ ...s.mono, fontSize: 11, fontWeight: 700, color: fill, minWidth: 44, textAlign: 'right' as const }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ─── Market chip ─────────────────────────────────────────────────────────────

function MarketChip({ m, variant }: { m: MarketDef; variant: 'present' | 'missing' | 'extra' }) {
  const [tip, setTip] = useState(false);
  const color = variant === 'present' ? 'rgba(198,241,53,.7)' : variant === 'extra' ? 'rgba(6,182,212,.6)' : 'rgba(251,146,60,.6)';
  const bg    = variant === 'present' ? 'rgba(198,241,53,.06)' : variant === 'extra' ? 'rgba(6,182,212,.06)' : 'rgba(251,146,60,.05)';
  const border = variant === 'present' ? 'rgba(198,241,53,.2)' : variant === 'extra' ? 'rgba(6,182,212,.2)' : 'rgba(251,146,60,.2)';

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: bg, border: `1px solid ${border}`, cursor: 'default', position: 'relative' as const }}
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <span style={{ ...s.mono, fontSize: 8, color }}>{m.name}</span>
      {m.sport && <span style={{ ...s.mono, fontSize: 6, color: 'var(--text-muted)', opacity: .6 }}>{m.sport}</span>}
      {tip && m.description && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, zIndex: 500,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
          padding: '5px 9px', whiteSpace: 'nowrap', pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,.6)',
        }}>
          <div style={{ ...s.mono, fontSize: 8, color: 'var(--text-secondary)' }}>{m.description}</div>
          <div style={{ ...s.mono, fontSize: 7, color: 'var(--text-muted)', marginTop: 2 }}>slug: {m.slug}</div>
        </div>
      )}
    </span>
  );
}

// ─── Missing markets table ────────────────────────────────────────────────────

function MissingMarketsTable({ missing }: { missing: MarketDef[] }) {
  const [search, setSearch] = useState('');
  const filtered = missing.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.slug.includes(search.toLowerCase())
  );
  const primary = filtered.filter(m => m.is_primary);
  const rest    = filtered.filter(m => !m.is_primary);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={s.label}>MISSING ({missing.length})</label>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="filter…"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 9, padding: '3px 8px', outline: 'none', flex: 1, maxWidth: 180 }}
        />
      </div>

      {/* Primary markets highlighted first */}
      {primary.length > 0 && (
        <div style={{ padding: '6px 10px', background: 'rgba(255,61,90,.06)', border: '1px solid rgba(255,61,90,.2)' }}>
          <div style={{ ...s.label, marginBottom: 5, color: 'var(--red)' }}>REQUIRED PRIMARY MARKETS MISSING</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {primary.map(m => <MarketChip key={m.slug} m={m} variant="missing" />)}
          </div>
        </div>
      )}

      {/* Rest */}
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 3, padding: '4px 0', alignContent: 'flex-start' }}>
        {rest.map(m => <MarketChip key={m.slug} m={m} variant="missing" />)}
        {filtered.length === 0 && (
          <span style={{ ...s.mono, color: 'var(--text-muted)', fontSize: 8 }}>No results</span>
        )}
      </div>
    </div>
  );
}

// ─── Full catalogue viewer ────────────────────────────────────────────────────

function CatalogueViewer({ sport, apiBase }: { sport: string | null; apiBase: string }) {
  const [open,      setOpen]      = useState(false);
  const [catalogue, setCatalogue] = useState<MarketCatalogueResponse | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [search,    setSearch]    = useState('');

  const load = async () => {
    if (catalogue) return;
    setLoading(true);
    try {
      const url = sport ? `${apiBase}/markets/${encodeURIComponent(sport)}` : `${apiBase}/markets`;
      const res = await fetch(url);
      const d   = await res.json();
      setCatalogue(d);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const onToggle = () => {
    if (!open) load();
    setOpen(o => !o);
  };

  const filtered = (catalogue?.markets ?? []).filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.slug.includes(search.toLowerCase())
  );

  return (
    <div>
      <button
        onClick={onToggle}
        style={{ background: 'none', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
      >
        <span>{open ? '▲' : '▼'}</span>
        <span>VIEW FULL CATALOGUE {sport ? `(${sport})` : ''}</span>
        {catalogue && <span style={{ color: 'rgba(198,241,53,.5)' }}>({catalogue.total})</span>}
      </button>

      {open && (
        <div style={{ border: '1px solid var(--border-dim)', borderTop: 'none', background: 'var(--bg-base)' }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-dim)', display: 'flex', gap: 8 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="search markets…"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 9, outline: 'none', flex: 1 }}
            />
            {catalogue?.primary_markets?.map(m => (
              <span key={m.slug} style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '2px 6px', background: 'rgba(198,241,53,.1)', border: '1px solid rgba(198,241,53,.3)', color: 'var(--acid)' }}>
                ★ {m.name}
              </span>
            ))}
          </div>
          {loading && (
            <div style={{ padding: '12px', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', textAlign: 'center' as const }}>Loading…</div>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(m => (
              <div key={m.slug} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 0, borderBottom: '1px solid rgba(255,255,255,.03)', padding: '4px 10px', alignItems: 'center' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.025)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: m.is_primary ? 'var(--acid)' : 'var(--text-secondary)' }}>
                  {m.is_primary && '★ '}{m.name}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{m.slug}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', opacity: .7 }}>{m.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main MarketCoveragePanel ─────────────────────────────────────────────────

interface MarketCoveragePanelProps {
  coverage:   MarketCoverageResult;
  sport:      string | null;
  apiBase:    string;
  compact?:   boolean;
}

export function MarketCoveragePanel({ coverage, sport, apiBase, compact = false }: MarketCoveragePanelProps) {
  const [tab, setTab] = useState<'missing' | 'present' | 'extra'>('missing');

  const pct     = coverage.coverage_pct;
  const ok      = coverage.ok;
  const isMatch = coverage.workflow_type === 'MATCH_LIST' || coverage.workflow_type === 'FIXTURE_LIST' || coverage.workflow_type === 'LIVE_MATCHES';

  const statusColor = ok ? 'var(--acid)' : 'var(--red)';
  const statusText  = ok
    ? (pct === 100 ? '✓ FULL COVERAGE' : `✓ ${pct.toFixed(0)}% COVERAGE`)
    : `✗ COVERAGE TOO LOW (${pct.toFixed(0)}%)`;

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: ok ? 'rgba(198,241,53,.04)' : 'rgba(255,61,90,.04)', border: `1px solid ${ok ? 'rgba(198,241,53,.15)' : 'rgba(255,61,90,.2)'}` }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: statusColor, letterSpacing: 1 }}>{statusText}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>
          {coverage.present_count}/{coverage.expected_count} markets
        </span>
        {coverage.missing_markets.length > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(251,146,60,.7)' }}>
            {coverage.missing_markets.length} missing
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${ok ? 'rgba(198,241,53,.2)' : 'rgba(255,61,90,.25)'}`, background: ok ? 'rgba(198,241,53,.02)' : 'rgba(255,61,90,.02)' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${ok ? 'rgba(198,241,53,.1)' : 'rgba(255,61,90,.15)'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: statusColor, fontWeight: 700 }}>
          {statusText}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
          {coverage.present_count}/{coverage.expected_count} expected · {coverage.workflow_type}
          {sport ? ` · ${sport}` : ''}
        </span>
        {isMatch && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(6,182,212,.7)', border: '1px solid rgba(6,182,212,.3)', padding: '1px 6px', marginLeft: 'auto' }}>
            MATCH-LIST MODE
          </span>
        )}
      </div>

      {/* Coverage bar */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-dim)' }}>
        <CoverageBar pct={pct} ok={ok} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>0%</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'rgba(255,255,255,.15)' }}>50% threshold</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>100%</span>
        </div>
      </div>

      {/* Error message */}
      {coverage.error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,61,90,.04)', borderBottom: '1px solid rgba(255,61,90,.15)', fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)', lineHeight: 1.6, wordBreak: 'break-word' as const }}>
          {coverage.error}
        </div>
      )}

      {/* Warnings */}
      {coverage.warnings?.length > 0 && (
        <div style={{ padding: '6px 12px', background: 'rgba(251,146,60,.04)', borderBottom: '1px solid rgba(251,146,60,.15)' }}>
          {coverage.warnings.map((w, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(251,146,60,.8)' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)' }}>
        {([
          ['missing', `MISSING (${coverage.missing_markets.length})`],
          ['present', `PRESENT (${coverage.present_markets.length})`],
          ['extra',   `EXTRA (${coverage.extra_markets.length})`],
        ] as const).map(([t, lbl]) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t ? (t === 'missing' ? 'rgba(255,61,90,.7)' : t === 'present' ? 'var(--acid)' : 'rgba(6,182,212,.6)') : 'transparent'}`,
              fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5,
              color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
              padding: '6px 12px', cursor: 'pointer',
            }}
          >
            {lbl}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: '10px 12px' }}>
        {tab === 'missing' && (
          coverage.missing_markets.length === 0
            ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--acid)' }}>✓ All expected markets present</span>
            : <MissingMarketsTable missing={coverage.missing_markets} />
        )}
        {tab === 'present' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {coverage.present_markets.length === 0
              ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>None</span>
              : coverage.present_markets.map(name => (
                  <span key={name} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(198,241,53,.7)', padding: '2px 7px', background: 'rgba(198,241,53,.05)', border: '1px solid rgba(198,241,53,.15)' }}>{name}</span>
                ))
            }
          </div>
        )}
        {tab === 'extra' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {coverage.extra_markets.length === 0
              ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>None — all markets match catalogue</span>
              : coverage.extra_markets.map(name => (
                  <span key={name} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(6,182,212,.7)', padding: '2px 7px', background: 'rgba(6,182,212,.05)', border: '1px solid rgba(6,182,212,.15)' }}>{name}</span>
                ))
            }
          </div>
        )}
      </div>

      {/* Catalogue viewer */}
      <div style={{ padding: '0 12px 10px' }}>
        <CatalogueViewer sport={sport} apiBase={apiBase} />
      </div>
    </div>
  );
}
