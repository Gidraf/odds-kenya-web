// parser/BookmakerPanelWithParser.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Drop-in replacement for BookmakerWorkflowPanel that adds a BUILDER | PARSER
// tab toggle at the top. Import this in EndpointResearch instead of the
// inline BookmakerWorkflowPanel function.
//
// Usage in EndpointResearch (Step1):
//
//   Replace:
//     <BookmakerWorkflowPanel ... />
//
//   With:
//     <BookmakerPanelWithParser
//       key={activeTab}
//       bm={bmById(activeTab)!}
//       cfg={configs[activeTab]}
//       roles={roles}
//       reqTypes={reqTypes}
//       sports={sports}
//       sportId={sportId}
//       onChange={patch => updConfig(activeTab, patch)}
//     />
//
// Also add to BookmakerConfig type in EndpointResearch:
//   wfId?:         number | null;
//   parserState?:  import('./parser/parserTypes').ParserState;
//   activeSection?:'builder' | 'parser';

import { useMemo } from 'react';
import type { FieldRole } from '../EndpointResearch';     // adjust import path

import { ParserPanel }    from './ParserPanel';
import { mkParserState }  from './parserTypes';
import type { ParserState } from './parserTypes';

// ─── These types match EndpointResearch — inline here to stay self-contained ─

interface KV { key: string; value: string }
interface FieldDescriptor { path: string; role: string; label: string; store?: boolean; sample?: unknown }
type StepType = 'FETCH_LIST' | 'FETCH_PER_ITEM' | 'FETCH_ONCE';

interface DraftStep {
  localId:           string;
  position:          number;
  name:              string;
  step_type:         StepType;
  url_template:      string;
  method:            string;
  headers:           KV[];
  params:            KV[];
  body:              string;
  result_array_path: string;
  fields:            FieldDescriptor[];
  depends_on_pos:    number | null;
  field_mappings:    Record<string, string>;
  enabled:           boolean;
  notes:             string;
  probeStatus:       'idle' | 'probing' | 'ok' | 'error';
  probeResponse:     unknown;
  probeError:        string;
  probeHttpStatus:   number | null;
  firstItem:         Record<string, unknown> | null;
}

interface BookmakerOption { id: number; name: string; domain?: string }
interface SportOption     { id: number; name: string; slug?: string   }

interface BookmakerConfig {
  steps:          DraftStep[];
  workflowType:   string;
  wfName:         string;
  wfDesc:         string;
  saveStatus:     'idle' | 'saving' | 'saved' | 'error';
  saveMsg:        string;
  showTest:       boolean;
  // ── parser additions ──────────────────────────────────────────────────────
  wfId?:          number | null;
  parserState?:   ParserState;
  activeSection?: 'builder' | 'parser';
}

const s = {
  mono: { fontFamily: 'var(--font-mono)', fontSize: 9 } as React.CSSProperties,
};

// ─── Section toggle tab strip ─────────────────────────────────────────────────

function SectionTabs({
  active, onSwitch, parserState,
}: {
  active:      'builder' | 'parser';
  onSwitch:    (s: 'builder' | 'parser') => void;
  parserState: ParserState;
}) {
  const parserIcon =
    parserState.testStatus === 'ok'            ? '✓'
    : parserState.testStatus === 'error'       ? '✗'
    : parserState.testStatus === 'coverage_warn'? '⚠'
    : parserState.saveStatus === 'saved'       ? '✓'
    : '○';

  const parserColor =
    parserState.testStatus === 'ok'            ? 'var(--acid)'
    : parserState.testStatus === 'error'       ? 'var(--red)'
    : parserState.testStatus === 'coverage_warn'? 'rgba(251,146,60,.9)'
    : parserState.saveStatus === 'saved'       ? 'var(--acid)'
    : 'var(--text-muted)';

  const TAB: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer',
    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2,
    padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 6,
    borderBottom: '2px solid', whiteSpace: 'nowrap' as const,
  };

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
      <button
        onClick={() => onSwitch('builder')}
        style={{ ...TAB, color: active === 'builder' ? 'var(--acid)' : 'var(--text-muted)', borderBottomColor: active === 'builder' ? 'var(--acid)' : 'transparent', marginBottom: -1 }}
      >
        <span style={{ fontSize: 11 }}>⚒</span> BUILDER
      </button>
      <button
        onClick={() => onSwitch('parser')}
        style={{ ...TAB, color: active === 'parser' ? 'var(--acid)' : 'var(--text-muted)', borderBottomColor: active === 'parser' ? 'var(--acid)' : 'transparent', marginBottom: -1 }}
      >
        <span style={{ fontSize: 11, color: active === 'parser' ? 'var(--acid)' : parserColor }}>{'{ }'}</span>
        PARSER
        <span style={{ fontSize: 10, color: parserColor }}>{parserIcon}</span>
        {parserState.saveStatus === 'saved' && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, padding: '1px 5px', background: 'rgba(198,241,53,.1)', border: '1px solid rgba(198,241,53,.25)', color: 'var(--acid)' }}>SAVED</span>
        )}
      </button>
    </div>
  );
}

// ─── BookmakerPanelWithParser ─────────────────────────────────────────────────

interface Props {
  bm:       BookmakerOption;
  cfg:      BookmakerConfig;
  roles:    FieldRole[];
  reqTypes: string[];
  sports:   SportOption[];
  sportId:  number | null;
  onChange: (patch: Partial<BookmakerConfig>) => void;
  // Render the original builder DOM (passed as render prop to avoid re-implementing it)
  renderBuilder: () => React.ReactNode;
}

export function BookmakerPanelWithParser({
  bm, cfg, roles, reqTypes, sports, sportId,
  onChange, renderBuilder,
}: Props) {
  const section     = cfg.activeSection ?? 'builder';
  const parserState = cfg.parserState   ?? mkParserState();

  const sport = useMemo(() => {
    if (!sportId) return null;
    return sports.find(s => s.id === sportId)?.name ?? null;
  }, [sportId, sports]);

  // Slim steps for parser utils (no React state, just data)
  const slimSteps = useMemo(() =>
    cfg.steps.map(s => ({
      position:          s.position,
      name:              s.name,
      step_type:         s.step_type,
      result_array_path: s.result_array_path,
      fields:            s.fields,
      firstItem:         s.firstItem,
    })),
    [cfg.steps]
  );

  const setParserState = (patch: Partial<typeof parserState>) =>
    onChange({ parserState: { ...parserState, ...patch } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Section tabs */}
      <SectionTabs
        active={section}
        onSwitch={s => onChange({ activeSection: s })}
        parserState={parserState}
      />

      {/* Builder */}
      {section === 'builder' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {renderBuilder()}
        </div>
      )}

      {/* Parser — fixed height so split pane fills the viewport area */}
      {section === 'parser' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ParserPanel
            wfId={cfg.wfId ?? null}
            steps={slimSteps}
            sport={sport}
            workflowType={cfg.workflowType}
            state={parserState}
            onChange={setParserState}
          />
        </div>
      )}
    </div>
  );
}


// ─── Minimal README for integration ──────────────────────────────────────────
//
// 1. Add to BookmakerConfig (in EndpointResearch.tsx):
//
//    wfId?:          number | null;          // set from save response
//    parserState?:   import('./parser/parserTypes').ParserState;
//    activeSection?: 'builder' | 'parser';
//
// 2. When a workflow is saved successfully, store its ID:
//
//    updConfig(id, {
//      saveStatus: 'saved',
//      saveMsg:    `✓ Saved — workflow ID ${res.workflow_id}`,
//      wfId:       res.workflow_id ?? null,   // ← ADD THIS
//    });
//
// 3. Replace <BookmakerWorkflowPanel ...> with:
//
//    <BookmakerPanelWithParser
//      key={activeTab}
//      bm={bmById(activeTab)!}
//      cfg={configs[activeTab]}
//      roles={roles}
//      reqTypes={reqTypes}
//      sports={sports}
//      sportId={sportId}
//      onChange={patch => updConfig(activeTab, patch)}
//      renderBuilder={() => (
//        <BookmakerWorkflowPanel
//          bm={bmById(activeTab)!}
//          cfg={configs[activeTab]}
//          roles={roles}
//          reqTypes={reqTypes}
//          sports={sports}
//          sportId={sportId}
//          onChange={patch => updConfig(activeTab, patch)}
//        />
//      )}
//    />
//
// 4. In mkConfig, add defaults:
//
//    function mkConfig(defaultType: string): BookmakerConfig {
//      return {
//        ...,          // existing fields
//        wfId:          null,
//        parserState:   mkParserState(),
//        activeSection: 'builder',
//      };
//    }
