'use client';
import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Market       { id: number; name: string; slug: string; description: string | null; is_active: boolean; sport_id: number | null; sport_name: string | null }
interface MarketAlias  { id: number; market_id: number; market_name: string | null; bookmaker_id: number; bookmaker_name: string | null; alias_name: string; notes: string | null }
interface EntityAlias  { id: number; team_id?: number; competition_id?: number; sport_id?: number; team_name?: string | null; competition_name?: string | null; sport_name?: string | null; bookmaker_id: number; bookmaker_name: string | null; alias_name: string }
interface EndpointMap  { id: number; bookmaker_id: number; bookmaker_name: string | null; endpoint_type: string; url: string | null; method: string; is_primary_bookmaker: boolean; is_active: boolean; updated_at: string | null; match_list_array_path: string | null; match_id_path: string | null; home_team_path: string | null; away_team_path: string | null; start_time_path: string | null; sport_path: string | null; competition_path: string | null; markets_array_path: string | null; market_name_path: string | null; specifier_path: string | null; selections_array_path: string | null; selection_name_path: string | null; selection_price_path: string | null; curl_template: string | null; sample_response?: string | null }
interface Bookmaker    { id: number; name: string; domain: string }
interface Sport        { id: number; name: string }
interface Paged<T>     { items: T[]; total: number; page: number; pages: number }

type Tab = 'markets' | 'aliases' | 'endpoint-maps' | 'parser';

const BASE = '/admin/mapping';
const api = {
  get:    (p: string) => fetchWithAuth(`${BASE}${p}`).then(r => r.json()),
  post:   (p: string, b: unknown) => fetchWithAuth(`${BASE}${p}`, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json()),
  put:    (p: string, b: unknown) => fetchWithAuth(`${BASE}${p}`, { method: 'PUT',  body: JSON.stringify(b) }).then(r => r.json()),
  delete: (p: string) => fetchWithAuth(`${BASE}${p}`, { method: 'DELETE' }).then(r => r.json()),
};

// ─── Atoms ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onClear, 3000); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  const err = msg.startsWith('✗');
  return <div style={{ ...s.toast, borderColor: err ? 'rgba(255,61,90,.4)' : 'rgba(198,241,53,.4)', color: err ? '#ff3d5a' : '#c6f135' }}>{msg}</div>;
}

function Badge({ label, color = '#c6f135' }: { label: string; color?: string }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 1.5, padding: '2px 7px', color, background: color + '18', border: `1px solid ${color}30` }}>{label}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHead}>
          <span style={s.modalTitle}>{title}</span>
          <button onClick={onClose} style={s.iconBtn}>✕</button>
        </div>
        <div style={s.modalBody}>{children}</div>
      </div>
    </div>
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

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{total} total</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {page > 1 && <button onClick={() => onPage(page - 1)} style={s.pgBtn}>‹</button>}
        {Array.from({ length: Math.min(pages, 5) }, (_, i) => i + Math.max(1, page - 2))
          .filter(p => p <= pages)
          .map(p => (
            <button key={p} onClick={() => onPage(p)}
              style={{ ...s.pgBtn, ...(p === page ? s.pgBtnActive : {}) }}>{p}</button>
          ))}
        {page < pages && <button onClick={() => onPage(page + 1)} style={s.pgBtn}>›</button>}
      </div>
    </div>
  );
}

// ─── MARKETS TAB ─────────────────────────────────────────────────────────────

function MarketsTab({ sports, bookmakers, onToast }: {
  sports: Sport[]; bookmakers: Bookmaker[]; onToast: (m: string) => void;
}) {
  const [data, setData]       = useState<Paged<Market> | null>(null);
  const [q, setQ]             = useState('');
  const [page, setPage]       = useState(1);
  const [loading, setLoad]    = useState(false);
  const [editing, setEdit]    = useState<Partial<Market> | null>(null);
  const [aliasTarget, setAT]  = useState<Market | null>(null); // market to add alias to
  const [aliases, setAliases] = useState<MarketAlias[]>([]);
  const [newAlias, setNA]     = useState({ bookmaker_id: 0, alias_name: '', notes: '' });

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '25' });
    if (q) qs.set('q', q);
    setData(await api.get(`/markets/?${qs}`));
    setLoad(false);
  }, [q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const openAliases = async (m: Market) => {
    setAT(m);
    setAliases(await api.get(`/markets/${m.id}/aliases`));
  };

  const save = async () => {
    if (!editing?.name) return;
    if (editing.id) await api.put(`/markets/${editing.id}`, editing);
    else await api.post('/markets/', editing);
    onToast('✓ Market saved'); setEdit(null); load();
  };

  const del = async (m: Market) => {
    if (!confirm(`Delete "${m.name}" and all its aliases?`)) return;
    await api.delete(`/markets/${m.id}`);
    onToast(`Deleted: ${m.name}`); load();
  };

  const addAlias = async () => {
    if (!aliasTarget || !newAlias.bookmaker_id || !newAlias.alias_name.trim()) return;
    const r = await api.post(`/markets/${aliasTarget.id}/aliases`, newAlias);
    if (r.id) {
      setAliases(p => [...p, r]);
      setNA({ bookmaker_id: 0, alias_name: '', notes: '' });
      onToast('✓ Alias added');
    } else {
      onToast('✗ ' + (r.error || 'Failed'));
    }
  };

  const delAlias = async (aid: number) => {
    await api.delete(`/market-aliases/${aid}`);
    setAliases(p => p.filter(a => a.id !== aid));
    onToast('Alias removed');
  };

  return (
    <div>
      <div style={s.toolbar}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search markets…" style={{ ...s.input, width: '100%', boxSizing: 'border-box', paddingLeft: 30 }} />
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 13 }}>⌕</span>
        </div>
        <button onClick={() => setEdit({ name: '', slug: '', is_active: true })} style={s.addBtn}>+ New Market</button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>MARKET</th>
          <th style={s.th}>SLUG</th>
          <th style={s.th}>SPORT</th>
          <th style={s.th}>STATUS</th>
          <th style={{ ...s.th, width: 140 }}>ACTIONS</th>
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={5} style={s.loading}>Loading…</td></tr>
          : data?.items.map(m => (
            <tr key={m.id} style={s.tr}>
              <td style={s.td}><span style={s.name}>{m.name}</span></td>
              <td style={s.td}><code style={s.monoCell}>{m.slug}</code></td>
              <td style={s.td}>{m.sport_name ? <Badge label={m.sport_name} color="#06b6d4" /> : <span style={s.muted}>all sports</span>}</td>
              <td style={s.td}><Badge label={m.is_active ? 'ACTIVE' : 'OFF'} color={m.is_active ? '#c6f135' : '#475569'} /></td>
              <td style={s.tdAct}>
                <button onClick={() => openAliases(m)} style={s.editBtn}>Aliases</button>
                <button onClick={() => setEdit(m)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(m)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {/* Edit/create modal */}
      {editing && (
        <Modal title={editing.id ? 'Edit Market' : 'New Market'} onClose={() => setEdit(null)}>
          <Field label="DISPLAY NAME *">
            <input value={editing.name || ''} onChange={e => setEdit({ ...editing, name: e.target.value })}
              style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} autoFocus />
          </Field>
          <Field label="SLUG" hint="Machine key — auto-generated if left blank">
            <input value={editing.slug || ''} onChange={e => setEdit({ ...editing, slug: e.target.value })}
              placeholder="e.g. over_under" style={{ ...s.input, fontFamily: '"Fira Code", monospace', fontSize: 11, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <Field label="DESCRIPTION (optional)">
            <input value={editing.description || ''} onChange={e => setEdit({ ...editing, description: e.target.value })}
              style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <Field label="SPORT (optional — leave blank for all sports)">
            <select value={editing.sport_id || ''} onChange={e => setEdit({ ...editing, sport_id: e.target.value ? Number(e.target.value) : null })} style={{ ...s.input, width: '100%', boxSizing: 'border-box', cursor: 'pointer' }}>
              <option value="">All Sports</option>
              {sports.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </Field>
          <label style={s.checkRow}>
            <input type="checkbox" checked={!!editing.is_active} onChange={e => setEdit({ ...editing, is_active: e.target.checked })} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>Active</span>
          </label>
          <div style={s.mFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}

      {/* Aliases modal */}
      {aliasTarget && (
        <Modal title={`Aliases for "${aliasTarget.name}"`} onClose={() => setAT(null)}>
          <div style={{ marginBottom: 16 }}>
            <div style={s.sectionHead}>EXISTING ALIASES</div>
            {aliases.length === 0
              ? <div style={s.muted}>No aliases yet</div>
              : aliases.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-dim)' }}>
                  <span style={{ fontFamily: '"Fira Code", monospace', fontSize: 12, color: '#06b6d4', flex: 1 }}>{a.alias_name}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', flex: 1 }}>{a.bookmaker_name}</span>
                  {a.notes && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.notes}</span>}
                  <button onClick={() => delAlias(a.id)} style={{ ...s.delBtn, padding: '2px 8px' }}>✕</button>
                </div>
              ))}
          </div>
          <div style={s.sectionHead}>ADD ALIAS</div>
          <Field label="BOOKMAKER">
            <select value={newAlias.bookmaker_id || ''} onChange={e => setNA(p => ({ ...p, bookmaker_id: Number(e.target.value) }))} style={{ ...s.input, width: '100%', boxSizing: 'border-box', cursor: 'pointer' }}>
              <option value="">— select —</option>
              {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
            </select>
          </Field>
          <Field label="ALIAS NAME" hint="Exact string this bookmaker uses in their API">
            <input value={newAlias.alias_name} onChange={e => setNA(p => ({ ...p, alias_name: e.target.value }))}
              placeholder='e.g. "Match Winner" or "1x2"' style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <Field label="NOTES (optional)">
            <input value={newAlias.notes} onChange={e => setNA(p => ({ ...p, notes: e.target.value }))}
              style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <div style={s.mFooter}>
            <button onClick={() => setAT(null)} style={s.cancelBtn}>Close</button>
            <button onClick={addAlias} disabled={!newAlias.bookmaker_id || !newAlias.alias_name.trim()} style={{
              ...s.saveBtn, opacity: (!newAlias.bookmaker_id || !newAlias.alias_name.trim()) ? 0.5 : 1,
            }}>Add Alias</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── ENTITY ALIASES TAB ───────────────────────────────────────────────────────

function EntityAliasesTab({ bookmakers, onToast }: {
  bookmakers: Bookmaker[]; onToast: (m: string) => void;
}) {
  const [entityType, setET]   = useState<'team' | 'competition' | 'sport'>('team');
  const [filterBk, setFBk]    = useState<number | ''>('');
  const [q, setQ]             = useState('');
  const [page, setPage]       = useState(1);
  const [data, setData]       = useState<Paged<EntityAlias> | null>(null);
  const [loading, setLoad]    = useState(false);
  const [editing, setEdit]    = useState<Partial<{ entity_id: number; bookmaker_id: number; alias_name: string }> | null>(null);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ entity_type: entityType, page: String(page), per_page: '25' });
    if (filterBk) qs.set('bookmaker_id', String(filterBk));
    if (q) qs.set('q', q);
    setData(await api.get(`/entity-aliases/?${qs}`));
    setLoad(false);
  }, [entityType, filterBk, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [entityType, filterBk, q]);

  const entityName = (a: EntityAlias) =>
    a.team_name || a.competition_name || a.sport_name || `#${a.team_id || a.competition_id || a.sport_id}`;

  const save = async () => {
    if (!editing?.entity_id || !editing?.bookmaker_id || !editing?.alias_name?.trim()) return;
    const r = await api.post('/entity-aliases/', {
      entity_type: entityType,
      entity_id: editing.entity_id,
      bookmaker_id: editing.bookmaker_id,
      alias_name: editing.alias_name.trim(),
    });
    if (r.id) { onToast('✓ Alias saved'); setEdit(null); load(); }
    else onToast('✗ ' + (r.error || 'Failed'));
  };

  const del = async (a: EntityAlias) => {
    const id = a.id;
    await api.delete(`/entity-aliases/${entityType}/${id}`);
    onToast('Deleted'); load();
  };

  const typeColors: Record<string, string> = { team: '#8b5cf6', competition: '#06b6d4', sport: '#c6f135' };
  const color = typeColors[entityType] || '#c6f135';

  return (
    <div>
      <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(6,182,212,.05)', border: '1px solid rgba(6,182,212,.2)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        ℹ These aliases tell the system that a bookmaker's name <em>"Man Utd"</em> means the same as your
        canonical <em>"Manchester United"</em>. They are used during harvest to match up teams and competitions
        across bookmakers without needing to write parsers.
      </div>

      {/* Type selector */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16 }}>
        {(['team', 'competition', 'sport'] as const).map(t => (
          <button key={t} onClick={() => setET(t)} style={{
            ...s.typeBtn,
            background: entityType === t ? color + '18' : 'transparent',
            borderColor: entityType === t ? color : 'var(--border-dim)',
            color: entityType === t ? color : 'var(--text-muted)',
          }}>{t.toUpperCase()}S</button>
        ))}
      </div>

      <div style={s.toolbar}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search alias names…"
          style={{ ...s.input, flex: 1 }} />
        <select value={filterBk} onChange={e => setFBk(e.target.value ? Number(e.target.value) : '')}
          style={{ ...s.input, cursor: 'pointer' }}>
          <option value="">All Bookmakers</option>
          {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
        </select>
        <button onClick={() => setEdit({ bookmaker_id: bookmakers[0]?.id })} style={s.addBtn}>+ Add Alias</button>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>BOOKMAKER ALIAS NAME</th>
          <th style={s.th}>→ CANONICAL {entityType.toUpperCase()}</th>
          <th style={s.th}>BOOKMAKER</th>
          <th style={{ ...s.th, width: 80 }}>ACTION</th>
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={4} style={s.loading}>Loading…</td></tr>
          : data?.items.map(a => (
            <tr key={a.id} style={s.tr}>
              <td style={s.td}><code style={s.monoCell}>{a.alias_name}</code></td>
              <td style={s.td}><span style={s.name}>{entityName(a)}</span></td>
              <td style={s.td}><Badge label={a.bookmaker_name || '?'} color={color} /></td>
              <td style={s.tdAct}>
                <button onClick={() => del(a)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={`New ${entityType} alias`} onClose={() => setEdit(null)}>
          <Field label="BOOKMAKER">
            <select value={editing.bookmaker_id || ''} onChange={e => setEdit({ ...editing, bookmaker_id: Number(e.target.value) })}
              style={{ ...s.input, width: '100%', boxSizing: 'border-box', cursor: 'pointer' }}>
              <option value="">— select —</option>
              {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
            </select>
          </Field>
          <Field label={`INTERNAL ${entityType.toUpperCase()} ID`} hint="The numeric ID in your database">
            <input type="number" value={editing.entity_id || ''} onChange={e => setEdit({ ...editing, entity_id: Number(e.target.value) })}
              placeholder="e.g. 42" style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <Field label="ALIAS NAME" hint="The exact string this bookmaker uses">
            <input value={editing.alias_name || ''} onChange={e => setEdit({ ...editing, alias_name: e.target.value })}
              placeholder='e.g. "Man Utd" or "Premier League"' style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
          </Field>
          <div style={s.mFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── ENDPOINT MAPS TAB ────────────────────────────────────────────────────────

function EndpointMapsTab({ bookmakers, onToast }: {
  bookmakers: Bookmaker[]; onToast: (m: string) => void;
}) {
  const [filterBk, setFBk]  = useState<number | ''>('');
  const [data, setData]     = useState<Paged<EndpointMap> | null>(null);
  const [loading, setLoad]  = useState(false);
  const [editing, setEdit]  = useState<EndpointMap | null>(null);
  const [page, setPage]     = useState(1);

  const load = useCallback(async () => {
    setLoad(true);
    const qs = new URLSearchParams({ page: String(page), per_page: '30' });
    if (filterBk) qs.set('bookmaker_id', String(filterBk));
    setData(await api.get(`/endpoint-maps/?${qs}`));
    setLoad(false);
  }, [filterBk, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [filterBk]);

  const openEdit = async (em: EndpointMap) => {
    // Load full detail (includes sample_response)
    const full = await api.get(`/endpoint-maps/${em.id}`);
    setEdit(full);
  };

  const save = async () => {
    if (!editing) return;
    await api.put(`/endpoint-maps/${editing.id}`, editing);
    onToast('✓ Saved'); setEdit(null); load();
  };

  const del = async (em: EndpointMap) => {
    if (!confirm('Delete this endpoint map?')) return;
    await api.delete(`/endpoint-maps/${em.id}`);
    onToast('Deleted'); load();
  };

  const setPrimary = async (em: EndpointMap) => {
    await api.post(`/endpoint-maps/${em.id}/set-primary`, {});
    onToast(`✓ ${em.bookmaker_name} is now the primary bookmaker`);
    load();
  };

  const typeColor: Record<string, string> = {
    COMBINED: '#c6f135', MATCH_LIST: '#06b6d4', MARKETS: '#8b5cf6',
  };

  return (
    <div>
      <div style={s.toolbar}>
        <select value={filterBk} onChange={e => setFBk(e.target.value ? Number(e.target.value) : '')}
          style={{ ...s.input, cursor: 'pointer' }}>
          <option value="">All Bookmakers</option>
          {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
        </select>
        <a href="/dashboard/onboard" style={s.addBtn}>+ Onboard New</a>
      </div>

      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>BOOKMAKER</th>
          <th style={s.th}>TYPE</th>
          <th style={s.th}>URL</th>
          <th style={s.th}>PRIMARY</th>
          <th style={s.th}>UPDATED</th>
          <th style={{ ...s.th, width: 140 }}>ACTIONS</th>
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={6} style={s.loading}>Loading…</td></tr>
          : data?.items.map(em => (
            <tr key={em.id} style={s.tr}>
              <td style={s.td}><span style={s.name}>{em.bookmaker_name}</span></td>
              <td style={s.td}><Badge label={em.endpoint_type} color={typeColor[em.endpoint_type] || '#94a3b8'} /></td>
              <td style={s.td}>
                {em.url
                  ? <code style={{ ...s.monoCell, maxWidth: 220, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{em.url}</code>
                  : <span style={s.muted}>—</span>}
              </td>
              <td style={s.td}>
                {em.is_primary_bookmaker
                  ? <Badge label="★ PRIMARY" color="#c6f135" />
                  : <span style={s.muted}>—</span>}
              </td>
              <td style={s.td}><span style={s.muted}>{em.updated_at ? new Date(em.updated_at).toLocaleDateString() : '—'}</span></td>
              <td style={s.tdAct}>
                {!em.is_primary_bookmaker && (
                  <button onClick={() => setPrimary(em)} style={s.editBtn} title="Set as primary">★</button>
                )}
                <button onClick={() => openEdit(em)} style={s.editBtn}>Edit</button>
                <button onClick={() => del(em)} style={s.delBtn}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}

      {editing && (
        <Modal title={`Edit — ${editing.bookmaker_name} ${editing.endpoint_type}`} onClose={() => setEdit(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="URL">
              <input value={editing.url || ''} onChange={e => setEdit({ ...editing, url: e.target.value })}
                style={{ ...s.input, width: '100%', boxSizing: 'border-box', fontFamily: '"Fira Code", monospace', fontSize: 10 }} />
            </Field>
            <Field label="METHOD">
              <select value={editing.method} onChange={e => setEdit({ ...editing, method: e.target.value })}
                style={{ ...s.input, width: '100%', boxSizing: 'border-box', cursor: 'pointer' }}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Left: match paths */}
            <div>
              <div style={s.sectionHead}>MATCH PATHS</div>
              {(['match_list_array_path','match_id_path','home_team_path','away_team_path',
                 'start_time_path','sport_path','competition_path'] as (keyof EndpointMap)[]).map(f => (
                <div key={f} style={{ marginBottom: 8 }}>
                  <label style={s.label}>{f.replace(/_/g, ' ').toUpperCase()}</label>
                  <input value={(editing[f] as string) || ''} onChange={e => setEdit({ ...editing, [f]: e.target.value })}
                    style={{ ...s.input, width: '100%', boxSizing: 'border-box', fontFamily: '"Fira Code", monospace', fontSize: 10 }} />
                </div>
              ))}
            </div>
            {/* Right: market paths */}
            <div>
              <div style={s.sectionHead}>MARKET PATHS</div>
              {(['markets_array_path','market_name_path','specifier_path',
                 'selections_array_path','selection_name_path','selection_price_path'] as (keyof EndpointMap)[]).map(f => (
                <div key={f} style={{ marginBottom: 8 }}>
                  <label style={s.label}>{f.replace(/_/g, ' ').toUpperCase()}</label>
                  <input value={(editing[f] as string) || ''} onChange={e => setEdit({ ...editing, [f]: e.target.value })}
                    style={{ ...s.input, width: '100%', boxSizing: 'border-box', fontFamily: '"Fira Code", monospace', fontSize: 10 }} />
                </div>
              ))}
            </div>
          </div>

          <Field label="CURL TEMPLATE">
            <textarea value={editing.curl_template || ''} onChange={e => setEdit({ ...editing, curl_template: e.target.value })}
              style={{ ...s.textarea, height: 80 }} />
          </Field>
          <label style={s.checkRow}>
            <input type="checkbox" checked={!!editing.is_active} onChange={e => setEdit({ ...editing, is_active: e.target.checked })} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>Active</span>
          </label>
          <div style={s.mFooter}>
            <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
            <button onClick={save} style={s.saveBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── PARSER TAB ───────────────────────────────────────────────────────────────

function ParserTab({ bookmakers, onToast }: { bookmakers: Bookmaker[]; onToast: (m: string) => void }) {
  const [filterBk, setFBk] = useState<number | ''>('');
  const [maps, setMaps]    = useState<EndpointMap[]>([]);
  const [selMap, setSelMap]= useState<number | ''>('');
  const [code, setCode]    = useState('');
  const [loading, setLoad] = useState(false);
  const [copied, setCopied]= useState(false);

  useEffect(() => {
    if (!filterBk) { setMaps([]); setSelMap(''); return; }
    api.get(`/endpoint-maps/?bookmaker_id=${filterBk}&per_page=20`).then(r => setMaps(r.items || []));
  }, [filterBk]);

  const generate = async () => {
    if (!selMap) return;
    setLoad(true);
    const r = await api.get(`/endpoint-maps/${selMap}/parser`);
    setLoad(false);
    if (r.parser_code) setCode(r.parser_code);
    else onToast('✗ ' + (r.error || 'Failed'));
  };

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(198,241,53,.03)',
        border: '1px solid rgba(198,241,53,.1)', fontFamily: 'var(--font-mono)', fontSize: 10,
        color: 'var(--text-muted)', lineHeight: 1.7 }}>
        ℹ Generate a deterministic <code style={{ color: '#c6f135' }}>parse_data()</code> function from stored
        accessor paths — no AI required. Copy it to use in your harvest tasks, or let the harvest service
        call <code style={{ color: '#c6f135' }}>BookmakerEndpointMap.build_parser_code()</code> directly.
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={s.label}>BOOKMAKER</label>
          <select value={filterBk} onChange={e => setFBk(e.target.value ? Number(e.target.value) : '')}
            style={{ ...s.input, cursor: 'pointer', minWidth: 200 }}>
            <option value="">— select bookmaker —</option>
            {bookmakers.map(b => <option key={b.id} value={b.id}>{b.name || b.domain}</option>)}
          </select>
        </div>
        {maps.length > 0 && (
          <div>
            <label style={s.label}>ENDPOINT TYPE</label>
            <select value={selMap} onChange={e => setSelMap(e.target.value ? Number(e.target.value) : '')}
              style={{ ...s.input, cursor: 'pointer', minWidth: 200 }}>
              <option value="">— select endpoint —</option>
              {maps.map(m => <option key={m.id} value={m.id}>{m.endpoint_type}</option>)}
            </select>
          </div>
        )}
        <button onClick={generate} disabled={!selMap || loading} style={{
          ...s.addBtn, opacity: (!selMap || loading) ? 0.5 : 1,
          padding: '9px 20px', fontFamily: 'var(--font-mono)', fontSize: 10,
        }}>
          {loading ? '⟳ GENERATING…' : '⚡ GENERATE PARSER'}
        </button>
      </div>

      {code && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={s.sectionHead}>GENERATED PARSER CODE</div>
            <button onClick={copy} style={{ ...s.editBtn, color: copied ? '#c6f135' : undefined }}>
              {copied ? '✓ COPIED' : 'COPY'}
            </button>
          </div>
          <pre style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)',
            padding: 16, overflowX: 'auto', fontFamily: '"Fira Code", monospace',
            fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)',
            maxHeight: 480, overflowY: 'auto', margin: 0 }}>
            {code}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function MappingManager() {
  const [tab, setTab]   = useState<Tab>('markets');
  const [toast, setToast] = useState('');
  const [meta, setMeta] = useState<{ bookmakers: Bookmaker[]; sports: Sport[] }>({ bookmakers: [], sports: [] });

  useEffect(() => { api.get('/meta/').then(setMeta); }, []);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'markets',      label: 'Markets & Aliases' },
    { key: 'aliases',      label: 'Team / Competition / Sport Aliases' },
    { key: 'endpoint-maps',label: 'Endpoint Maps' },
    { key: 'parser',       label: 'Parser Generator' },
  ];

  return (
    <div style={s.page}>
      <Toast msg={toast} onClear={() => setToast('')} />

      <div style={s.header}>
        <div>
          <h1 style={s.title}>MAPPING MANAGER</h1>
          <p style={s.subtitle}>
            Markets · Entity Aliases · JSON Path Config · Deterministic Parsers
          </p>
        </div>
        <a href="/dashboard/onboard" style={s.outlineBtn}>+ ONBOARD BOOKMAKER</a>
      </div>

      <div style={s.tabBar}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ ...s.tab, ...(tab === t.key ? s.tabActive : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={s.panel}>
        {tab === 'markets'       && <MarketsTab       sports={meta.sports} bookmakers={meta.bookmakers} onToast={setToast} />}
        {tab === 'aliases'       && <EntityAliasesTab bookmakers={meta.bookmakers} onToast={setToast} />}
        {tab === 'endpoint-maps' && <EndpointMapsTab  bookmakers={meta.bookmakers} onToast={setToast} />}
        {tab === 'parser'        && <ParserTab        bookmakers={meta.bookmakers} onToast={setToast} />}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1200, padding: '0 0 80px' },
  header:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  title:   { fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, letterSpacing: 3, margin: 0 },
  subtitle:{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2, marginTop: 4 },

  tabBar: { display: 'flex', borderBottom: '1px solid var(--border-dim)' },
  tab: {
    padding: '12px 20px', background: 'transparent', border: 'none',
    borderBottom: '2px solid transparent', color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer',
  },
  tabActive: { color: 'var(--text-primary)', borderBottomColor: '#c6f135' },
  panel:   { background: 'var(--bg-surface)', border: '1px solid var(--border-dim)', borderTop: 'none', padding: '20px 24px' },

  toolbar: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  addBtn:  { background: '#c6f135', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: '8px 18px', cursor: 'pointer', textDecoration: 'none', display: 'inline-block', flexShrink: 0 },
  outlineBtn: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-base)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, padding: '8px 16px', cursor: 'pointer', textDecoration: 'none', display: 'inline-block' },

  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 10 },
  th:    { padding: '7px 12px', background: 'rgba(255,255,255,.02)', borderBottom: '1px solid var(--border-dim)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', textAlign: 'left', fontWeight: 700 },
  tr:    { borderBottom: '1px solid var(--border-dim)' },
  td:    { padding: '9px 12px', verticalAlign: 'middle' },
  tdAct: { padding: '9px 12px', display: 'flex', gap: 5, alignItems: 'center' },
  loading:{ padding: '36px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
  name:   { fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  monoCell:{ fontFamily: '"Fira Code", monospace', fontSize: 11, color: '#06b6d4', background: 'rgba(6,182,212,.08)', padding: '2px 7px', border: '1px solid rgba(6,182,212,.15)' },
  muted:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },

  editBtn:{ background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)', padding: '4px 10px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: .5 },
  delBtn: { background: 'transparent', border: '1px solid rgba(255,61,90,.25)', color: '#ff3d5a', padding: '4px 10px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9 },

  pgBtn:     { background: 'var(--bg-base)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)', padding: '3px 9px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, minWidth: 28 },
  pgBtnActive:{ background: 'rgba(198,241,53,.1)', borderColor: 'rgba(198,241,53,.4)', color: '#c6f135' },

  typeBtn:{ padding: '6px 18px', border: '1px solid', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, cursor: 'pointer', marginRight: -1 },

  overlay:{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal:  { background: 'var(--bg-surface)', border: '1px solid var(--border-base)', width: '100%', maxWidth: 700, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.6)' },
  modalHead:{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-dim)' },
  modalTitle:{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, fontWeight: 700 },
  modalBody: { padding: '20px' },
  mFooter:{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 },

  sectionHead:{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 3, color: '#c6f135', borderBottom: '1px solid var(--border-dim)', paddingBottom: 6, marginBottom: 10, display: 'flex', alignItems: 'center' },

  label:  { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 5 },
  hint:   { fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 4 },
  input:  { background: 'var(--bg-base)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 11px', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' },
  textarea:{ width: '100%', boxSizing: 'border-box' as const, background: 'var(--bg-base)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', padding: '8px 11px', fontFamily: '"Fira Code", monospace', fontSize: 11, outline: 'none', resize: 'vertical' as const },
  checkRow:{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 8 },
  iconBtn: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, padding: '2px 6px' },

  saveBtn:  { padding: '8px 22px', background: '#c6f135', color: '#0a0a0a', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 1, cursor: 'pointer' },
  cancelBtn:{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10, cursor: 'pointer' },

  toast:  { position: 'fixed' as const, top: 20, right: 24, zIndex: 9999, background: 'var(--bg-surface)', border: '1px solid', padding: '10px 20px', fontFamily: 'var(--font-mono)', fontSize: 11, boxShadow: '0 4px 20px rgba(0,0,0,.4)' },
};