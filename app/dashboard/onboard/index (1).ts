// parser/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Barrel export — import everything from './parser'

export { ParserPanel }               from './ParserPanel';
export { SplitPane }                 from './SplitPane';
export { CodeEditor }                from './CodeEditor';
export { MarketCoveragePanel }       from './MarketCoveragePanel';
export { ParserResultsTable }        from './ParserResultsTable';
export { BookmakerPanelWithParser }  from './BookmakerPanelWithParser';

export {
  mkParserState,
  DEFAULT_PARSER_CODE,
  REQUIRED_PARSER_KEYS,
  MATCH_LIST_TYPES,
} from './parserTypes';

export type {
  ParserState,
  ParserTestResult,
  MarketCoverageResult,
  MarketDef,
  MarketCatalogueResponse,
  ParsedRow,
  ParserTestStatus,
} from './parserTypes';

export {
  buildMergedJson,
  generateDefaultParser,
  tryParseJson,
  fmtMs,
  countUniqueMarkets,
  countUniqueMatches,
} from './parserUtils';
