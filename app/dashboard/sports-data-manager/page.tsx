'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Country     { id: number; name: string; iso_code: string }
interface Sport       { id: number; name: string; is_active: boolean }
interface Competition { id: number; name: string; sport_id: number; sport_name: string; country_id: number | null; country_name: string; gender: string }
interface Team        { id: number; name: string; sport_id: number; sport_name: string; gender: string }
interface BookmakerVal{ id: number; bookmaker_id: number; bookmaker_name: string; entity_type: string; internal_id: number; external_id: string; label: string }
interface Bookmaker   { id: number; name: string; domain: string }

interface PagedResult<T> { items: T[]; total: number; page: number; pages: number }

type ActiveTab = 'sports' | 'countries' | 'competitions' | 'teams' | 'bookmaker-values';
type Gender = 'M' | 'F' | 'Mixed';

const GENDERS: Gender[] = ['M', 'F', 'Mixed'];
const ENTITY_TYPES = ['sport', 'competition', 'country', 'team'] as const;

// ─── API helpers ──────────────────────────────────────────────────────────────
const BASE = '/admin/sports-data';
const api = {
  get:    (path: string) => fetchWithAuth(`${BASE}${path}`).then(r => r.json()),
  post:   (path: string, body: unknown) => fetchWithAuth(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  put:    (path: string, body: unknown) => fetchWithAuth(`${BASE}${path}`, { method: 'PUT',  body: JSON.stringify(body) }).then(r => r.json()),
  delete: (path: string) => fetchWithAuth(`${BASE}${path}`, { method: 'DELETE' }).then(r => r.json()),
};

// ─── Shared UI atoms ──────────────────────────────────────────────────────────
function Badge({ label, color = '#c6f135' }: { label: string; color?: string }) {
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, fontWeight: 700,
      padding: '2px 8px', color,
      background: color + '18',
      border: `1px solid ${color}30`,
    }}>{label}</span>
  );
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 13 }}>⌕</span>
      <input
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder || 'Search…'}
        style={{ ...s.input, paddingLeft: 32, width: '100%', boxSizing: 'border-box' }}
      />
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalBox} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={s.modalTitle}>{title}</span>
          <button onClick={onClose} style={s.iconBtn}>✕</button>
        </div>
        <div style={s.modalBody}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={s.fieldLabel}>{label}</label>
      {children}
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
}

function Pagination({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div style={s.pager}>
      <span style={s.pagerInfo}>{total} total</span>
      <div style={s.pagerBtns}>
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} style={s.pagerBtn}>‹</button>
        {Array.from({ length: Math.min(pages, 7) }, (_, i) => {
          const p = pages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
          if (p < 1 || p > pages) return null;
          return (
            <button key={p} onClick={() => onPage(p)}
              style={{ ...s.pagerBtn, ...(p === page ? s.pagerBtnActive : {}) }}>{p}</button>
          );
        })}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} style={s.pagerBtn}>›</button>
      </div>
    </div>
  );
}

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onClear, 3000); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  const isErr = msg.startsWith('✗');
  return (
    <div style={{ ...s.toast, borderColor: isErr ? 'rgba(255,61,90,0.4)' : 'rgba(198,241,53,0.4)', color: isErr ? '#ff3d5a' : '#c6f135' }}>
      {msg}
    </div>
  );
}

// ─── COUNTRIES tab ────────────────────────────────────────────────────────────
function CountriesTab({ onToast }: { onToast: (m: string) => void }) {
  const [data, setData]     = useState<PagedResult<Country> | null>(null);
  const [q, setQ]           = useState('');
  const [page, setPage]     = useState(1);
  const [editing, setEdit]  = useState<Partial<Country> | null>(null);
  const [loading, setLoad]  = useState(false);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '20' });
    if (q) qs.set('q', q);
    setData(await api.get(`/countries/?${qs}`));
    setLoad(false);
  }, [q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const save = async () => {
    if (!editing?.name) return;
    try {
      if (editing.id) await api.put(`/countries/${editing.id}`, editing);
      else await api.post('/countries/', editing);
      onToast(`✓ Country saved`);
      setEdit(null); load();
    } catch { onToast('✗ Save failed'); }
  };

  const del = async (c: Country) => {
    if (!confirm(`Delete "${c.name}"?`)) return;
    await api.delete(`/countries/${c.id}`);
    onToast(`Deleted: ${c.name}`); load();
  };

  return (
    <div>
      <div style={s.toolbar}>
        <SearchBar value={q} onChange={setQ} placeholder="Search countries…" />
        <button onClick={() => setEdit({ name: '', iso_code: '' })} style={s.addBtn}>+ Add Country</button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Name</th>
          <th style={s.th}>ISO</th>
          <th style={{ ...s.th, width: 100 }}>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={3} style={s.loadRow}>Loading…</td></tr>
          ) : data?.items.map(c => (
            <tr key={c.id} style={s.tr}>
              <td style={s.td}>{c.name}</td>
              <td style={s.td}><Badge label={c.iso_code || '—'} color="#94a3b8" /></td>
              <td style={s.tdActions}>
                <button onClick={() => setEdit(c)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(c)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={editing.id ? 'Edit Country' : 'New Country'} onClose={() => setEdit(null)}>
          <Field label="NAME *">
            <input value={editing.name || ''} onChange={e => setEdit({ ...editing, name: e.target.value })} style={s.inputFull} autoFocus />
          </Field>
          <Field label="ISO CODE" hint="2–3 letter ISO code e.g. KE, GBR">
            <input value={editing.iso_code || ''} onChange={e => setEdit({ ...editing, iso_code: e.target.value.toUpperCase().slice(0, 3) })}
              style={{ ...s.input, width: 80 }} maxLength={3} />
          </Field>
          <div style={s.modalFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── SPORTS tab ───────────────────────────────────────────────────────────────
function SportsTab({ onToast, onReload }: { onToast: (m: string) => void; onReload?: () => void }) {
  const [data, setData]    = useState<PagedResult<Sport> | null>(null);
  const [q, setQ]          = useState('');
  const [page, setPage]    = useState(1);
  const [editing, setEdit] = useState<Partial<Sport> | null>(null);
  const [loading, setLoad] = useState(false);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '20' });
    if (q) qs.set('q', q);
    setData(await api.get(`/sports/?${qs}`));
    setLoad(false);
  }, [q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const save = async () => {
    if (!editing?.name) return;
    try {
      if (editing.id) await api.put(`/sports/${editing.id}`, editing);
      else await api.post('/sports/', editing);
      onToast('✓ Sport saved'); setEdit(null); load(); onReload?.();
    } catch { onToast('✗ Save failed'); }
  };

  const toggle = async (sport: Sport) => {
    await api.put(`/sports/${sport.id}`, { is_active: !sport.is_active });
    onToast(`${!sport.is_active ? 'Activated' : 'Deactivated'}: ${sport.name}`);
    load();
  };

  const del = async (s: Sport) => {
    if (!confirm(`Delete "${s.name}"? This will affect all competitions and teams.`)) return;
    await api.delete(`/sports/${s.id}`);
    onToast(`Deleted: ${s.name}`); load();
  };

  return (
    <div>
      <div style={s.toolbar}>
        <SearchBar value={q} onChange={setQ} placeholder="Search sports…" />
        <button onClick={() => setEdit({ name: '', is_active: true })} style={s.addBtn}>+ Add Sport</button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Sport</th>
          <th style={s.th}>Status</th>
          <th style={{ ...s.th, width: 120 }}>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={3} style={s.loadRow}>Loading…</td></tr>
          ) : data?.items.map(sport => (
            <tr key={sport.id} style={s.tr}>
              <td style={s.td}><span style={s.entityName}>{sport.name}</span></td>
              <td style={s.td}>
                <Badge label={sport.is_active ? 'ACTIVE' : 'INACTIVE'}
                  color={sport.is_active ? '#c6f135' : '#475569'} />
              </td>
              <td style={s.tdActions}>
                <button onClick={() => toggle(sport)} style={s.editBtn}>
                  {sport.is_active ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => setEdit(sport)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(sport)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={editing.id ? 'Edit Sport' : 'New Sport'} onClose={() => setEdit(null)}>
          <Field label="NAME *">
            <input value={editing.name || ''} onChange={e => setEdit({ ...editing, name: e.target.value })} style={s.inputFull} autoFocus />
          </Field>
          <Field label="STATUS">
            <label style={s.checkRow}>
              <input type="checkbox" checked={!!editing.is_active}
                onChange={e => setEdit({ ...editing, is_active: e.target.checked })} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Active</span>
            </label>
          </Field>
          <div style={s.modalFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── COMPETITIONS tab ─────────────────────────────────────────────────────────
function CompetitionsTab({ sports, countries, onToast }: {
  sports: Sport[]; countries: Country[]; onToast: (m: string) => void;
}) {
  const [data, setData]       = useState<PagedResult<Competition> | null>(null);
  const [q, setQ]             = useState('');
  const [filterSport, setFS]  = useState<number | ''>('');
  const [filterCountry, setFC]= useState<number | ''>('');
  const [page, setPage]       = useState(1);
  const [editing, setEdit]    = useState<Partial<Competition> | null>(null);
  const [loading, setLoad]    = useState(false);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '25' });
    if (q) qs.set('q', q);
    if (filterSport) qs.set('sport_id', String(filterSport));
    if (filterCountry) qs.set('country_id', String(filterCountry));
    setData(await api.get(`/competitions/?${qs}`));
    setLoad(false);
  }, [q, page, filterSport, filterCountry]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q, filterSport, filterCountry]);

  const save = async () => {
    if (!editing?.name || !editing?.sport_id) return;
    try {
      if (editing.id) await api.put(`/competitions/${editing.id}`, editing);
      else await api.post('/competitions/', editing);
      onToast('✓ Competition saved'); setEdit(null); load();
    } catch { onToast('✗ Save failed'); }
  };

  const del = async (c: Competition) => {
    if (!confirm(`Delete "${c.name}"?`)) return;
    await api.delete(`/competitions/${c.id}`);
    onToast(`Deleted: ${c.name}`); load();
  };

  return (
    <div>
      <div style={s.toolbar}>
        <SearchBar value={q} onChange={setQ} placeholder="Search competitions…" />
        <select value={filterSport} onChange={e => setFS(e.target.value ? Number(e.target.value) : '')} style={s.filterSel}>
          <option value="">All Sports</option>
          {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
        </select>
        <select value={filterCountry} onChange={e => setFC(e.target.value ? Number(e.target.value) : '')} style={s.filterSel}>
          <option value="">All Countries</option>
          {countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={() => setEdit({ name: '', sport_id: sports[0]?.id, gender: 'M' })} style={s.addBtn}>
          + Add Competition
        </button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Competition</th>
          <th style={s.th}>Sport</th>
          <th style={s.th}>Country</th>
          <th style={s.th}>Gender</th>
          <th style={{ ...s.th, width: 100 }}>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} style={s.loadRow}>Loading…</td></tr>
          ) : data?.items.map(c => (
            <tr key={c.id} style={s.tr}>
              <td style={s.td}><span style={s.entityName}>{c.name}</span></td>
              <td style={s.td}><Badge label={c.sport_name} color="#06b6d4" /></td>
              <td style={s.td}><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.country_name || '—'}</span></td>
              <td style={s.td}><Badge label={c.gender} color="#8b5cf6" /></td>
              <td style={s.tdActions}>
                <button onClick={() => setEdit(c)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(c)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={editing.id ? 'Edit Competition' : 'New Competition'} onClose={() => setEdit(null)}>
          <Field label="NAME *">
            <input value={editing.name || ''} onChange={e => setEdit({ ...editing, name: e.target.value })} style={s.inputFull} autoFocus />
          </Field>
          <div style={s.row2}>
            <Field label="SPORT *">
              <select value={editing.sport_id || ''} onChange={e => setEdit({ ...editing, sport_id: Number(e.target.value) })} style={s.select}>
                <option value="">— select —</option>
                {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </Field>
            <Field label="GENDER">
              <select value={editing.gender || 'M'} onChange={e => setEdit({ ...editing, gender: e.target.value })} style={s.select}>
                {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
          <Field label="COUNTRY">
            <select value={editing.country_id || ''} onChange={e => setEdit({ ...editing, country_id: e.target.value ? Number(e.target.value) : null })} style={s.select}>
              <option value="">— none —</option>
              {countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <div style={s.modalFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── TEAMS tab ────────────────────────────────────────────────────────────────
function TeamsTab({ sports, onToast }: { sports: Sport[]; onToast: (m: string) => void }) {
  const [data, setData]      = useState<PagedResult<Team> | null>(null);
  const [q, setQ]            = useState('');
  const [filterSport, setFS] = useState<number | ''>('');
  const [page, setPage]      = useState(1);
  const [editing, setEdit]   = useState<Partial<Team> | null>(null);
  const [loading, setLoad]   = useState(false);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '25' });
    if (q) qs.set('q', q);
    if (filterSport) qs.set('sport_id', String(filterSport));
    setData(await api.get(`/teams/?${qs}`));
    setLoad(false);
  }, [q, page, filterSport]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q, filterSport]);

  const save = async () => {
    if (!editing?.name || !editing?.sport_id) return;
    try {
      if (editing.id) await api.put(`/teams/${editing.id}`, editing);
      else await api.post('/teams/', editing);
      onToast('✓ Team saved'); setEdit(null); load();
    } catch { onToast('✗ Save failed'); }
  };

  const del = async (t: Team) => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    await api.delete(`/teams/${t.id}`);
    onToast(`Deleted: ${t.name}`); load();
  };

  return (
    <div>
      <div style={s.toolbar}>
        <SearchBar value={q} onChange={setQ} placeholder="Search teams…" />
        <select value={filterSport} onChange={e => setFS(e.target.value ? Number(e.target.value) : '')} style={s.filterSel}>
          <option value="">All Sports</option>
          {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
        </select>
        <button onClick={() => setEdit({ name: '', sport_id: sports[0]?.id, gender: 'M' })} style={s.addBtn}>
          + Add Team
        </button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Team</th>
          <th style={s.th}>Sport</th>
          <th style={s.th}>Gender</th>
          <th style={{ ...s.th, width: 100 }}>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={4} style={s.loadRow}>Loading…</td></tr>
          ) : data?.items.map(t => (
            <tr key={t.id} style={s.tr}>
              <td style={s.td}><span style={s.entityName}>{t.name}</span></td>
              <td style={s.td}><Badge label={t.sport_name} color="#06b6d4" /></td>
              <td style={s.td}><Badge label={t.gender} color="#8b5cf6" /></td>
              <td style={s.tdActions}>
                <button onClick={() => setEdit(t)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(t)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={editing.id ? 'Edit Team' : 'New Team'} onClose={() => setEdit(null)}>
          <Field label="NAME *">
            <input value={editing.name || ''} onChange={e => setEdit({ ...editing, name: e.target.value })} style={s.inputFull} autoFocus />
          </Field>
          <div style={s.row2}>
            <Field label="SPORT *">
              <select value={editing.sport_id || ''} onChange={e => setEdit({ ...editing, sport_id: Number(e.target.value) })} style={s.select}>
                <option value="">— select —</option>
                {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </Field>
            <Field label="GENDER">
              <select value={editing.gender || 'M'} onChange={e => setEdit({ ...editing, gender: e.target.value })} style={s.select}>
                {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
          <div style={s.modalFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── BOOKMAKER VALUES tab ─────────────────────────────────────────────────────
function BookmakerValuesTab({ sports, countries, bookmakers, onToast }: {
  sports: Sport[]; countries: Country[]; bookmakers: Bookmaker[]; onToast: (m: string) => void;
}) {
  const [data, setData]       = useState<PagedResult<BookmakerVal> | null>(null);
  const [filterBk, setFBk]    = useState<number | ''>('');
  const [filterType, setFType]= useState<string>('');
  const [page, setPage]       = useState(1);
  const [editing, setEdit]    = useState<Partial<BookmakerVal> | null>(null);
  const [loading, setLoad]    = useState(false);
  // For inline entity name lookup
  const [competitions, setComps] = useState<Competition[]>([]);
  const [teams, setTeams]        = useState<Team[]>([]);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '25' });
    if (filterBk) qs.set('bookmaker_id', String(filterBk));
    if (filterType) qs.set('entity_type', filterType);
    setData(await api.get(`/bookmaker-values/?${qs}`));
    setLoad(false);
  }, [page, filterBk, filterType]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [filterBk, filterType]);

  const loadCompetitions = async (sportId?: number) => {
    const url = sportId ? `/competitions/by-sport/${sportId}` : `/competitions/?per_page=200`;
    const r = await api.get(url);
    setComps(Array.isArray(r) ? r : r.items || []);
  };

  const loadTeams = async (sportId?: number) => {
    const url = sportId ? `/teams/by-sport/${sportId}` : `/teams/?per_page=200`;
    const r = await api.get(url);
    setTeams(Array.isArray(r) ? r : r.items || []);
  };

  const openNew = () => {
    setEdit({ bookmaker_id: bookmakers[0]?.id, entity_type: 'sport', internal_id: undefined, external_id: '', label: '' });
    loadCompetitions(); loadTeams();
  };

  const entityLabel = (v: BookmakerVal) => {
    if (v.entity_type === 'sport')       return sports.find(s => s.id === v.internal_id)?.name || `Sport #${v.internal_id}`;
    if (v.entity_type === 'country')     return countries.find(c => c.id === v.internal_id)?.name || `Country #${v.internal_id}`;
    if (v.entity_type === 'competition') return `Competition #${v.internal_id}`;
    if (v.entity_type === 'team')        return `Team #${v.internal_id}`;
    return String(v.internal_id);
  };

  const save = async () => {
    if (!editing?.bookmaker_id || !editing?.entity_type || editing?.internal_id == null || !editing?.external_id) return;
    try {
      if (editing.id) await api.put(`/bookmaker-values/${editing.id}`, editing);
      else await api.post('/bookmaker-values/', editing);
      onToast('✓ Mapping saved'); setEdit(null); load();
    } catch { onToast('✗ Save failed'); }
  };

  const del = async (v: BookmakerVal) => {
    if (!confirm('Delete this mapping?')) return;
    await api.delete(`/bookmaker-values/${v.id}`);
    onToast('Deleted mapping'); load();
  };

  // Entity type colour
  const typeColor: Record<string, string> = {
    sport: '#c6f135', country: '#f59e0b', competition: '#06b6d4', team: '#8b5cf6'
  };

  // Internal ID selector based on entity_type
  const InternalSelect = () => {
    const etype = editing?.entity_type || 'sport';
    if (etype === 'sport') return (
      <select value={editing?.internal_id || ''} onChange={e => setEdit({ ...editing, internal_id: Number(e.target.value) })} style={s.select}>
        <option value="">— select sport —</option>
        {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
      </select>
    );
    if (etype === 'country') return (
      <select value={editing?.internal_id || ''} onChange={e => setEdit({ ...editing, internal_id: Number(e.target.value) })} style={s.select}>
        <option value="">— select country —</option>
        {countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    );
    if (etype === 'competition') return (
      <select value={editing?.internal_id || ''} onChange={e => setEdit({ ...editing, internal_id: Number(e.target.value) })} style={s.select}>
        <option value="">— select competition —</option>
        {competitions.map(c => <option key={c.id} value={c.id}>{c.name} ({c.sport_name})</option>)}
      </select>
    );
    if (etype === 'team') return (
      <select value={editing?.internal_id || ''} onChange={e => setEdit({ ...editing, internal_id: Number(e.target.value) })} style={s.select}>
        <option value="">— select team —</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.sport_name})</option>)}
      </select>
    );
    return null;
  };

  return (
    <div>
      <div style={s.infoBox}>
        <span style={s.infoIcon}>ℹ</span>
        <span style={s.infoText}>
          Map your internal entity IDs to each bookmaker's own external IDs.
          These are substituted automatically at harvest time when building endpoint URLs.
        </span>
      </div>

      <div style={s.toolbar}>
        <select value={filterBk} onChange={e => setFBk(e.target.value ? Number(e.target.value) : '')} style={s.filterSel}>
          <option value="">All Bookmakers</option>
          {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={filterType} onChange={e => setFType(e.target.value)} style={s.filterSel}>
          <option value="">All Entity Types</option>
          {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={openNew} style={s.addBtn}>+ Add Mapping</button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Bookmaker</th>
          <th style={s.th}>Type</th>
          <th style={s.th}>Internal Entity</th>
          <th style={s.th}>External ID</th>
          <th style={s.th}>Label</th>
          <th style={{ ...s.th, width: 100 }}>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={6} style={s.loadRow}>Loading…</td></tr>
          ) : data?.items.map(v => (
            <tr key={v.id} style={s.tr}>
              <td style={s.td}><span style={s.entityName}>{v.bookmaker_name}</span></td>
              <td style={s.td}><Badge label={v.entity_type.toUpperCase()} color={typeColor[v.entity_type] || '#94a3b8'} /></td>
              <td style={s.td}><span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{entityLabel(v)}</span></td>
              <td style={s.td}><code style={s.code}>{v.external_id}</code></td>
              <td style={s.td}><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{v.label || '—'}</span></td>
              <td style={s.tdActions}>
                <button onClick={() => { setEdit(v); loadCompetitions(); loadTeams(); }} style={s.editBtn}>Edit</button>
                <button onClick={() => del(v)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={editing.id ? 'Edit Mapping' : 'New Bookmaker Mapping'} onClose={() => setEdit(null)}>
          <div style={s.row2}>
            <Field label="BOOKMAKER *">
              <select value={editing.bookmaker_id || ''} onChange={e => setEdit({ ...editing, bookmaker_id: Number(e.target.value) })} style={s.select}>
                {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="ENTITY TYPE *">
              <select value={editing.entity_type || 'sport'}
                onChange={e => setEdit({ ...editing, entity_type: e.target.value, internal_id: undefined })}
                style={s.select}>
                {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="INTERNAL ENTITY *" hint="The entity in YOUR database">
            <InternalSelect />
          </Field>
          <Field label="EXTERNAL ID *" hint="The ID this bookmaker uses in their API">
            <input value={editing.external_id || ''} onChange={e => setEdit({ ...editing, external_id: e.target.value })}
              placeholder="e.g. sr:sport:1 or 4 or soccer" style={s.inputFull} />
          </Field>
          <Field label="LABEL (optional)" hint="Human-readable note">
            <input value={editing.label || ''} onChange={e => setEdit({ ...editing, label: e.target.value })}
              placeholder="e.g. Football (Soccer)" style={s.inputFull} />
          </Field>
          <div style={s.modalFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save Mapping</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function SportsDataManager() {
  const [tab, setTab]             = useState<ActiveTab>('sports');
  const [toast, setToast]         = useState('');
  const [meta, setMeta]           = useState<{ sports: Sport[]; countries: Country[]; bookmakers: Bookmaker[] }>({
    sports: [], countries: [], bookmakers: [],
  });
  const [metaLoaded, setMetaLoaded] = useState(false);

  const loadMeta = useCallback(async () => {
    const m = await api.get('/meta/');
    setMeta(m);
    setMetaLoaded(true);
  }, []);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  const TAB_CONFIG: { key: ActiveTab; label: string; count?: number }[] = [
    { key: 'sports',           label: 'Sports',     count: meta.sports.length },
    { key: 'countries',        label: 'Countries' },
    { key: 'competitions',     label: 'Competitions' },
    { key: 'teams',            label: 'Teams' },
    { key: 'bookmaker-values', label: 'Bookmaker ID Mappings' },
  ];

  return (
    <div style={s.page}>
      <Toast msg={toast} onClear={() => setToast('')} />

      <div style={s.header}>
        <div>
          <h1 style={s.title}>SPORTS DATA</h1>
          <p style={s.subtitle}>Reference entities — Sports, Countries, Competitions, Teams, Bookmaker ID Mappings</p>
        </div>
      </div>

      <div style={s.tabBar}>
        {TAB_CONFIG.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ ...s.tab, ...(tab === t.key ? s.tabActive : {}) }}>
            {t.label}
            {t.count != null && <span style={s.tabBadge}>{t.count}</span>}
          </button>
        ))}
      </div>

      <div style={s.panel}>
        {!metaLoaded ? (
          <div style={s.loadRow}>Loading reference data…</div>
        ) : (
          <>
            {tab === 'sports'           && <SportsTab sports={meta.sports} onToast={setToast} onReload={loadMeta} />}
            {tab === 'countries'        && <CountriesTab onToast={setToast} />}
            {tab === 'competitions'     && <CompetitionsTab sports={meta.sports} countries={meta.countries} onToast={setToast} />}
            {tab === 'teams'            && <TeamsTab sports={meta.sports} onToast={setToast} />}
            {tab === 'bookmaker-values' && <BookmakerValuesTab sports={meta.sports} countries={meta.countries} bookmakers={meta.bookmakers} onToast={setToast} />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1100, padding: '0 0 80px' },
  header:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  title:   { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: 3, margin: 0 },
  subtitle:{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2, marginTop: 4 },

  tabBar: { display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: 0 },
  tab: {
    padding: '13px 20px', background: 'transparent', border: 'none',
    borderBottom: '2px solid transparent', color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, cursor: 'pointer',
    display: 'flex', gap: 8, alignItems: 'center', transition: 'color 0.15s',
  },
  tabActive: { color: 'var(--text-primary)', borderBottomColor: '#c6f135' },
  tabBadge: {
    background: 'rgba(198,241,53,0.15)', color: '#c6f135',
    padding: '1px 7px', borderRadius: 10, fontSize: 9, fontWeight: 700,
  },

  panel:   { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', borderTop: 'none', padding: '20px 24px' },

  toolbar: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  filterSel: {
    background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
    color: 'var(--text-secondary)', padding: '7px 12px',
    fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
  },
  addBtn: {
    padding: '8px 18px', background: '#c6f135', color: '#0a0a0a',
    border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10,
    fontWeight: 700, letterSpacing: 1.5, cursor: 'pointer', flexShrink: 0,
  },

  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 12 },
  th: {
    padding: '8px 12px', background: 'rgba(255,255,255,0.03)',
    borderBottom: '1px solid var(--border-dim)',
    fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2,
    color: 'var(--text-muted)', textAlign: 'left', fontWeight: 700,
  },
  tr: { borderBottom: '1px solid var(--border-dim)', transition: 'background 0.1s' },
  td: { padding: '9px 12px', verticalAlign: 'middle' },
  tdActions: { padding: '9px 12px', display: 'flex', gap: 6, alignItems: 'center' },
  loadRow: { padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 },

  entityName: { fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 },
  code: {
    fontFamily: '"Fira Code", monospace', fontSize: 11, color: '#06b6d4',
    background: 'rgba(6,182,212,0.08)', padding: '2px 7px',
    border: '1px solid rgba(6,182,212,0.15)',
  },

  editBtn: {
    background: 'transparent', border: '1px solid var(--border-dim)',
    color: 'var(--text-secondary)', padding: '4px 10px', cursor: 'pointer',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 0.5,
  },
  delBtn: {
    background: 'transparent', border: '1px solid rgba(255,61,90,0.25)',
    color: '#ff3d5a', padding: '4px 10px', cursor: 'pointer',
    fontFamily: 'var(--font-mono)', fontSize: 10,
  },

  // Pagination
  pager:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 },
  pagerInfo:   { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },
  pagerBtns:   { display: 'flex', gap: 4 },
  pagerBtn: {
    background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
    color: 'var(--text-secondary)', padding: '4px 10px', cursor: 'pointer',
    fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 32,
  },
  pagerBtnActive: { background: 'rgba(198,241,53,0.1)', borderColor: 'rgba(198,241,53,0.4)', color: '#c6f135' },

  // Modal
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modalBox: {
    background: 'var(--bg-surface)', border: '1px solid var(--border-base)',
    width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 20px', borderBottom: '1px solid var(--border-dim)',
  },
  modalTitle:  { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2, fontWeight: 700 },
  modalBody:   { padding: '20px' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },

  fieldLabel: { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6 },
  input: {
    background: 'var(--bg-base)', border: '1px solid var(--border-base)',
    color: 'var(--text-primary)', padding: '9px 12px',
    fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
  },
  inputFull: {
    width: '100%', boxSizing: 'border-box',
    background: 'var(--bg-base)', border: '1px solid var(--border-base)',
    color: 'var(--text-primary)', padding: '9px 12px',
    fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
  },
  select: {
    width: '100%', background: 'var(--bg-base)',
    border: '1px solid var(--border-base)',
    color: 'var(--text-primary)', padding: '9px 12px',
    fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
  },
  hint: { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginTop: 5 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  checkRow: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' },
  iconBtn: {
    background: 'transparent', border: 'none',
    color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, padding: '2px 6px',
  },

  saveBtn: {
    padding: '9px 24px', background: '#c6f135', color: '#0a0a0a',
    border: 'none', fontFamily: 'var(--font-mono)', fontSize: 11,
    fontWeight: 700, letterSpacing: 1, cursor: 'pointer',
  },
  cancelBtn: {
    padding: '9px 18px', background: 'transparent',
    border: '1px solid var(--border-dim)', color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
  },

  // Info box
  infoBox: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.2)',
    padding: '10px 14px', marginBottom: 16,
  },
  infoIcon: { color: '#06b6d4', fontSize: 14, flexShrink: 0, marginTop: 1 },
  infoText: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 },

  // Toast
  toast: {
    position: 'fixed', top: 20, right: 24, zIndex: 9999,
    background: 'var(--bg-surface)', border: '1px solid',
    padding: '10px 20px', fontFamily: 'var(--font-mono)', fontSize: 11,
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  },
};