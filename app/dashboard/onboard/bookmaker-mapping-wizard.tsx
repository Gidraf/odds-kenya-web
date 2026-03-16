'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Bookmaker { id: number; name: string; domain: string }
interface Sport     { id: number; name: string }

interface EndpointMap {
  id?: number;
  bookmaker_id: number;
  endpoint_type: 'MATCH_LIST' | 'MARKETS' | 'COMBINED';
  url: string;
  method: string;
  headers_json: string;
  curl_template: string;
  match_list_array_path: string;
  match_id_path: string;
  home_team_path: string;
  away_team_path: string;
  start_time_path: string;
  sport_path: string;
  competition_path: string;
  markets_array_path: string;
  market_name_path: string;
  specifier_path: string;
  selections_array_path: string;
  selection_name_path: string;
  selection_price_path: string;
  is_primary_bookmaker: boolean;
}

interface DiscoveredEntity { name: string; sport: string; checked?: boolean }
interface MarketMapping { alias_name: string; market_id: number | null; market_name: string | null; mapped: boolean; checked?: boolean }

type Step = 1 | 2 | 3 | 4 | 5;

const BASE = '/admin/mapping';
const api = {
  get:  (path: string) => fetchWithAuth(`${BASE}${path}`).then(r => r.json()),
  post: (path: string, body: unknown) =>
    fetchWithAuth(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  put:  (path: string, body: unknown) =>
    fetchWithAuth(`${BASE}${path}`, { method: 'PUT',  body: JSON.stringify(body) }).then(r => r.json()),
};

// ─── Shared atoms ─────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onClear, 3500); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  const err = msg.startsWith('✗');
  return (
    <div style={{ ...s.toast, borderColor: err ? 'rgba(255,61,90,.5)' : 'rgba(198,241,53,.5)',
      color: err ? '#ff3d5a' : '#c6f135' }}>{msg}</div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={s.label}>{label}</label>
      {children}
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
}

function Spinner() {
  return <span style={{ display: 'inline-block', animation: 'spin .8s linear infinite',
    fontSize: 14 }}>◌</span>;
}

function StepDot({ n, current, done }: { n: number; current: Step; done: boolean }) {
  const active = n === current;
  const bg = done ? '#c6f135' : active ? 'rgba(198,241,53,.15)' : 'transparent';
  const border = done ? '#c6f135' : active ? '#c6f135' : 'var(--border-dim)';
  const color  = done ? '#0a0a0a' : active ? '#c6f135' : 'var(--text-muted)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: bg, border: `1px solid ${border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color }}>
        {done ? '✓' : n}
      </div>
    </div>
  );
}

function PathInput({ label, value, onChange, hint, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={s.label}>{label}</label>
      <input
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder || 'e.g. events[].id'}
        style={{ ...s.input, fontFamily: '"Fira Code", monospace', fontSize: 11, width: '100%', boxSizing: 'border-box' }}
      />
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
}

function JsonTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (data === null || data === undefined) return <span style={{ color: '#94a3b8' }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: '#f59e0b' }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: '#06b6d4' }}>{data}</span>;
  if (typeof data === 'string') return <span style={{ color: '#a3e635' }}>"{data.length > 60 ? data.slice(0, 60) + '…' : data}"</span>;
  if (Array.isArray(data)) {
    if (!open) return (
      <span onClick={() => setOpen(true)} style={s.treeToggle}>
        [{data.length} items…]
      </span>
    );
    return (
      <span>
        <span onClick={() => setOpen(false)} style={s.treeToggle}>▾ [{data.length}]</span>
        <div style={{ marginLeft: 16 }}>
          {data.slice(0, 5).map((v, i) => (
            <div key={i}><span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{i}: </span><JsonTree data={v} depth={depth + 1} /></div>
          ))}
          {data.length > 5 && <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>…{data.length - 5} more</div>}
        </div>
      </span>
    );
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data as object);
    if (!open) return (
      <span onClick={() => setOpen(true)} style={s.treeToggle}>
        {'{' + keys.length + ' keys…}'}
      </span>
    );
    return (
      <span>
        <span onClick={() => setOpen(false)} style={s.treeToggle}>▾ {'{'}{keys.length}{'}'}</span>
        <div style={{ marginLeft: 16 }}>
          {keys.slice(0, 15).map(k => (
            <div key={k}>
              <span style={{ color: '#c084fc', fontSize: 11 }}>{k}</span>
              <span style={{ color: 'var(--text-muted)' }}>: </span>
              <JsonTree data={(data as Record<string, unknown>)[k]} depth={depth + 1} />
            </div>
          ))}
          {keys.length > 15 && <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>…{keys.length - 15} more</div>}
        </div>
      </span>
    );
  }
  return <span>{String(data)}</span>;
}

// ─── Step 1 — Select Bookmaker ────────────────────────────────────────────────

function Step1({ bookmakers, onSelect }: {
  bookmakers: Bookmaker[];
  onSelect: (b: Bookmaker, isPrimary: boolean) => void;
}) {
  const [search, setSearch]       = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const filtered = bookmakers?.filter(b =>
    (b.name || b.domain).toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <div style={s.stepHint}>
        Choose the bookmaker you want to onboard. Set it as <strong style={{ color: '#c6f135' }}>Primary</strong> if
        you want its team, competition, and sport names to be your canonical reference names.
      </div>
      <Field label="SEARCH BOOKMAKERS">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Type to filter…" style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
      </Field>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {filtered.map(b => (
          <button key={b.id} onClick={() => onSelect(b, isPrimary)}
            style={{ ...s.bkRow, textAlign: 'left' as const }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700 }}>{b.name || b.domain}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{b.domain}</div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={s.empty}>No bookmakers match "{search}"</div>
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <label style={{ ...s.checkRow }}>
          <input type="checkbox" checked={isPrimary} onChange={e => setIsPrimary(e.target.checked)} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#c6f135' }}>
            Set as primary bookmaker (use its names as canonical references)
          </span>
        </label>
      </div>
    </div>
  );
}

// ─── Step 2 — Configure Endpoint ─────────────────────────────────────────────

function Step2({
  bookmaker, map, onMapChange, onFetch, fetching, rawJson, fetchError,
}: {
  bookmaker: Bookmaker;
  map: Partial<EndpointMap>;
  onMapChange: (patch: Partial<EndpointMap>) => void;
  onFetch: () => void;
  fetching: boolean;
  rawJson: unknown;
  fetchError: string;
}) {
  return (
    <div>
      <div style={s.stepHint}>
        Configure the endpoint for <strong style={{ color: '#c6f135' }}>{bookmaker.name}</strong>.
        Paste the cURL command from your browser DevTools to fetch a live sample.
      </div>

      <div style={s.row2}>
        <Field label="ENDPOINT TYPE">
          <select value={map.endpoint_type || 'COMBINED'} onChange={e => onMapChange({ endpoint_type: e.target.value as EndpointMap['endpoint_type'] })} style={s.select}>
            <option value="COMBINED">COMBINED (matches + odds in one call)</option>
            <option value="MATCH_LIST">MATCH LIST (fixture list only)</option>
            <option value="MARKETS">MARKETS (odds per match)</option>
          </select>
        </Field>
        <Field label="HTTP METHOD">
          <select value={map.method || 'GET'} onChange={e => onMapChange({ method: e.target.value })} style={s.select}>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </Field>
      </div>

      <Field label="URL" hint="The full endpoint URL (can contain placeholders like {sport_id})">
        <input value={map.url || ''} onChange={e => onMapChange({ url: e.target.value })}
          placeholder="https://api.bookmaker.com/v2/sports/football/events"
          style={{ ...s.input, width: '100%', boxSizing: 'border-box', fontFamily: '"Fira Code", monospace', fontSize: 11 }} />
      </Field>

      <Field label="CURL TEMPLATE" hint="Paste the full curl command from DevTools — includes auth headers automatically">
        <textarea
          value={map.curl_template || ''} onChange={e => onMapChange({ curl_template: e.target.value })}
          placeholder={'curl "https://api.bookmaker.com/v2/events" \\\n  -H "authorization: Bearer TOKEN" \\\n  -H "x-api-key: KEY"'}
          style={{ ...s.textarea, height: 120 }}
        />
      </Field>

      <Field label="CUSTOM HEADERS (JSON)" hint='Optional: {"Authorization": "Bearer TOKEN"}'>
        <textarea value={map.headers_json || '{}'} onChange={e => onMapChange({ headers_json: e.target.value })}
          style={{ ...s.textarea, height: 80, fontFamily: '"Fira Code", monospace', fontSize: 11 }} />
      </Field>

      <button onClick={onFetch} disabled={fetching || !map.curl_template} style={{
        ...s.btnPrimary, opacity: (fetching || !map.curl_template) ? 0.5 : 1,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {fetching ? <><Spinner /> FETCHING…</> : '⬇ FETCH SAMPLE DATA'}
      </button>

      {fetchError && (
        <div style={s.errorBox}>{fetchError}</div>
      )}

      {rawJson && (
        <div style={{ marginTop: 16 }}>
          <div style={s.sectionHead}>RESPONSE PREVIEW</div>
          <div style={s.jsonBox}>
            <JsonTree data={rawJson} depth={0} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 3 — Map Accessor Paths ─────────────────────────────────────────────

function Step3({
  map, onMapChange, rawJson, onTest, testing, testResult,
}: {
  map: Partial<EndpointMap>;
  onMapChange: (patch: Partial<EndpointMap>) => void;
  rawJson: unknown;
  onTest: () => void;
  testing: boolean;
  testResult: Record<string, unknown> | null;
}) {
  return (
    <div>
      <div style={s.stepHint}>
        Define the JSON accessor paths for each field. Use dot-notation — add <code style={s.code}>[]</code> after a key to traverse an array.
        E.g. <code style={s.code}>events[].teams.home.name</code>
      </div>

      <div style={s.pathGrid}>
        {/* Left: Match fields */}
        <div>
          <div style={s.sectionHead}>MATCH LIST PATHS</div>
          <PathInput label="MATCHES ARRAY PATH"
            value={map.match_list_array_path || ''}
            onChange={v => onMapChange({ match_list_array_path: v })}
            hint='Path to the array of matches. Leave blank if root is an array.'
            placeholder="events  or  data.events  or  (blank)" />
          <PathInput label="MATCH ID PATH *"
            value={map.match_id_path || ''}
            onChange={v => onMapChange({ match_id_path: v })}
            placeholder="id" />
          <PathInput label="HOME TEAM PATH *"
            value={map.home_team_path || ''}
            onChange={v => onMapChange({ home_team_path: v })}
            placeholder="home  or  teams.home.name" />
          <PathInput label="AWAY TEAM PATH *"
            value={map.away_team_path || ''}
            onChange={v => onMapChange({ away_team_path: v })}
            placeholder="away  or  teams.away.name" />
          <PathInput label="START TIME PATH"
            value={map.start_time_path || ''}
            onChange={v => onMapChange({ start_time_path: v })}
            placeholder="startTime  or  kickoff_at" />
          <PathInput label="SPORT PATH"
            value={map.sport_path || ''}
            onChange={v => onMapChange({ sport_path: v })}
            placeholder="sport.name  or  sportName" />
          <PathInput label="COMPETITION PATH"
            value={map.competition_path || ''}
            onChange={v => onMapChange({ competition_path: v })}
            placeholder="league.name  or  competition" />
        </div>

        {/* Right: Market fields */}
        <div>
          <div style={s.sectionHead}>MARKET PATHS</div>
          <PathInput label="MARKETS ARRAY PATH"
            value={map.markets_array_path || ''}
            onChange={v => onMapChange({ markets_array_path: v })}
            placeholder="markets  or  odds.markets" />
          <PathInput label="MARKET NAME PATH"
            value={map.market_name_path || ''}
            onChange={v => onMapChange({ market_name_path: v })}
            placeholder="name  or  marketType" />
          <PathInput label="SPECIFIER PATH (optional)"
            value={map.specifier_path || ''}
            onChange={v => onMapChange({ specifier_path: v })}
            placeholder="specifier  or  line  (leave blank if N/A)" />
          <PathInput label="SELECTIONS ARRAY PATH"
            value={map.selections_array_path || ''}
            onChange={v => onMapChange({ selections_array_path: v })}
            placeholder="outcomes  or  selections" />
          <PathInput label="SELECTION NAME PATH"
            value={map.selection_name_path || ''}
            onChange={v => onMapChange({ selection_name_path: v })}
            placeholder="name  or  description" />
          <PathInput label="SELECTION PRICE PATH"
            value={map.selection_price_path || ''}
            onChange={v => onMapChange({ selection_price_path: v })}
            placeholder="odds  or  price  or  decimalOdds" />
        </div>
      </div>

      {/* JSON tree for reference */}
      {rawJson && (
        <div style={{ marginTop: 16 }}>
          <div style={s.sectionHead}>JSON REFERENCE</div>
          <div style={s.jsonBox}>
            <JsonTree data={rawJson} depth={0} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        <button onClick={onTest} disabled={testing} style={{
          ...s.btnSecondary, opacity: testing ? 0.5 : 1, display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {testing ? <><Spinner /> TESTING…</> : '⚡ TEST PATHS'}
        </button>
        {testResult && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10,
            color: testResult.ok ? '#c6f135' : '#ff3d5a' }}>
            {testResult.ok
              ? `✓ ${testResult.rows_count} rows extracted from ${testResult.matches_found} matches`
              : `✗ ${testResult.error}`}
          </span>
        )}
      </div>

      {testResult?.ok && (testResult.rows_preview as unknown[])?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={s.sectionHead}>EXTRACTED ROWS PREVIEW</div>
          <div style={s.jsonBox}>
            {(testResult.rows_preview as Record<string, unknown>[]).slice(0, 5).map((r, i) => (
              <div key={i} style={{ borderBottom: '1px solid var(--border-dim)', padding: '6px 0', fontSize: 11 }}>
                <span style={{ color: '#c6f135' }}>{String(r.home_team)} v {String(r.away_team)}</span>
                <span style={{ color: 'var(--text-muted)', margin: '0 8px' }}>·</span>
                <span style={{ color: '#06b6d4' }}>{String(r.market)}</span>
                {r.specifier && <span style={{ color: 'var(--text-muted)' }}> {String(r.specifier)}</span>}
                <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>→</span>
                <span style={{ color: '#a3e635' }}>{String(r.selection)}</span>
                <span style={{ color: '#f59e0b', marginLeft: 8 }}>{String(r.price)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 4 — Discover Entities ───────────────────────────────────────────────

function Step4({
  endpointMapId, bookmaker, onDone,
}: {
  endpointMapId: number;
  bookmaker: Bookmaker;
  onDone: () => void;
}) {
  const [loading, setLoading]   = useState(false);
  const [ingesting, setIngest]  = useState(false);
  const [ingestResult, setIR]   = useState<Record<string, unknown> | null>(null);
  const [data, setData]         = useState<{
    new_teams: DiscoveredEntity[];
    existing_teams: DiscoveredEntity[];
    new_competitions: DiscoveredEntity[];
    existing_competitions: DiscoveredEntity[];
    new_sports: { name: string }[];
  } | null>(null);
  const [checked, setChecked]   = useState<Record<string, boolean>>({});

  const discover = async () => {
    setLoading(true);
    const r = await api.post(`/endpoint-maps/${endpointMapId}/ingest-matches`, {});
    setLoading(false);
    if (r.ok === false) return;
    setData(r);
    const init: Record<string, boolean> = {};
    (r.new_teams || []).forEach((e: DiscoveredEntity) => { init[`t:${e.name}`] = true; });
    (r.new_competitions || []).forEach((e: DiscoveredEntity) => { init[`c:${e.name}`] = true; });
    (r.new_sports || []).forEach((e: { name: string }) => { init[`s:${e.name}`] = true; });
    setChecked(init);
  };

  useEffect(() => { discover(); }, []);

  const confirm = async () => {
    if (!data) return;
    setIngest(true);
    const body = {
      create_sports:       (data.new_sports       || []).filter(e => checked[`s:${e.name}`]),
      create_teams:        (data.new_teams         || []).filter(e => checked[`t:${e.name}`]),
      create_competitions: (data.new_competitions  || []).filter(e => checked[`c:${e.name}`]),
      create_aliases: true,
    };
    const r = await api.post(`/endpoint-maps/${endpointMapId}/confirm-ingest`, body);
    setIngest(false);
    setIR(r);
    if (r.ok) setTimeout(onDone, 1200);
  };

  const toggle = (key: string) => setChecked(p => ({ ...p, [key]: !p[key] }));

  if (loading) return <div style={s.loadState}><Spinner /> Scanning live data for teams &amp; competitions…</div>;

  return (
    <div>
      <div style={s.stepHint}>
        Review entities discovered from <strong style={{ color: '#c6f135' }}>{bookmaker.name}</strong>'s data.
        Check the ones you want to create in your database. Existing ones are shown for reference.
      </div>

      {data && (
        <>
          {/* New Sports */}
          {data.new_sports.length > 0 && (
            <EntitySection
              title="NEW SPORTS" color="#c6f135"
              items={data.new_sports.map(e => ({ name: e.name, sport: '' }))}
              checked={checked} keyPrefix="s:"
              onToggle={toggle}
            />
          )}

          {/* New Competitions */}
          {data.new_competitions.length > 0 && (
            <EntitySection
              title="NEW COMPETITIONS" color="#06b6d4"
              items={data.new_competitions}
              checked={checked} keyPrefix="c:"
              onToggle={toggle}
            />
          )}

          {/* New Teams */}
          {data.new_teams.length > 0 && (
            <EntitySection
              title="NEW TEAMS" color="#8b5cf6"
              items={data.new_teams}
              checked={checked} keyPrefix="t:"
              onToggle={toggle}
            />
          )}

          {/* Existing (read only) */}
          {(data.existing_teams.length + data.existing_competitions.length) > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ ...s.sectionHead, color: 'var(--text-muted)' }}>
                ALREADY IN DATABASE
                <span style={{ marginLeft: 8, fontWeight: 400 }}>
                  — {data.existing_teams.length} teams, {data.existing_competitions.length} competitions
                </span>
              </div>
            </div>
          )}

          {ingestResult?.ok && (
            <div style={s.successBox}>
              ✓ Created: {(ingestResult.created as Record<string, string[]>).sports?.length || 0} sports,
              {' '}{(ingestResult.created as Record<string, string[]>).teams?.length || 0} teams,
              {' '}{(ingestResult.created as Record<string, string[]>).competitions?.length || 0} competitions
            </div>
          )}

          <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
            <button onClick={confirm} disabled={ingesting} style={{
              ...s.btnPrimary, opacity: ingesting ? 0.5 : 1,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              {ingesting ? <><Spinner /> SAVING…</> : '✓ CONFIRM & SAVE SELECTED'}
            </button>
            <button onClick={onDone} style={s.btnGhost}>Skip this step</button>
          </div>
        </>
      )}
    </div>
  );
}

function EntitySection({ title, color, items, checked, keyPrefix, onToggle }: {
  title: string; color: string;
  items: DiscoveredEntity[]; checked: Record<string, boolean>;
  keyPrefix: string; onToggle: (k: string) => void;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...s.sectionHead, color }}>
        {title}
        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400 }}>
          {items.filter(e => checked[keyPrefix + e.name]).length} / {items.length} selected
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
        {items.map(e => (
          <label key={e.name} style={s.checkRow}>
            <input type="checkbox" checked={!!checked[keyPrefix + e.name]}
              onChange={() => onToggle(keyPrefix + e.name)} />
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-primary)' }}>{e.name}</span>
            {e.sport && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
              color: 'var(--text-muted)', background: 'rgba(255,255,255,.04)',
              padding: '1px 6px', border: '1px solid var(--border-dim)' }}>{e.sport}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Step 5 — Map Markets ─────────────────────────────────────────────────────

function Step5({
  endpointMapId, bookmaker, markets: allMarkets, onDone,
}: {
  endpointMapId: number;
  bookmaker: Bookmaker;
  markets: { id: number; name: string; slug: string }[];
  onDone: () => void;
}) {
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [mappings, setMappings] = useState<MarketMapping[]>([]);
  const [newMkt, setNewMkt]     = useState('');
  const [newSlug, setNewSlug]   = useState('');
  const [creating, setCreating] = useState(false);
  const [assigns, setAssigns]   = useState<Record<string, number | null>>({});

  const load = async () => {
    setLoading(true);
    const r = await api.post(`/endpoint-maps/${endpointMapId}/ingest-markets`, {});
    setLoading(false);
    if (r.markets) {
      setMappings(r.markets.map((m: MarketMapping) => ({ ...m, checked: !m.mapped })));
      const init: Record<string, number | null> = {};
      r.markets.forEach((m: MarketMapping) => { init[m.alias_name] = m.market_id ?? null; });
      setAssigns(init);
    }
  };

  useEffect(() => { load(); }, []);

  const createAndAssign = async (alias: string) => {
    if (!newMkt.trim()) return;
    setCreating(true);
    const r = await api.post('/markets/', { name: newMkt.trim(), slug: newSlug.trim() || undefined });
    setCreating(false);
    if (r.id) {
      setAssigns(p => ({ ...p, [alias]: r.id }));
      setNewMkt(''); setNewSlug('');
      // reload markets list externally — just update local
    }
  };

  const save = async () => {
    setSaving(true);
    const mappingList = Object.entries(assigns)
      .filter(([, mid]) => mid != null)
      .map(([alias_name, market_id]) => ({ alias_name, market_id }));
    await api.post('/markets/bulk-alias', {
      bookmaker_id: bookmaker.id,
      mappings: mappingList,
    });
    setSaving(false);
    onDone();
  };

  if (loading) return <div style={s.loadState}><Spinner /> Discovering markets from sample data…</div>;

  const unmapped = mappings.filter(m => !assigns[m.alias_name]);
  const mapped   = mappings.filter(m =>  assigns[m.alias_name]);

  return (
    <div>
      <div style={s.stepHint}>
        Map each market name used by <strong style={{ color: '#c6f135' }}>{bookmaker.name}</strong> to one of your
        canonical markets. Create new canonical markets if needed.
      </div>

      {unmapped.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={s.sectionHead}>UNMAPPED MARKETS
            <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400 }}>{unmapped.length} need assignment</span>
          </div>
          {unmapped.map(m => (
            <MarketRow key={m.alias_name} m={m} markets={allMarkets}
              value={assigns[m.alias_name] ?? null}
              onChange={v => setAssigns(p => ({ ...p, [m.alias_name]: v }))}
            />
          ))}
        </div>
      )}

      {/* Quick create canonical market */}
      <div style={s.createBox}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: '#c6f135', marginBottom: 10 }}>
          + CREATE NEW CANONICAL MARKET
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 2 }}>
            <label style={s.label}>DISPLAY NAME</label>
            <input value={newMkt} onChange={e => setNewMkt(e.target.value)}
              placeholder="e.g. Both Teams To Score" style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>SLUG (optional)</label>
            <input value={newSlug} onChange={e => setNewSlug(e.target.value)}
              placeholder="btts" style={{ ...s.input, width: '100%', boxSizing: 'border-box',
              fontFamily: '"Fira Code", monospace', fontSize: 11 }} />
          </div>
          <button onClick={() => createAndAssign('')} disabled={!newMkt.trim() || creating} style={{
            ...s.btnSecondary, opacity: (!newMkt.trim() || creating) ? 0.5 : 1,
            flexShrink: 0, padding: '9px 16px',
          }}>
            {creating ? <Spinner /> : '+ CREATE'}
          </button>
        </div>
      </div>

      {mapped.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...s.sectionHead, color: 'var(--text-muted)' }}>
            ALREADY MAPPED ({mapped.length})
          </div>
          {mapped.map(m => (
            <MarketRow key={m.alias_name} m={m} markets={allMarkets}
              value={assigns[m.alias_name] ?? null}
              onChange={v => setAssigns(p => ({ ...p, [m.alias_name]: v }))}
            />
          ))}
        </div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <button onClick={save} disabled={saving} style={{
          ...s.btnPrimary, opacity: saving ? 0.5 : 1, display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {saving ? <><Spinner /> SAVING…</> : '✓ SAVE MARKET MAPPINGS'}
        </button>
        <button onClick={onDone} style={s.btnGhost}>Skip</button>
      </div>
    </div>
  );
}

function MarketRow({ m, markets, value, onChange }: {
  m: MarketMapping;
  markets: { id: number; name: string }[];
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
      borderBottom: '1px solid var(--border-dim)' }}>
      <div style={{ flex: 1 }}>
        <span style={{ fontFamily: '"Fira Code", monospace', fontSize: 12, color: '#06b6d4',
          background: 'rgba(6,182,212,.08)', padding: '2px 8px',
          border: '1px solid rgba(6,182,212,.2)' }}>{m.alias_name}</span>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 16 }}>→</div>
      <div style={{ flex: 1 }}>
        <select value={value ?? ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
          style={{ ...s.select, width: '100%' }}>
          <option value="">— unassigned —</option>
          {markets.map(mk => <option key={mk.id} value={mk.id}>{mk.name}</option>)}
        </select>
      </div>
      {value && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: '#c6f135',
          border: '1px solid rgba(198,241,53,.3)', padding: '2px 6px' }}>MAPPED</span>
      )}
    </div>
  );
}

// ─── MAIN WIZARD ──────────────────────────────────────────────────────────────

export default function BookmakerOnboardWizard() {
  const [step, setStep]             = useState<Step>(1);
  const [toast, setToast]           = useState('');
  const [bookmaker, setBookmaker]   = useState<Bookmaker | null>(null);
  const [isPrimary, setIsPrimary]   = useState(false);
  const [map, setMap]               = useState<Partial<EndpointMap>>({
    endpoint_type: 'COMBINED', method: 'GET',
    headers_json: '{}', params_json: '{}',
  });
  const [rawJson, setRawJson]       = useState<unknown>(null);
  const [fetching, setFetching]     = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [savedMapId, setSavedMapId] = useState<number | null>(null);
  const [meta, setMeta]             = useState<{ bookmakers: Bookmaker[]; sports: Sport[] }>({
    bookmakers: [], sports: [],
  });
  const [allMarkets, setAllMarkets] = useState<{ id: number; name: string; slug: string }[]>([]);
  const [saving, setSaving]         = useState(false);

  useEffect(() => {
    api.get('/meta/').then(setMeta);
    api.get('/markets/?per_page=200').then(r => setAllMarkets(r.items || []));
  }, []);

  const stepTitles: Record<Step, string> = {
    1: 'SELECT BOOKMAKER',
    2: 'CONFIGURE ENDPOINT',
    3: 'MAP JSON PATHS',
    4: 'DISCOVER ENTITIES',
    5: 'MAP MARKETS',
  };

  const stepsCompleted: Record<Step, boolean> = {
    1: !!bookmaker,
    2: !!rawJson,
    3: !!testResult?.ok,
    4: step > 4,
    5: false,
  };

  const handleSelectBookmaker = (b: Bookmaker, primary: boolean) => {
    setBookmaker(b);
    setIsPrimary(primary);
    setMap(p => ({ ...p, bookmaker_id: b.id, is_primary_bookmaker: primary }));
    setStep(2);
  };

  const handleFetch = async () => {
    if (!map.curl_template) return;
    setFetching(true);
    setFetchError('');
    // First save the endpoint map so we get an ID
    const r = await api.post('/endpoint-maps/', {
      ...map,
      bookmaker_id: bookmaker!.id,
      endpoint_type: map.endpoint_type || 'COMBINED',
    });
    if (r.id) {
      setSavedMapId(r.id);
      setMap(p => ({ ...p, ...r }));
      // Now fetch the sample
      const fr = await api.post('/fetch-sample', { endpoint_map_id: r.id });
      setFetching(false);
      if (!fr.ok) {
        setFetchError(fr.error || 'Fetch failed');
      } else {
        try { setRawJson(JSON.parse(r.sample_response || '{}')); } catch { setRawJson(fr.rows_preview); }
        // Store the raw JSON from the API response
        const mapFull = await api.get(`/endpoint-maps/${r.id}`);
        if (mapFull.sample_response) {
          try { setRawJson(JSON.parse(mapFull.sample_response)); } catch { /* */ }
        }
        setToast(`✓ Fetched — ${fr.rows_count || 0} rows discovered`);
      }
    } else {
      setFetching(false);
      setFetchError(r.error || 'Failed to save endpoint map');
    }
  };

  const handleTest = async () => {
    if (!savedMapId) return;
    setTesting(true);
    // Save current paths first
    await api.put(`/endpoint-maps/${savedMapId}`, map);
    const r = await api.post('/test-paths', {
      endpoint_map_id: savedMapId,
      paths: {
        match_list_array_path: map.match_list_array_path,
        match_id_path:         map.match_id_path,
        home_team_path:        map.home_team_path,
        away_team_path:        map.away_team_path,
        start_time_path:       map.start_time_path,
        sport_path:            map.sport_path,
        competition_path:      map.competition_path,
        markets_array_path:    map.markets_array_path,
        market_name_path:      map.market_name_path,
        specifier_path:        map.specifier_path,
        selections_array_path: map.selections_array_path,
        selection_name_path:   map.selection_name_path,
        selection_price_path:  map.selection_price_path,
      },
    });
    setTesting(false);
    setTestResult(r);
  };

  const handleSavePaths = async () => {
    if (!savedMapId) return;
    setSaving(true);
    await api.put(`/endpoint-maps/${savedMapId}`, {
      ...map,
      is_primary_bookmaker: isPrimary,
    });
    setSaving(false);
    setToast('✓ Paths saved');
    setStep(4);
  };

  return (
    <div style={s.page}>
      <Toast msg={toast} onClear={() => setToast('')} />

      <div style={s.header}>
        <div>
          <h1 style={s.title}>BOOKMAKER ONBOARDING</h1>
          <p style={s.subtitle}>Configure a new bookmaker endpoint with JSON path mapping</p>
        </div>
        {bookmaker && (
          <div style={s.bkBadge}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700 }}>{bookmaker.name}</div>
            {isPrimary && <span style={s.primaryBadge}>★ PRIMARY</span>}
          </div>
        )}
      </div>

      {/* Step bar */}
      <div style={s.stepBar}>
        {([1, 2, 3, 4, 5] as Step[]).map((n, i) => (
          <>
            <div key={n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <StepDot n={n} current={step} done={stepsCompleted[n]} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5,
                color: n === step ? '#c6f135' : 'var(--text-muted)' }}>
                {stepTitles[n]}
              </span>
            </div>
            {i < 4 && <div style={s.stepLine} />}
          </>
        ))}
      </div>

      {/* Step panel */}
      <div style={s.panel}>
        <div style={s.panelHead}>
          <span style={s.panelTitle}>STEP {step} — {stepTitles[step]}</span>
          {step > 1 && step < 4 && (
            <button onClick={() => setStep((step - 1) as Step)} style={s.backBtn}>← BACK</button>
          )}
        </div>

        <div style={s.panelBody}>
          {step === 1 && (
            <Step1 bookmakers={meta.bookmakers} onSelect={handleSelectBookmaker} />
          )}
          {step === 2 && bookmaker && (
            <Step2
              bookmaker={bookmaker} map={map}
              onMapChange={patch => setMap(p => ({ ...p, ...patch }))}
              onFetch={handleFetch} fetching={fetching}
              rawJson={rawJson} fetchError={fetchError}
            />
          )}
          {step === 3 && (
            <Step3
              map={map}
              onMapChange={patch => setMap(p => ({ ...p, ...patch }))}
              rawJson={rawJson}
              onTest={handleTest} testing={testing} testResult={testResult}
            />
          )}
          {step === 4 && savedMapId && bookmaker && (
            <Step4
              endpointMapId={savedMapId}
              bookmaker={bookmaker}
              onDone={() => setStep(5)}
            />
          )}
          {step === 5 && savedMapId && bookmaker && (
            <Step5
              endpointMapId={savedMapId}
              bookmaker={bookmaker}
              markets={allMarkets}
              onDone={() => setToast('✓ Onboarding complete!')}
            />
          )}
        </div>

        {/* Step 2 footer */}
        {step === 2 && rawJson && (
          <div style={s.panelFooter}>
            <button onClick={() => setStep(3)} style={s.btnPrimary}>
              NEXT: MAP PATHS →
            </button>
          </div>
        )}

        {/* Step 3 footer */}
        {step === 3 && (
          <div style={s.panelFooter}>
            <button onClick={handleSavePaths} disabled={saving} style={{
              ...s.btnPrimary, opacity: saving ? 0.5 : 1,
            }}>
              {saving ? 'SAVING…' : 'SAVE & CONTINUE →'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:      { maxWidth: 1100, padding: '0 0 80px' },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  title:     { fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, letterSpacing: 3, margin: 0 },
  subtitle:  { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2, marginTop: 4 },

  stepBar: {
    display: 'flex', alignItems: 'center', gap: 0,
    background: 'var(--bg-surface)', border: '1px solid var(--border-dim)',
    padding: '16px 32px', marginBottom: 0,
  },
  stepLine: { flex: 1, height: 1, background: 'var(--border-dim)', margin: '0 4px', marginBottom: 20 },

  panel:     { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', borderTop: 'none' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 24px', borderBottom: '1px solid var(--border-dim)',
    background: 'rgba(255,255,255,.02)' },
  panelTitle:{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, fontWeight: 700, color: '#c6f135' },
  panelBody: { padding: '24px' },
  panelFooter:{ padding: '16px 24px', borderTop: '1px solid var(--border-dim)',
    display: 'flex', justifyContent: 'flex-end', gap: 10 },

  stepHint:  { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)',
    lineHeight: 1.7, marginBottom: 20, padding: '10px 14px',
    background: 'rgba(198,241,53,.03)', border: '1px solid rgba(198,241,53,.1)' },

  bkBadge:   { background: 'var(--bg-base)', border: '1px solid var(--border-base)',
    padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' },
  primaryBadge:{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2,
    color: '#c6f135', background: 'rgba(198,241,53,.1)', border: '1px solid rgba(198,241,53,.3)',
    padding: '2px 8px' },

  pathGrid:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  row2:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  sectionHead:{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, fontWeight: 700,
    color: '#c6f135', borderBottom: '1px solid var(--border-dim)',
    paddingBottom: 6, marginBottom: 12, marginTop: 4,
    display: 'flex', alignItems: 'center' },

  label:    { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 5 },
  hint:     { fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 },
  input:    { background: 'var(--bg-base)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 11px', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' },
  textarea: { width: '100%', boxSizing: 'border-box' as const, background: 'var(--bg-base)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 11px', fontFamily: '"Fira Code", monospace', fontSize: 11, outline: 'none', resize: 'vertical' as const, lineHeight: 1.6 },
  select:   { background: 'var(--bg-base)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 11px', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer', width: '100%' },
  code:     { fontFamily: '"Fira Code", monospace', fontSize: 11, background: 'rgba(6,182,212,.1)', padding: '1px 5px', color: '#06b6d4' },

  jsonBox: { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '12px 16px', maxHeight: 300, overflowY: 'auto', fontFamily: '"Fira Code", monospace', fontSize: 11, lineHeight: 1.7 },
  treeToggle: { cursor: 'pointer', color: '#c6f135', fontFamily: '"Fira Code", monospace', fontSize: 11 },

  bkRow:    { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', padding: '12px 16px', cursor: 'pointer', transition: 'border-color .15s', outline: 'none', width: '100%' },
  empty:    { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', padding: '20px', textAlign: 'center' as const },
  checkRow: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', padding: '4px 0' },
  loadState:{ padding: '40px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' },
  errorBox: { background: 'rgba(255,61,90,.06)', border: '1px solid rgba(255,61,90,.3)', color: '#ff3d5a', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 12 },
  successBox:{ background: 'rgba(198,241,53,.06)', border: '1px solid rgba(198,241,53,.3)', color: '#c6f135', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 12 },
  createBox:{ background: 'rgba(198,241,53,.03)', border: '1px solid rgba(198,241,53,.1)', padding: '14px', marginTop: 16 },

  btnPrimary: { background: '#c6f135', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: '10px 22px', cursor: 'pointer' },
  btnSecondary:{ background: 'transparent', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1, padding: '9px 18px', cursor: 'pointer' },
  btnGhost:   { background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10, padding: '9px 16px', cursor: 'pointer' },
  backBtn:    { background: 'transparent', border: 'none', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, cursor: 'pointer', letterSpacing: 1 },

  toast: { position: 'fixed' as const, top: 20, right: 24, zIndex: 9999, background: 'var(--bg-surface)', border: '1px solid', padding: '10px 20px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 4px 20px rgba(0,0,0,.4)' },
};