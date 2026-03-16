// parser/parserUtils.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions for the parser panel. No React imports.

import type { FieldDescriptor } from '../EndpointResearch'; // adjust import path

// Re-export from EndpointResearch module shape — keep utils self-contained
export interface DraftStepSlim {
  position:          number;
  name:              string;
  step_type:         string;
  result_array_path: string;
  fields:            FieldDescriptor[];
  firstItem:         Record<string, unknown> | null;
}

// ─── buildMergedJson ──────────────────────────────────────────────────────────
// Combines all step firstItems into a single representative JSON object.
// Step 1 → root level; subsequent steps → nested under _step_key.

export function buildMergedJson(steps: DraftStepSlim[]): Record<string, unknown> {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const merged: Record<string, unknown> = {};

  sorted.forEach((step, idx) => {
    const item = step.firstItem ?? {};
    if (idx === 0) {
      Object.assign(merged, item);
      step.fields.forEach(f => {
        if (!(f.path in merged)) merged[f.label || f.role] = f.sample ?? null;
      });
    } else {
      const key = `_${step.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `step${step.position}`}`;
      const nested: Record<string, unknown> = { ...item };
      step.fields.forEach(f => {
        if (!(f.path in nested)) nested[f.label || f.role] = f.sample ?? null;
      });
      // For FETCH_PER_ITEM / market steps, wrap in array so parser template
      // can use list iteration patterns
      if (step.step_type === 'FETCH_PER_ITEM') {
        merged[key] = [nested];
      } else {
        merged[key] = nested;
      }
    }
  });

  return merged;
}

// ─── generateDefaultParser ────────────────────────────────────────────────────
// Inspects step field roles to produce a working parse_data() template.

interface FieldRoleMap {
  match_id?:       string;
  parent_match_id?:string;
  home_team?:      string;
  away_team?:      string;
  start_time?:     string;
  sport?:          string;
  competition?:    string;
  market_name?:    string;
  specifier?:      string;
  selection_name?: string;
  selection_price?:string;
  [role: string]:  string | undefined;
}

function findPath(fields: FieldDescriptor[], role: string): string | null {
  const f = fields.find(f => f.role === role);
  return f ? f.path : null;
}

export function generateDefaultParser(steps: DraftStepSlim[]): string {
  const sorted  = [...steps].sort((a, b) => a.position - b.position);
  const step1   = sorted[0];
  const step2   = sorted[1];
  const isMulti = sorted.length > 1;

  if (!step1) {
    return `def parse_data(raw_data):
    rows = []
    # TODO: adapt to your bookmaker's JSON structure
    return rows
`;
  }

  // Role-to-path maps per step
  const s1fields = step1.fields;
  const s2fields = step2?.fields ?? [];

  const s1: FieldRoleMap = {
    match_id:    findPath(s1fields, 'match_id')    ?? findPath(s1fields, 'parent_match_id') ?? 'id',
    home_team:   findPath(s1fields, 'home_team')   ?? 'home_team',
    away_team:   findPath(s1fields, 'away_team')   ?? 'away_team',
    start_time:  findPath(s1fields, 'start_time')  ?? 'start_time',
    sport:       findPath(s1fields, 'sport')        ?? 'sport',
    competition: findPath(s1fields, 'competition') ?? 'competition',
  };

  // For step 2 / market step
  const s2: FieldRoleMap = {
    market_name:     findPath(s2fields, 'market_name')     ?? findPath(s2fields, 'market') ?? 'market',
    specifier:       findPath(s2fields, 'specifier')       ?? 'specifier',
    selection_name:  findPath(s2fields, 'selection_name')  ?? findPath(s2fields, 'selection') ?? 'name',
    selection_price: findPath(s2fields, 'selection_price') ?? findPath(s2fields, 'price')    ?? 'price',
  };

  // Step 1 array accessor
  const s1ArrayKey = step1.result_array_path
    ? `raw_data.get(${JSON.stringify(step1.result_array_path)}, [])`
    : `raw_data if isinstance(raw_data, list) else raw_data.get('events', [])`;

  // Step 2 key (nested under merged root)
  const s2key = step2
    ? `_${step2.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `step${step2.position}`}`
    : '_markets';
  const s2ArrayPath = step2?.result_array_path ?? 'markets';

  const pathGet = (obj: string, path: string): string => {
    const parts = path.split('.');
    if (parts.length === 1) return `${obj}.get(${JSON.stringify(parts[0])}, '')`;
    // Build chained .get() safely
    let expr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      expr = `(${expr}.get(${JSON.stringify(parts[i])}) or {})`;
    }
    return `${expr}.get(${JSON.stringify(parts[parts.length - 1])}, '')`;
  };

  if (!isMulti) {
    // Single-step parser — flat market structure
    return `def parse_data(raw_data):
    """
    Single-step parser: events with embedded markets.
    Adapt paths to match your bookmaker's actual JSON shape.
    """
    rows = []
    events = ${s1ArrayKey}

    for event in events:
        base = {
            'parent_match_id': str(${pathGet('event', s1.match_id!)}),
            'home_team':       ${pathGet('event', s1.home_team!)},
            'away_team':       ${pathGet('event', s1.away_team!)},
            'start_time':      event.get(${JSON.stringify(s1.start_time)}, None),
            'sport':           event.get(${JSON.stringify(s1.sport)}, None),
            'competition':     event.get(${JSON.stringify(s1.competition)}, None),
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

  // Multi-step parser
  return `def parse_data(raw_data):
    """
    Multi-step parser.
    Step 1 (${step1.name}): match/event list at root.
    Step 2 (${step2?.name ?? 'markets'}): market data nested under '${s2key}'.

    raw_data shape (merged from both steps):
      {
        parent_match_id: ...,  # from step 1
        home_team: ...,
        ...
        '${s2key}': [ ... ]    # from step 2 — list of market rows
      }
    """
    rows = []

    # ── Extract base match fields from root ────────────────────────────────────
    base = {
        'parent_match_id': str(${pathGet('raw_data', s1.match_id!)}),
        'home_team':       ${pathGet('raw_data', s1.home_team!)},
        'away_team':       ${pathGet('raw_data', s1.away_team!)},
        'start_time':      raw_data.get(${JSON.stringify(s1.start_time)}, None),
        'sport':           raw_data.get(${JSON.stringify(s1.sport)}, None),
        'competition':     raw_data.get(${JSON.stringify(s1.competition)}, None),
    }

    # ── Iterate market rows from step 2 ───────────────────────────────────────
    market_data = raw_data.get(${JSON.stringify(s2key)}, [])
    if isinstance(market_data, dict):
        market_data = [market_data]

    for mkt in market_data:
        market_name = ${pathGet('mkt', s2.market_name!)  }
        specifier   = mkt.get(${JSON.stringify(s2.specifier)}, None)

        selections  = mkt.get('selections', [mkt])   # fallback: mkt itself is a selection
        for sel in selections:
            try:
                price = float(${pathGet('sel', s2.selection_price!)} or 0)
            except (TypeError, ValueError):
                price = 0.0

            rows.append({
                **base,
                'market':    market_name,
                'selection': ${pathGet('sel', s2.selection_name!)},
                'price':     price,
                'specifier': specifier,
            })

    return rows
`;
}

// ─── Validate JSON string ─────────────────────────────────────────────────────

export function tryParseJson(raw: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message ?? 'Invalid JSON' };
  }
}

// ─── Format elapsed time ──────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Count unique markets in rows ─────────────────────────────────────────────

export function countUniqueMarkets(rows: { market?: string }[]): number {
  return new Set(rows.map(r => r.market).filter(Boolean)).size;
}

export function countUniqueMatches(rows: { parent_match_id?: string }[]): number {
  return new Set(rows.map(r => r.parent_match_id).filter(Boolean)).size;
}
