// parser/parserTypes.ts
// ─────────────────────────────────────────────────────────────────────────────
// All shared types for the parser panel and its sub-components.

/** Keys the backend parser validator requires on every output row */
export const REQUIRED_PARSER_KEYS = [
  'parent_match_id',
  'home_team',
  'away_team',
  'start_time',
  'sport',
  'competition',
  'market',
  'selection',
  'price',
  'specifier',
] as const;

export type RequiredParserKey = typeof REQUIRED_PARSER_KEYS[number];

// ─── Market catalogue ─────────────────────────────────────────────────────────

export interface MarketDef {
  name:        string;
  slug:        string;
  description: string;
  sport:       string | null;
  is_primary?: boolean;
}

export interface MarketCatalogueResponse {
  ok:              boolean;
  sport:           string | null;
  total:           number;
  primary_markets: MarketDef[];
  markets:         MarketDef[];
  coverage_info?: {
    match_list_requires:  MarketDef[];
    full_market_expected: number;
    threshold_pct:        number;
  };
}

// ─── Coverage result ──────────────────────────────────────────────────────────

export interface MarketCoverageResult {
  ok:              boolean;
  workflow_type:   string;
  sport:           string | null;
  coverage_pct:    number;
  present_markets: string[];
  missing_markets: MarketDef[];
  extra_markets:   string[];
  expected_count:  number;
  present_count:   number;
  error:           string | null;
  warnings:        string[];
}

// ─── Parser test result ───────────────────────────────────────────────────────

export interface ParsedRow {
  parent_match_id?: string;
  home_team?:       string;
  away_team?:       string;
  start_time?:      string | null;
  sport?:           string | null;
  competition?:     string | null;
  market?:          string;
  selection?:       string;
  price?:           number;
  specifier?:       string | null;
  [key: string]:    unknown;
}

export interface ParserTestResult {
  ok:                boolean;
  rows:              ParsedRow[];
  row_count:         number;
  valid_count:       number;
  validation_errors: string[];
  error:             string | null;
  elapsed_ms:        number;
  warnings?:         string[];
  market_coverage?:  MarketCoverageResult | null;
}

// ─── Parser panel per-bookmaker state ────────────────────────────────────────

export type ParserTestStatus = 'idle' | 'running' | 'ok' | 'error' | 'coverage_warn';

export interface ParserState {
  code:           string;
  sampleJson:     string;         // raw JSON string in left pane
  testStatus:     ParserTestStatus;
  testResult:     ParserTestResult | null;
  saveStatus:     'idle' | 'saving' | 'saved' | 'error';
  saveMsg:        string;
  splitPct:       number;         // left pane width % (10–90)
  showCoverage:   boolean;
}

export function mkParserState(): ParserState {
  return {
    code:         DEFAULT_PARSER_CODE,
    sampleJson:   '{}',
    testStatus:   'idle',
    testResult:   null,
    saveStatus:   'idle',
    saveMsg:      '',
    splitPct:     38,
    showCoverage: true,
  };
}

// ─── Workflow type groups ─────────────────────────────────────────────────────

export const MATCH_LIST_TYPES = new Set([
  'MATCH_LIST', 'LIVE_MATCHES', 'FIXTURE_LIST', 'LIST',
]);

// ─── Default parser template ──────────────────────────────────────────────────

export const DEFAULT_PARSER_CODE = `def parse_data(raw_data):
    """
    Convert raw bookmaker JSON into unified match rows.

    Each dict in the returned list must contain:
      parent_match_id, home_team, away_team, market,
      selection, price (float > 1.0), specifier (str|None)

    Optional but recommended:
      start_time, sport, competition
    """
    rows = []

    # TODO: adapt paths to your bookmaker's response structure
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
