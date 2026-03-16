/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchWithAuth } from '../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Payment {
  id: number; bookmaker_id: number; provider: string;
  channel_type: string; number: string; label: string | null; is_active: boolean;
}

interface Bookmaker {
  id: number; name: string; domain: string; brand_color: string | null;
  logo_url: string | null; is_active: boolean; needs_ui_intervention: boolean;
  currency: string | null; min_bet_amount: string | null; max_bet_amount: string | null;
  max_bets_per_day: number | null; tax_percent: string | null; tax_flat_amount: string | null;
  last_discovery_at: string | null; payments: Payment[];
  vendor_slug?: string;
}

// CSV row
interface CsvRow {
  name: string; domain: string; brand_color: string; currency: string;
  min_bet_amount: string; max_bet_amount: string; tax_percent: string;
  mpesa_paybill: string; mpesa_paybill_label: string; airtel_paybill: string;
  airtel_paybill_label: string; mpesa_sms: string; airtel_sms: string;
  // harvest config columns (from kenya_bookmakers.csv)
  vendor_slug:      string;   // "betb2b" | "sportpesa" | ""
  betb2b_partner:   string;   // partner ID e.g. "61"
  betb2b_gr:        string;   // group filter e.g. "656"
  betb2b_endpoint:  string;   // "LiveFeed" | "LineFeed"
  _status?: 'pending' | 'importing' | 'ok' | 'skip' | 'error';
  _error?: string;
}

const CSV_COLUMNS = [
  'name','domain','brand_color','currency','min_bet_amount','max_bet_amount',
  'tax_percent','mpesa_paybill','mpesa_paybill_label','airtel_paybill',
  'airtel_paybill_label','mpesa_sms','airtel_sms',
  // harvest config columns
  'vendor_slug','betb2b_partner','betb2b_gr','betb2b_endpoint',
] as const;

const CSV_TEMPLATE = 'name,domain,brand_color,currency,min_bet_amount,max_bet_amount,tax_percent,mpesa_paybill,mpesa_paybill_label,airtel_paybill,airtel_paybill_label,mpesa_sms,airtel_sms,vendor_slug,betb2b_partner,betb2b_gr,betb2b_endpoint\n' +
  'Betika,betika.com,#00693E,KES,10,500000,20,290290,Betika Deposits,290290,Betika Airtel,29029,29029,,,, \n' +
  '1xBet,1xbet.co.ke,#1F8AEB,KES,10,,20,290435,1xBet Deposit,290435,1xBet Airtel,20019,,betb2b,61,656,LiveFeed\n' +
  'Helabet,helabetke.com,#9C27B0,KES,10,,20,290700,Helabet Deposit,290700,Helabet Airtel,29070,,betb2b,237,,LineFeed\n';

const CHANNEL_TYPES = ['paybill', 'till', 'sms', 'bank_account', 'other'] as const;
const CHANNEL_COLOR: Record<string, string> = {
  paybill: 'var(--acid)', till: 'var(--cyan)', sms: 'var(--amber)',
  bank_account: '#5577ff', other: 'var(--text-muted)',
};
const PROVIDERS = ['M-Pesa', 'Airtel Money', 'T-Kash', 'Equitel', 'Bank', 'Other'];

const ALL_SPORTS = ['Football','Basketball','Tennis','Ice Hockey','Volleyball','Cricket','Rugby'];
const DEFAULT_SPORT_IDS: Record<string,string> = {
  Football:'1', Basketball:'3', Tennis:'4', 'Ice Hockey':'2',
  Volleyball:'5', Cricket:'21', Rugby:'8',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Toast({ msg, onClear }: { msg: string; onClear: () => void }) {
  useEffect(() => { if (!msg) return; const t = setTimeout(onClear, 3000); return () => clearTimeout(t); }, [msg, onClear]);
  if (!msg) return null;
  const isErr = msg.startsWith('✗');
  return (
    <div style={{ position:'fixed', bottom:24, right:24, zIndex:9999, background:'var(--bg-elevated)',
      border:`1px solid ${isErr?'rgba(255,61,90,0.5)':'rgba(198,241,53,0.5)'}`,
      color:isErr?'var(--red)':'var(--acid)', padding:'10px 20px',
      fontFamily:'var(--font-mono)', fontSize:11, boxShadow:'0 4px 24px rgba(0,0,0,0.6)', letterSpacing:1 }}>
      {msg}
    </div>
  );
}

function Confirm({ msg, onYes, onNo }: { msg:string; onYes:()=>void; onNo:()=>void }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:9100, background:'rgba(0,0,0,0.75)',
      display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-base)', padding:'28px 32px', maxWidth:380, width:'90%' }}>
        <p style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-primary)', marginBottom:24, lineHeight:1.7 }}>{msg}</p>
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button onClick={onNo} style={s.btnGhost}>CANCEL</button>
          <button onClick={onYes} style={s.btnDanger}>CONFIRM</button>
        </div>
      </div>
    </div>
  );
}

// ─── CSV parse ────────────────────────────────────────────────────────────────

function parseCsv(raw: string): { rows: CsvRow[]; errors: string[] } {
  const lines  = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const errors: string[] = [];
  if (lines.length < 2) return { rows:[], errors:['CSV must have a header and at least one data row'] };
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows: CsvRow[] = [];
  lines.slice(1).forEach((line, i) => {
    const fields: string[] = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch==='"') { inQ=!inQ; } else if (ch===','&&!inQ) { fields.push(cur.trim()); cur=''; } else { cur+=ch; }
    }
    fields.push(cur.trim());
    const obj: Record<string,string> = {};
    header.forEach((h,j) => { obj[h] = fields[j]??''; });
    if (!obj.domain) { errors.push(`Row ${i+2}: missing domain`); return; }
    rows.push({
      name:obj.name??'', domain:obj.domain??'', brand_color:obj.brand_color??'',
      currency:obj.currency??'KES', min_bet_amount:obj.min_bet_amount??'',
      max_bet_amount:obj.max_bet_amount??'', tax_percent:obj.tax_percent??'',
      mpesa_paybill:obj.mpesa_paybill??'', mpesa_paybill_label:obj.mpesa_paybill_label??'',
      airtel_paybill:obj.airtel_paybill??'', airtel_paybill_label:obj.airtel_paybill_label??'',
      mpesa_sms:obj.mpesa_sms??'', airtel_sms:obj.airtel_sms??'',
      // harvest config
      vendor_slug:     obj.vendor_slug??'',
      betb2b_partner:  obj.betb2b_partner??'',
      betb2b_gr:       obj.betb2b_gr??'',
      betb2b_endpoint: obj.betb2b_endpoint??'LiveFeed',
      _status:'pending',
    });
  });
  return { rows, errors };
}

function rowToPayments(row: CsvRow) {
  const out: any[] = [];
  if (row.mpesa_paybill)  out.push({ provider:'M-Pesa',       channel_type:'paybill', number:row.mpesa_paybill,  label:row.mpesa_paybill_label||'M-Pesa Paybill',  is_active:true });
  if (row.airtel_paybill) out.push({ provider:'Airtel Money', channel_type:'paybill', number:row.airtel_paybill, label:row.airtel_paybill_label||'Airtel Paybill', is_active:true });
  if (row.mpesa_sms)      out.push({ provider:'M-Pesa',       channel_type:'sms',     number:row.mpesa_sms,      label:'M-Pesa SMS',                               is_active:true });
  if (row.airtel_sms)     out.push({ provider:'Airtel Money', channel_type:'sms',     number:row.airtel_sms,     label:'Airtel SMS',                               is_active:true });
  return out;
}

// ─── Harvest Config section (reusable) ───────────────────────────────────────
// Shows inside both EditModal and BulkImport preview.

interface HarvestForm {
  vendor_slug:    string;
  betb2b_partner: string;
  betb2b_gr:      string;
  betb2b_endpoint:string;
}

function HarvestConfigSection({
  form, onChange, bookmarkerId, showToast, inline = false,
}: {
  form: HarvestForm;
  onChange: (f: HarvestForm) => void;
  bookmarkerId?: number | null;
  showToast?: (msg: string) => void;
  inline?: boolean;   // true = compact for preview table
}) {
  const [autoFilling, setAutoFilling] = useState(false);
  const [sportStatus, setSportStatus] = useState<Record<string,boolean>>({});

  const set = (k: keyof HarvestForm) => (v: string) => onChange({ ...form, [k]: v });

  const doAutoFill = async () => {
    if (!bookmarkerId || !form.betb2b_partner) return;
    setAutoFilling(true);
    try {
      const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config/sports/auto-fill`, {
        method: 'POST',
        body: JSON.stringify({
          partner: form.betb2b_partner,
          gr:      form.betb2b_gr || '',
          sports:  ALL_SPORTS,
        }),
      }).then(r => r.json());
      if (res.ok) {
        const statuses: Record<string,boolean> = {};
        (res.filled_sports || []).forEach((sp: string) => { statuses[sp] = true; });
        setSportStatus(statuses);
        showToast?.(`✓ Auto-filled ${res.filled_sports?.length} sport configs`);
      } else {
        showToast?.(`✗ ${res.error}`);
      }
    } catch (e: any) { showToast?.(`✗ ${e.message}`); }
    setAutoFilling(false);
  };

  if (inline) {
    // Compact read-only summary for bulk import preview
    if (!form.vendor_slug) return <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)' }}>—</span>;
    return (
      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--cyan)', letterSpacing:1 }}>{form.vendor_slug}</span>
        {form.betb2b_partner && (
          <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--acid)' }}>partner={form.betb2b_partner}</span>
        )}
        {form.betb2b_gr && (
          <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)' }}>gr={form.betb2b_gr}</span>
        )}
        {form.betb2b_endpoint && form.betb2b_endpoint !== 'LiveFeed' && (
          <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'#fb923c' }}>{form.betb2b_endpoint}</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Vendor type */}
      <div style={s.fieldWrap}>
        <label style={s.label}>VENDOR TYPE</label>
        <select value={form.vendor_slug} onChange={e => set('vendor_slug')(e.target.value)} style={s.input}>
          <option value="">— select vendor —</option>
          <option value="betb2b">BetB2B (1xBet, 22Bet, Melbet, Betwinner, Megapari, Helabet, Paripesa…)</option>
          <option value="sportpesa">Sportpesa</option>
          <option value="generic">Generic JSON</option>
        </select>
      </div>

      {/* BetB2B config */}
      {form.vendor_slug === 'betb2b' && (
        <>
          <div style={{ padding:'10px 14px', background:'rgba(198,241,53,.03)', border:'1px solid rgba(198,241,53,.15)', display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'var(--acid)' }}>
              BETB2B CREDENTIALS
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
              <div style={s.fieldWrap}>
                <label style={s.label}>PARTNER ID *</label>
                <input value={form.betb2b_partner} onChange={e => set('betb2b_partner')(e.target.value)}
                  placeholder="e.g. 61" style={s.input} />
                <span style={s.hint}>From Get1x2_VZip?partner= in DevTools</span>
              </div>
              <div style={s.fieldWrap}>
                <label style={s.label}>GR (group filter)</label>
                <input value={form.betb2b_gr} onChange={e => set('betb2b_gr')(e.target.value)}
                  placeholder="e.g. 656 (blank for Helabet)" style={s.input} />
              </div>
              <div style={s.fieldWrap}>
                <label style={s.label}>ENDPOINT</label>
                <select value={form.betb2b_endpoint} onChange={e => set('betb2b_endpoint')(e.target.value)} style={s.input}>
                  <option value="LiveFeed">LiveFeed (standard)</option>
                  <option value="LineFeed">LineFeed (Helabet)</option>
                </select>
              </div>
            </div>

            {/* Auto-fill sports */}
            {bookmarkerId && (
              <div style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 12px', background:'rgba(0,0,0,.2)', border:'1px solid rgba(255,255,255,.06)' }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-primary)' }}>
                    AUTO-FILL SPORT CONFIGS
                  </div>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)', marginTop:3 }}>
                    Generates per-sport endpoint configs for all sports using the partner ID above
                  </div>
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                  {ALL_SPORTS.map(sp => (
                    <span key={sp} style={{ fontFamily:'var(--font-mono)', fontSize:6, padding:'1px 5px',
                      color: sportStatus[sp] ? 'var(--acid)' : 'var(--text-muted)',
                      border: `1px solid ${sportStatus[sp] ? 'rgba(198,241,53,.3)' : 'rgba(255,255,255,.08)'}` }}>
                      {sportStatus[sp] ? '✓' : '○'} {sp}
                    </span>
                  ))}
                </div>
                <button onClick={doAutoFill} disabled={autoFilling || !form.betb2b_partner}
                  style={{ ...s.btnPrimary, fontSize:8, padding:'6px 14px', opacity:(!form.betb2b_partner||autoFilling)?.5:1 }}>
                  {autoFilling ? '⟳ FILLING…' : '⚡ AUTO-FILL ALL SPORTS'}
                </button>
              </div>
            )}
            {!bookmarkerId && form.betb2b_partner && (
              <div style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)', padding:'6px 10px', background:'rgba(0,0,0,.2)' }}>
                ℹ Sport endpoint configs will be auto-generated after registering this bookmaker
              </div>
            )}
          </div>

          {/* Quick reference for confirmed partner IDs */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
            {[
              { name:'1xBet',     partner:'61',  gr:'656', ep:'LiveFeed' },
              { name:'22Bet',     partner:'2',   gr:'656', ep:'LiveFeed' },
              { name:'Betwinner', partner:'3',   gr:'656', ep:'LiveFeed' },
              { name:'Melbet',    partner:'4',   gr:'656', ep:'LiveFeed' },
              { name:'Megapari',  partner:'6',   gr:'656', ep:'LiveFeed' },
              { name:'Helabet',   partner:'237', gr:'',    ep:'LineFeed' },
              { name:'Paripesa',  partner:'188', gr:'764', ep:'LiveFeed' },
            ].map(bk => (
              <button key={bk.name}
                onClick={() => onChange({ ...form, betb2b_partner:bk.partner, betb2b_gr:bk.gr, betb2b_endpoint:bk.ep })}
                style={{ background:'rgba(255,255,255,.03)', border:`1px solid ${form.betb2b_partner===bk.partner?'var(--acid)':'rgba(255,255,255,.08)'}`,
                  padding:'4px 8px', cursor:'pointer', textAlign:'left' as const }}>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:form.betb2b_partner===bk.partner?'var(--acid)':'var(--text-primary)' }}>{bk.name}</div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:6, color:'var(--text-muted)' }}>partner={bk.partner}{bk.gr?` gr=${bk.gr}`:''}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {form.vendor_slug === 'sportpesa' && (
        <div style={{ padding:'10px 14px', background:'rgba(56,189,248,.03)', border:'1px solid rgba(56,189,248,.15)', fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' }}>
          ℹ Sportpesa uses a fixed endpoint — no partner ID needed.
          Config: list_url=https://www.ke.sportpesa.com/api/games, markets=10,46,52,43
          {bookmarkerId && (
            <button onClick={async () => {
              const res = await fetchWithAuth(`/bookmakers/${bookmarkerId}/config`, {
                method:'PUT', body: JSON.stringify({
                  vendor_slug:'sportpesa',
                  harvest_config: {
                    headers:{ Accept:'application/json' }, params:{ markets:'10,46,52,43' },
                    list_url:'https://www.ke.sportpesa.com/api/games',
                    markets_url:'https://www.ke.sportpesa.com/api/games/markets',
                  }
                }),
              }).then(r=>r.json());
              if (res.ok) alert('✓ Sportpesa config saved');
            }} style={{ ...s.btnPrimary, fontSize:7, padding:'4px 10px', marginLeft:10 }}>
              ⚡ SAVE SPORTPESA CONFIG
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Bulk Import Modal ────────────────────────────────────────────────────────

function BulkImportModal({ onClose, onDone }: { onClose:()=>void; onDone:()=>void }) {
  const [csvText,   setCsvText]  = useState('');
  const [rows,      setRows]     = useState<CsvRow[]>([]);
  const [parseErrs, setParseErrs]= useState<string[]>([]);
  const [importing, setImporting]= useState(false);
  const [step,      setStep]     = useState<'input'|'preview'|'done'>('input');
  const [progress,  setProgress] = useState({ ok:0, skip:0, err:0, total:0 });
  const fileRef = useRef<HTMLInputElement>(null);

  const handleParse = () => {
    const { rows: parsed, errors } = parseCsv(csvText);
    setParseErrs(errors);
    setRows(parsed.map(r => ({ ...r, _status:'pending' })));
    if (parsed.length > 0) setStep('preview');
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsvText(String(ev.target?.result??''));
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download='bookmakers_template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async () => {
    setImporting(true);
    let ok=0, skip=0, err=0;
    setProgress({ ok, skip, err, total:rows.length });

    for (let i=0; i<rows.length; i++) {
      const row = rows[i];
      setRows(prev => prev.map((r,j) => j===i ? {...r,_status:'importing'} : r));
      try {
        // Step 1: register bookmaker
        const res = await fetchWithAuth('/bookmakers/onboard', {
          method:'POST', body:JSON.stringify({ name:row.name||row.domain, domain:row.domain,
            brand_color:row.brand_color||null, currency:row.currency||'KES',
            min_bet_amount:row.min_bet_amount||null, max_bet_amount:row.max_bet_amount||null,
            tax_percent:row.tax_percent||null, is_active:true }),
        });
        const bm = await res.json();
        const bmId = bm.id;

        if (!bmId) throw new Error(bm.error || `HTTP ${res.status}`);

        // Step 2: set vendor_slug
        if (row.vendor_slug) {
          await fetchWithAuth(`/bookmaker/${bmId}`, {
            method:'PUT', body:JSON.stringify({ vendor_slug:row.vendor_slug }),
          });
        }

        // Step 3: payments
        const payments = rowToPayments(row);
        for (const pm of payments) {
          await fetchWithAuth(`/bookmaker/${bmId}/payments`, { method:'POST', body:JSON.stringify(pm) }).catch(()=>{});
        }

        // Step 4: auto-fill sport configs if BetB2B with partner ID
        let sportsFilled = 0;
        if (row.vendor_slug==='betb2b' && row.betb2b_partner) {
          const sfRes = await fetchWithAuth(`/bookmakers/${bmId}/config/sports/auto-fill`, {
            method:'POST', body:JSON.stringify({
              partner: row.betb2b_partner,
              gr:      row.betb2b_gr||'',
              sports:  ALL_SPORTS,
            }),
          }).then(r=>r.json()).catch(()=>({ ok:false }));
          if (sfRes.ok) sportsFilled = sfRes.filled_sports?.length || 0;
        }

        const wasExisting = bm.existing === true;
        if (wasExisting) { skip++; }
        else             { ok++; }
        const note = [
          wasExisting ? 'existing' : null,
          payments.length ? `${payments.length} payments` : null,
          sportsFilled ? `${sportsFilled} sports` : null,
        ].filter(Boolean).join(', ');

        setRows(prev => prev.map((r,j) => j===i ? {...r, _status:wasExisting?'skip':'ok', _error:note||undefined} : r));
      } catch(e:any) {
        err++;
        setRows(prev => prev.map((r,j) => j===i ? {...r,_status:'error',_error:e.message} : r));
      }
      setProgress(p => ({ ...p, ok, skip, err }));
    }
    setProgress({ ok, skip, err, total:rows.length });
    setImporting(false);
    setStep('done');
    if (ok>0) onDone();
  };

  const statusIcon = (st: CsvRow['_status']) => ({
    pending:  { icon:'○', c:'var(--text-muted)' },
    importing:{ icon:'⟳', c:'var(--amber)' },
    ok:       { icon:'✓', c:'var(--acid)' },
    skip:     { icon:'—', c:'var(--cyan)' },
    error:    { icon:'✗', c:'var(--red)' },
  }[st??'pending']);

  const hasPayment = (r:CsvRow) => r.mpesa_paybill||r.airtel_paybill||r.mpesa_sms||r.airtel_sms;
  const hasBetB2B  = rows.some(r => r.vendor_slug==='betb2b' && r.betb2b_partner);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9200, background:'rgba(0,0,0,0.85)',
      display:'flex', alignItems:'flex-start', justifyContent:'center',
      padding:'24px 16px', overflowY:'auto' }}>
      <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-base)', width:'100%', maxWidth:960 }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 24px',
          borderBottom:'1px solid var(--border-dim)', background:'var(--bg-elevated)' }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:3, color:'var(--acid)' }}>⊕ BULK IMPORT BOOKMAKERS</span>
          <div style={{ flex:1 }}/>
          {step==='input' && <button onClick={downloadTemplate} style={s.btnGhost}>↓ DOWNLOAD TEMPLATE</button>}
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', fontSize:16, cursor:'pointer', padding:4 }}>✕</button>
        </div>

        {importing && (
          <div style={{ height:3, background:'var(--bg-base)' }}>
            <div style={{ height:'100%', background:'var(--acid)', transition:'width .3s',
              width:`${Math.round(((progress.ok+progress.skip+progress.err)/(progress.total||1))*100)}%` }}/>
          </div>
        )}

        {/* ── INPUT ── */}
        {step==='input' && (
          <div style={{ padding:'24px', display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ padding:'12px 16px', background:'rgba(6,182,212,0.05)',
              border:'1px solid rgba(6,182,212,0.15)', fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', lineHeight:2 }}>
              <div style={{ color:'var(--cyan)', letterSpacing:2, marginBottom:6 }}>CSV COLUMNS</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 20px' }}>
                {(['domain *','name','brand_color','currency','tax_percent',
                   'mpesa_paybill','airtel_paybill','mpesa_sms','airtel_sms',
                   'vendor_slug','betb2b_partner','betb2b_gr','betb2b_endpoint'] as const).map(c => (
                  <span key={c} style={{ color:c.includes('*')?'var(--acid)':c.startsWith('betb2b')||c==='vendor_slug'?'var(--cyan)':'var(--text-muted)' }}>{c}</span>
                ))}
              </div>
              <div style={{ marginTop:8, color:'rgba(100,116,139,.6)' }}>
                <span style={{ color:'var(--acid)' }}>domain</span> required.
                <span style={{ color:'var(--cyan)', marginLeft:8 }}>vendor_slug / betb2b_partner / betb2b_gr / betb2b_endpoint</span> — for harvest config auto-setup.
              </div>
            </div>

            <div>
              <label style={s.label}>UPLOAD CSV FILE</label>
              <div style={{ display:'flex', gap:8, marginTop:4 }}>
                <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display:'none' }}/>
                <button onClick={()=>fileRef.current?.click()} style={{ ...s.btnGhost, flex:1, textAlign:'center' as const }}>📂 CHOOSE FILE</button>
              </div>
            </div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', textAlign:'center', letterSpacing:2 }}>— OR PASTE CSV —</div>
            <div>
              <label style={s.label}>PASTE CSV</label>
              <textarea value={csvText} onChange={e=>setCsvText(e.target.value)}
                placeholder={`Paste CSV here…\n${CSV_TEMPLATE}`}
                rows={8} style={{ ...s.input, marginTop:4, resize:'vertical', fontFamily:'var(--font-mono)', fontSize:9, lineHeight:1.7, width:'100%', boxSizing:'border-box' as const }}/>
            </div>
            {parseErrs.length>0 && (
              <div style={{ padding:'10px 14px', background:'rgba(255,61,90,0.06)', border:'1px solid rgba(255,61,90,0.2)', display:'flex', flexDirection:'column', gap:4 }}>
                {parseErrs.map((e,i)=><div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--red)' }}>✗ {e}</div>)}
              </div>
            )}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button onClick={onClose} style={s.btnGhost}>CANCEL</button>
              <button onClick={handleParse} disabled={!csvText.trim()} style={{ ...s.btnPrimary, opacity:csvText.trim()?1:0.4 }}>PARSE & PREVIEW →</button>
            </div>
          </div>
        )}

        {/* ── PREVIEW ── */}
        {step==='preview' && (
          <div style={{ display:'flex', flexDirection:'column' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 24px',
              background:'var(--bg-elevated)', borderBottom:'1px solid var(--border-dim)' }}>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--acid)', letterSpacing:2 }}>
                {rows.length} BOOKMAKER{rows.length!==1?'S':''} PARSED
              </span>
              {hasBetB2B && (
                <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--cyan)' }}>
                  · {rows.filter(r=>r.vendor_slug==='betb2b'&&r.betb2b_partner).length} WITH BETB2B CONFIG → sports will be auto-filled
                </span>
              )}
              <div style={{ flex:1 }}/>
              <button onClick={()=>setStep('input')} style={s.btnGhost}>← BACK</button>
              <button onClick={runImport} disabled={importing} style={{ ...s.btnPrimary, opacity:importing?.5:1 }}>
                {importing ? 'IMPORTING…' : `⊕ IMPORT ALL ${rows.length}`}
              </button>
            </div>

            <div style={{ overflowX:'auto', maxHeight:460, overflowY:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' as const, minWidth:900 }}>
                <thead style={{ position:'sticky', top:0, zIndex:1 }}>
                  <tr style={{ background:'var(--bg-elevated)' }}>
                    {['#','STATUS','NAME / DOMAIN','BRAND','CURRENCY','TAX','PAYMENTS','HARVEST CONFIG','NOTES'].map(h=>(
                      <th key={h} style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1.5, color:'var(--text-muted)',
                        padding:'7px 10px', textAlign:'left' as const, borderBottom:'1px solid var(--border-dim)', whiteSpace:'nowrap' as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row,i) => {
                    const sm = statusIcon(row._status);
                    return (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border-dim)',
                        background:row._status==='error'?'rgba(255,61,90,0.04)':row._status==='ok'?'rgba(198,241,53,0.03)':row._status==='skip'?'rgba(6,182,212,0.03)':'transparent' }}>
                        <td style={tCell}><span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' }}>{i+1}</span></td>
                        <td style={tCell}>
                          <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:sm.c,
                            display:'inline-block', animation:row._status==='importing'?'spin .7s linear infinite':'none' }}>{sm.icon}</span>
                        </td>
                        <td style={tCell}>
                          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-primary)' }}>{row.name||'—'}</div>
                          <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' }}>{row.domain}</div>
                        </td>
                        <td style={tCell}>
                          {row.brand_color && (
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <div style={{ width:14, height:14, borderRadius:2, background:row.brand_color, flexShrink:0, border:'1px solid rgba(255,255,255,.1)' }}/>
                              <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' }}>{row.brand_color}</span>
                            </div>
                          )}
                        </td>
                        <td style={tCell}><span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--cyan)' }}>{row.currency||'KES'}</span></td>
                        <td style={tCell}>
                          {row.tax_percent ? <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--amber)' }}>{row.tax_percent}%</span>
                            : <span style={{ color:'var(--text-muted)', fontSize:9 }}>—</span>}
                        </td>
                        <td style={tCell}>
                          <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                            {row.mpesa_paybill  && <Pill label="M-Pesa"    type="paybill" value={row.mpesa_paybill} />}
                            {row.airtel_paybill && <Pill label="Airtel"    type="paybill" value={row.airtel_paybill}/>}
                            {row.mpesa_sms      && <Pill label="M-Pesa SMS"type="sms"     value={row.mpesa_sms}    />}
                            {row.airtel_sms     && <Pill label="Airtel SMS"type="sms"     value={row.airtel_sms}   />}
                            {!hasPayment(row)   && <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)' }}>—</span>}
                          </div>
                        </td>
                        {/* Harvest config column */}
                        <td style={tCell}>
                          <HarvestConfigSection
                            form={{ vendor_slug:row.vendor_slug, betb2b_partner:row.betb2b_partner,
                                    betb2b_gr:row.betb2b_gr, betb2b_endpoint:row.betb2b_endpoint }}
                            onChange={() => {}}
                            inline
                          />
                        </td>
                        <td style={tCell}>
                          {row._error && <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:row._status==='ok'||row._status==='skip'?'var(--text-muted)':'var(--red)' }}>{row._error}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display:'flex', justifyContent:'flex-end', gap:8, padding:'14px 24px',
              borderTop:'1px solid var(--border-dim)', background:'var(--bg-elevated)' }}>
              <button onClick={()=>setStep('input')} disabled={importing} style={{ ...s.btnGhost, opacity:importing?.4:1 }}>← BACK</button>
              <button onClick={runImport} disabled={importing} style={{ ...s.btnPrimary, opacity:importing?.5:1 }}>
                {importing?`IMPORTING… (${progress.ok+progress.skip+progress.err}/${progress.total})`:`⊕ IMPORT ALL ${rows.length}`}
              </button>
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {step==='done' && (
          <div style={{ padding:'32px 24px', display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
            <div style={{ fontSize:36, color:'var(--acid)' }}>✓</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:12, letterSpacing:3, color:'var(--acid)' }}>IMPORT COMPLETE</div>
            <div style={{ display:'flex', gap:24 }}>
              {[
                { label:'CREATED', val:rows.filter(r=>r._status==='ok').length,   c:'var(--acid)' },
                { label:'SKIPPED', val:rows.filter(r=>r._status==='skip').length,  c:'var(--cyan)' },
                { label:'ERRORS',  val:rows.filter(r=>r._status==='error').length, c:'var(--red)'  },
              ].map(({label,val,c})=>(
                <div key={label} style={{ textAlign:'center' as const }}>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:28, fontWeight:800, color:c }}>{val}</div>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'var(--text-muted)' }}>{label}</div>
                </div>
              ))}
            </div>
            {rows.some(r=>r._status==='error') && (
              <div style={{ width:'100%', maxHeight:140, overflowY:'auto', padding:'10px 14px',
                background:'rgba(255,61,90,0.06)', border:'1px solid rgba(255,61,90,0.2)' }}>
                {rows.filter(r=>r._status==='error').map((r,i)=>(
                  <div key={i} style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--red)', marginBottom:3 }}>✗ {r.domain}: {r._error}</div>
                ))}
              </div>
            )}
            <div style={{ display:'flex', gap:8 }}>
              {rows.some(r=>r._status==='error') && (
                <button onClick={()=>{ setRows(rows.map(r=>r._status==='error'?{...r,_status:'pending',_error:undefined}:r)); setStep('preview'); }} style={s.btnGhost}>RETRY ERRORS</button>
              )}
              <button onClick={onClose} style={s.btnPrimary}>CLOSE</button>
            </div>
          </div>
        )}
      </div>
      <style>{'@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

function Pill({ label, type, value }: { label:string; type:string; value:string }) {
  const c = CHANNEL_COLOR[type]??'var(--text-muted)';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:3, background:'var(--bg-base)', border:`1px solid ${c}30`, padding:'1px 6px' }}>
      <span style={{ fontFamily:'var(--font-mono)', fontSize:6, color:c, letterSpacing:1 }}>{type.toUpperCase()}</span>
      <span style={{ fontFamily:'var(--font-display)', fontSize:10, fontWeight:700, color:'var(--text-primary)' }}>{value}</span>
      <span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)' }}>{label}</span>
    </div>
  );
}

const tCell: React.CSSProperties = { padding:'7px 10px', verticalAlign:'top' };

// ─── Payment row ──────────────────────────────────────────────────────────────

interface PaymentForm { provider:string; channel_type:string; number:string; label:string; is_active:boolean }

function PaymentRow({ p, onSave, onDelete }: { p:Payment|null; onSave:(d:PaymentForm)=>Promise<boolean>; onDelete:((()=>void))|null }) {
  const isNew = p===null;
  const [editing,setSaving_] = useState(isNew);
  const [form,setForm] = useState<PaymentForm>({ provider:p?.provider??'M-Pesa', channel_type:p?.channel_type??'paybill', number:p?.number??'', label:p?.label??'', is_active:p?.is_active??true });
  const [saving,setSaving] = useState(false);
  const set = (k:keyof PaymentForm)=>(v:any)=>setForm(f=>({...f,[k]:v}));
  const handleSave = async()=>{ if(!form.number.trim())return; setSaving(true); const ok=await onSave(form); setSaving(false); if(ok){if(isNew)setForm({provider:'M-Pesa',channel_type:'paybill',number:'',label:'',is_active:true}); else setSaving_(false); }};
  if (!editing && !isNew) {
    const tc=CHANNEL_COLOR[p!.channel_type]||'var(--text-muted)';
    return (
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', background:'var(--bg-base)', border:'1px solid var(--border-dim)', opacity:p!.is_active?1:0.45 }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, color:tc, border:`1px solid ${tc}`, padding:'1px 6px', flexShrink:0, textTransform:'uppercase' as const }}>{p!.channel_type}</span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', flexShrink:0 }}>{p!.provider}</span>
        <span style={{ fontFamily:'var(--font-display)', fontSize:15, fontWeight:700, color:'var(--text-primary)', flex:1, letterSpacing:1 }}>{p!.number}</span>
        {p!.label&&<span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', flex:1 }}>{p!.label}</span>}
        <div style={{ display:'flex', gap:5, flexShrink:0 }}>
          <button onClick={()=>setSaving_(true)} style={s.miniBtn}>EDIT</button>
          {onDelete&&<button onClick={onDelete} style={{ ...s.miniBtn, color:'var(--red)', borderColor:'rgba(255,61,90,0.3)' }}>✕</button>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ background:'var(--bg-base)', border:'1px solid rgba(198,241,53,0.2)', padding:'10px 12px' }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1.2fr 1.5fr', gap:8, marginBottom:8 }}>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}><label style={s.label}>PROVIDER</label><input list="prov-list" value={form.provider} onChange={e=>set('provider')(e.target.value)} style={s.input} placeholder="M-Pesa"/><datalist id="prov-list">{PROVIDERS.map(pr=><option key={pr} value={pr}/>)}</datalist></div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}><label style={s.label}>CHANNEL TYPE</label><select value={form.channel_type} onChange={e=>set('channel_type')(e.target.value)} style={s.input}>{CHANNEL_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}><label style={s.label}>NUMBER *</label><input value={form.number} onChange={e=>set('number')(e.target.value)} placeholder="e.g. 290290" style={s.input}/></div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}><label style={s.label}>LABEL</label><input value={form.label} onChange={e=>set('label')(e.target.value)} placeholder="e.g. Deposits only" style={s.input}/></div>
      </div>
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <button onClick={()=>set('is_active')(!form.is_active)} style={{ ...s.miniBtn, color:form.is_active?'var(--acid)':'var(--text-muted)', borderColor:form.is_active?'rgba(198,241,53,0.3)':'var(--border-dim)' }}>{form.is_active?'● ACTIVE':'○ INACTIVE'}</button>
        <div style={{ flex:1 }}/>
        {!isNew&&<button onClick={()=>setSaving_(false)} style={s.btnGhost}>CANCEL</button>}
        <button onClick={handleSave} disabled={saving||!form.number.trim()} style={{ ...s.btnPrimary, fontSize:9, padding:'6px 14px', opacity:(saving||!form.number.trim())?.5:1 }}>{saving?'SAVING…':isNew?'⊕ ADD CHANNEL':'SAVE'}</button>
      </div>
    </div>
  );
}

// ─── Payments Panel ───────────────────────────────────────────────────────────

function PaymentsPanel({ bkId, payments:init, onUpdate, showToast }: { bkId:number; payments:Payment[]; onUpdate:(p:Payment[])=>void; showToast:(m:string)=>void }) {
  const [payments,setPayments] = useState<Payment[]>(init);
  const [confirm,setConfirm]   = useState<Payment|null>(null);
  useEffect(()=>setPayments(init),[init]);
  const sync=(next:Payment[])=>{setPayments(next);onUpdate(next);};
  const handleCreate=async(data:PaymentForm):Promise<boolean>=>{const res=await fetchWithAuth(`/bookmaker/${bkId}/payments`,{method:'POST',body:JSON.stringify(data)});if(!res.ok){showToast('✗ '+((await res.json().catch(()=>({}))).error||'Failed'));return false;}const saved:Payment=await res.json();sync(payments.some(p=>p.id===saved.id)?payments.map(p=>p.id===saved.id?saved:p):[...payments,saved]);showToast('✓ Channel saved');return true;};
  const handleUpdate=async(pid:number,data:PaymentForm):Promise<boolean>=>{const res=await fetchWithAuth(`/bookmaker/payment/${pid}`,{method:'PUT',body:JSON.stringify(data)});if(!res.ok){showToast('✗ Update failed');return false;}showToast('✓ Updated');return true;};
  const handleDelete=async(pid:number)=>{const res=await fetchWithAuth(`/bookmaker/payment/${pid}`,{method:'DELETE'});if(res.ok){sync(payments.filter(p=>p.id!==pid));showToast('✓ Removed');}else showToast('✗ Delete failed');setConfirm(null);};
  return (
    <div>
      {confirm&&<Confirm msg={`Remove ${confirm.provider} ${confirm.channel_type} ${confirm.number}?`} onYes={()=>handleDelete(confirm.id)} onNo={()=>setConfirm(null)}/>}
      <div style={{ ...s.sectionHead, justifyContent:'space-between' }}>
        <span>PAYMENT CHANNELS</span>
        <span style={{ color:'var(--text-muted)', letterSpacing:0 }}>{payments.filter(p=>p.is_active).length} active · {payments.length} total</span>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:10 }}>
        {payments.length===0&&<div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', padding:'12px', border:'1px dashed var(--border-dim)', textAlign:'center', letterSpacing:2 }}>NO CHANNELS YET</div>}
        {payments.map(p=><PaymentRow key={p.id} p={p} onSave={data=>handleUpdate(p.id,data)} onDelete={()=>setConfirm(p)}/>)}
      </div>
      <PaymentRow p={null} onSave={handleCreate} onDelete={null}/>
    </div>
  );
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({ bm, onSave, onClose }: { bm:Bookmaker|null; onSave:(d:Record<string,string>)=>Promise<void>; onClose:()=>void }) {
  const isNew = !bm;
  const [form, setForm] = useState({
    name:bm?.name??'', domain:bm?.domain??'', brand_color:bm?.brand_color??'',
    logo_url:bm?.logo_url??'', currency:bm?.currency??'KES',
    min_bet_amount:bm?.min_bet_amount??'', max_bet_amount:bm?.max_bet_amount??'',
    max_bets_per_day:bm?.max_bets_per_day!=null?String(bm.max_bets_per_day):'',
    tax_percent:bm?.tax_percent??'', tax_flat_amount:bm?.tax_flat_amount??'',
  });
  const [harvestForm, setHarvestForm] = useState<HarvestForm>({
    vendor_slug:    bm?.vendor_slug??'',
    betb2b_partner: '',
    betb2b_gr:      '656',
    betb2b_endpoint:'LiveFeed',
  });
  const [payments, setPayments] = useState<Payment[]>(bm?.payments??[]);
  const [tab, setTab] = useState<'details'|'payments'|'harvest'>('details');
  const [saving,setSaving] = useState(false);
  const [toast, setToast]  = useState('');
  const set = (k:string)=>(v:string)=>setForm(f=>({...f,[k]:v}));

  // load existing harvest config when editing
  useEffect(()=>{
    if (!bm?.id) return;
    fetchWithAuth(`/bookmakers/${bm.id}/config`).then(r=>r.json()).then((d:any)=>{
      const cfg = d.harvest_config || {};
      const params = cfg.params || {};
      setHarvestForm({
        vendor_slug:    d.vendor_slug || bm.vendor_slug || '',
        betb2b_partner: params.partner || '',
        betb2b_gr:      params.gr || '656',
        betb2b_endpoint:'LiveFeed',
      });
    }).catch(()=>{});
  }, [bm?.id]);

  const handleSave = async () => {
    if (!form.domain) return;
    setSaving(true);
    // Save main fields
    await onSave({ ...form, vendor_slug: harvestForm.vendor_slug });
    // If we have harvest config data, save it
    if (bm?.id && harvestForm.vendor_slug==='betb2b' && harvestForm.betb2b_partner) {
      await fetchWithAuth(`/bookmakers/${bm.id}/config`, {
        method:'PUT', body:JSON.stringify({
          vendor_slug: harvestForm.vendor_slug,
          harvest_config: {
            params: { lng:'en', ...(harvestForm.betb2b_gr?{gr:harvestForm.betb2b_gr}:{}),
              mode:'4', country:'87', partner:harvestForm.betb2b_partner,
              virtualSports:'true', noFilterBlockEvent:'true' },
            headers: { 'Accept':'application/json, text/plain, */*',
              'Referer':`https://${form.domain}/en/live`,
              'x-app-n':'__BETTING_APP__','x-mobile-project-id':'0',
              'x-requested-with':'XMLHttpRequest','x-svc-source':'__BETTING_APP__' },
          }
        }),
      }).catch(()=>{});
    }
    setSaving(false);
  };

  const TABS = isNew
    ? ['details','harvest'] as const
    : ['details','payments','harvest'] as const;

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9000, background:'rgba(0,0,0,0.8)',
      display:'flex', alignItems:'flex-start', justifyContent:'center', padding:'32px 16px', overflowY:'auto' }}>
      <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-base)', width:'100%', maxWidth:700 }}>
        <div style={mst.header}>
          <span style={mst.title}>{isNew?'⊕ ADD BOOKMAKER':`EDIT · ${bm?.name||bm?.domain}`}</span>
          <button onClick={onClose} style={mst.close}>✕</button>
        </div>
        <div style={mst.tabs}>
          {TABS.map(t=>(
            <button key={t} onClick={()=>setTab(t as any)} style={{ ...mst.tab, color:tab===t?'var(--acid)':'var(--text-muted)', borderBottomColor:tab===t?'var(--acid)':'transparent' }}>
              {t==='details'&&'DETAILS'}
              {t==='payments'&&<>💳 PAYMENTS {payments.length>0&&<span style={{color:'var(--acid)',marginLeft:4}}>({payments.length})</span>}</>}
              {t==='harvest'&&<>⚙ HARVEST CONFIG {harvestForm.vendor_slug&&<span style={{color:'var(--cyan)',marginLeft:4,fontSize:8}}>{harvestForm.vendor_slug}</span>}</>}
            </button>
          ))}
        </div>

        {tab==='details' && (
          <div style={{ padding:'20px 24px', display:'flex', flexDirection:'column', gap:0 }}>
            <div style={s.sectionHead}>IDENTITY</div>
            <div style={s.grid2}>
              <div style={s.fieldWrap}><label style={s.label}>NAME</label><input value={form.name} onChange={e=>set('name')(e.target.value)} placeholder="e.g. Betika" style={s.input}/></div>
              <div style={s.fieldWrap}><label style={s.label}>DOMAIN *</label><input value={form.domain} onChange={e=>set('domain')(e.target.value)} placeholder="betika.com" style={s.input}/><span style={s.hint}>Without https://</span></div>
            </div>
            <div style={s.grid2}>
              <div style={s.fieldWrap}>
                <label style={s.label}>BRAND COLOR</label>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  <input type="color" value={form.brand_color||'#888888'} onChange={e=>set('brand_color')(e.target.value)} style={{ width:36, height:32, border:'1px solid var(--border-dim)', background:'none', cursor:'pointer', padding:2 }}/>
                  <input value={form.brand_color} onChange={e=>set('brand_color')(e.target.value)} placeholder="#1a73e8" style={{ ...s.input, flex:1 }}/>
                </div>
              </div>
              <div style={s.fieldWrap}><label style={s.label}>LOGO URL</label><input value={form.logo_url} onChange={e=>set('logo_url')(e.target.value)} placeholder="https://…" style={s.input}/></div>
            </div>
            <div style={s.sectionHead}>BETTING LIMITS</div>
            <div style={s.grid3}>
              <div style={s.fieldWrap}><label style={s.label}>CURRENCY</label><input value={form.currency} onChange={e=>set('currency')(e.target.value)} placeholder="KES" style={s.input}/></div>
              <div style={s.fieldWrap}><label style={s.label}>MIN BET</label><input type="number" value={form.min_bet_amount} onChange={e=>set('min_bet_amount')(e.target.value)} placeholder="10" style={s.input}/></div>
              <div style={s.fieldWrap}><label style={s.label}>MAX BET</label><input type="number" value={form.max_bet_amount} onChange={e=>set('max_bet_amount')(e.target.value)} placeholder="500000" style={s.input}/></div>
            </div>
            <div style={s.sectionHead}>TAX / EXCISE</div>
            <div style={s.grid2}>
              <div style={s.fieldWrap}><label style={s.label}>TAX PERCENT (%)</label><input type="number" value={form.tax_percent} onChange={e=>set('tax_percent')(e.target.value)} placeholder="20" style={s.input}/></div>
              <div style={s.fieldWrap}><label style={s.label}>TAX FLAT AMOUNT</label><input type="number" value={form.tax_flat_amount} onChange={e=>set('tax_flat_amount')(e.target.value)} placeholder="50" style={s.input}/></div>
            </div>
          </div>
        )}

        {tab==='payments' && bm && (
          <div style={{ padding:'20px 24px' }}>
            <Toast msg={toast} onClear={()=>setToast('')}/>
            <PaymentsPanel bkId={bm.id} payments={payments} onUpdate={setPayments} showToast={setToast}/>
          </div>
        )}

        {tab==='harvest' && (
          <div style={{ padding:'20px 24px', display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', lineHeight:1.7,
              padding:'8px 12px', background:'rgba(56,189,248,.04)', border:'1px solid rgba(56,189,248,.15)' }}>
              ℹ Configure how the Celery workers fetch odds for this bookmaker.
              {isNew && ' You can also configure this later in the ODDS MONITOR → CONFIG tab.'}
            </div>
            <HarvestConfigSection
              form={harvestForm}
              onChange={setHarvestForm}
              bookmarkerId={bm?.id ?? null}
              showToast={(msg)=>setToast(msg)}
            />
          </div>
        )}

        <div style={mst.footer}>
          {tab!=='payments' ? (
            <>
              <button onClick={onClose} style={s.btnGhost}>CANCEL</button>
              <button onClick={handleSave} disabled={saving||!form.domain} style={{ ...s.btnPrimary, opacity:(saving||!form.domain)?.5:1 }}>
                {saving?'SAVING…':isNew?'REGISTER':'SAVE CHANGES'}
              </button>
            </>
          ) : (
            <button onClick={onClose} style={s.btnPrimary}>DONE</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Bookmaker Row ────────────────────────────────────────────────────────────

function BookmakerRow({ bm, onEdit, onDelete, onToggleActive, onClearWarn }: {
  bm:Bookmaker; onEdit:(b:Bookmaker)=>void; onDelete:(b:Bookmaker)=>void;
  onToggleActive:(b:Bookmaker)=>void; onClearWarn:(b:Bookmaker)=>void;
}) {
  const accentColor    = bm.brand_color||'var(--border-dim)';
  const activePayments = bm?.payments?.filter(p=>p.is_active)||[];
  return (
    <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-dim)',
      borderLeft:`3px solid ${bm.is_active?accentColor:'var(--border-dim)'}`, overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 16px', gap:14, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:8, flex:'0 0 auto', minWidth:140 }}>
          {bm.brand_color&&<div style={{ width:8, height:8, borderRadius:'50%', background:bm.brand_color, marginTop:4, flexShrink:0 }}/>}
          <div>
            <div style={{ fontFamily:'var(--font-display)', fontSize:15, fontWeight:700, color:'var(--text-primary)', letterSpacing:1 }}>{bm.name||bm.domain}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1, marginTop:2 }}>{bm.domain}</div>
            {bm.vendor_slug && <div style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--cyan)', letterSpacing:1, marginTop:1 }}>{bm.vendor_slug}</div>}
          </div>
          {bm.needs_ui_intervention&&(
            <button onClick={()=>onClearWarn(bm)} title="Click to dismiss" style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, flexShrink:0, color:'var(--amber)', background:'rgba(255,179,0,0.08)', border:'1px solid rgba(255,179,0,0.3)', padding:'2px 7px', cursor:'pointer' }}>⚠ TOKEN</button>
          )}
        </div>
        <div style={{ display:'flex', gap:5, flex:'1 1 auto', flexWrap:'wrap', alignItems:'center' }}>
          {activePayments.length===0
            ? <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1 }}>no payment channels</span>
            : activePayments.map(p=>{
                const tc=CHANNEL_COLOR[p.channel_type]||'var(--text-muted)';
                return (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', gap:5, background:'var(--bg-base)', border:`1px solid ${tc}22`, padding:'3px 8px' }}>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, color:tc, textTransform:'uppercase' as const }}>{p.provider}</span>
                    <span style={{ fontFamily:'var(--font-display)', fontSize:12, fontWeight:700, color:'var(--text-primary)', letterSpacing:0.5 }}>{p.number}</span>
                    {p.label&&<span style={{ fontFamily:'var(--font-mono)', fontSize:7, color:'var(--text-muted)' }}>{p.label}</span>}
                  </div>
                );
              })
          }
          {bm?.payments?.length>activePayments.length&&(
            <span style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' }}>+{bm.payments.length-activePayments.length} inactive</span>
          )}
        </div>
        {(bm.currency||bm.tax_percent)&&(
          <div style={{ display:'flex', gap:14, flexShrink:0 }}>
            {bm.currency&&<div style={{ textAlign:'center' }}><div style={{ fontFamily:'var(--font-display)', fontSize:12, fontWeight:700, color:'var(--cyan)' }}>{bm.currency}</div><div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'var(--text-muted)' }}>CCY</div></div>}
            {bm.tax_percent&&<div style={{ textAlign:'center' }}><div style={{ fontFamily:'var(--font-display)', fontSize:12, fontWeight:700, color:'var(--amber)' }}>{bm.tax_percent}%</div><div style={{ fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:2, color:'var(--text-muted)' }}>TAX</div></div>}
          </div>
        )}
        <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, marginRight:4, color:bm.is_active?'var(--green)':'var(--text-muted)' }}>{bm.is_active?'● ACTIVE':'○ INACTIVE'}</span>
          <button onClick={()=>onToggleActive(bm)} style={s.miniBtn}>{bm.is_active?'DEACTIVATE':'ACTIVATE'}</button>
          <button onClick={()=>onEdit(bm)} style={s.miniBtn}>EDIT</button>
          <button onClick={()=>onDelete(bm)} style={{ ...s.miniBtn, color:'var(--red)', borderColor:'rgba(255,61,90,0.3)' }}>DELETE</button>
        </div>
      </div>
      <div style={{ display:'flex', gap:16, padding:'5px 16px', borderTop:'1px solid var(--border-dim)',
        background:'var(--bg-base)', fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1, flexWrap:'wrap' }}>
        <span>LAST SCAN: {bm.last_discovery_at?new Date(bm.last_discovery_at).toLocaleString('en-KE',{dateStyle:'short',timeStyle:'short'}):'never'}</span>
        {(bm.min_bet_amount||bm.max_bet_amount)&&<span>BET RANGE: {bm.min_bet_amount??'?'}–{bm.max_bet_amount??'∞'}</span>}
        {bm.max_bets_per_day&&<span>MAX {bm.max_bets_per_day} BETS/DAY</span>}
        <span>{bm?.payments?.length||0} PAYMENT {bm?.payments?.length===1?'CHANNEL':'CHANNELS'}</span>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BookmakerDetailManager() {
  const [bookmakers,    setBookmakers]    = useState<Bookmaker[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState('');
  const [toast,         setToast]         = useState('');
  const [editing,       setEditing]       = useState<Bookmaker|null|'new'>(null);
  const [deleting,      setDeleting]      = useState<Bookmaker|null>(null);
  const [showBulkImport,setShowBulkImport]= useState(false);
  const showToast=(msg:string)=>setToast(msg);

  const load = useCallback(async()=>{
    setLoading(true);
    try {
      const qs  = search?`?q=${encodeURIComponent(search)}`:'';
      const res = await fetchWithAuth(`/admin/bookmakers${qs}`);
      if (res.ok) {const result = await res.json(); if(result.items)  {console.log(result); setBookmakers(result)}}
      else { showToast('✗ Failed to load')};
    } catch { showToast('✗ Network error'); }
    finally  { setLoading(false); }
  },[search]);

  useEffect(()=>{load();},[load]);

  const handleSave = async(data:Record<string,string>)=>{
    const isNew = editing==='new';
    const res = isNew
      ? await fetchWithAuth('/bookmakers/onboard',{method:'POST',body:JSON.stringify(data)})
      : await fetchWithAuth(`/bookmaker/${(editing as Bookmaker).id}`,{method:'PUT',body:JSON.stringify(data)});
    if (res.ok) { setEditing(null); showToast(isNew?'✓ Bookmaker registered':'✓ Changes saved'); load(); }
    else { const err=await res.json().catch(()=>({})); showToast(`✗ ${err.error||'Save failed'}`); }
  };

  const handleDelete=async()=>{ if(!deleting)return; const res=await fetchWithAuth(`/admin/bookmakers/${deleting.id}`,{method:'DELETE'}); if(res.ok){setBookmakers(prev=>prev.filter(b=>b.id!==deleting.id));showToast(`✓ ${deleting.name||deleting.domain} deleted`);}else showToast('✗ Delete failed'); setDeleting(null); };
  const toggleActive=async(bm:Bookmaker)=>{ const res=await fetchWithAuth(`/bookmaker/${bm.id}/activate`,{method:'POST'}); if(res.ok){const u=await res.json();setBookmakers(prev=>prev.map(b=>b.id===bm.id?{...b,is_active:u.is_active}:b));} };
  const clearWarn=async(bm:Bookmaker)=>{ const res=await fetchWithAuth(`/bookmaker/${bm.id}/clear-warn`,{method:'POST'}); if(res.ok){setBookmakers(prev=>prev.map(b=>b.id===bm.id?{...b,needs_ui_intervention:false}:b));showToast('✓ Warning cleared');} };
  const warnCount=bookmakers?.filter(b=>b.needs_ui_intervention).length;

  return (
    <div style={s.root}>
      <Toast msg={toast} onClear={()=>setToast('')}/>
      {deleting&&<Confirm msg={`Delete "${deleting.name||deleting.domain}"? Cannot be undone.`} onYes={handleDelete} onNo={()=>setDeleting(null)}/>}
      {editing!==null&&<EditModal bm={editing==='new'?null:editing} onSave={handleSave} onClose={()=>setEditing(null)}/>}
      {showBulkImport&&<BulkImportModal onClose={()=>setShowBulkImport(false)} onDone={()=>{setShowBulkImport(false);load();showToast('✓ Import complete');}}/>}

      <div style={s.header}>
        <div>
          <h1 style={s.title}>BOOKMAKERS</h1>
          <p style={s.subtitle}>{bookmakers.length} REGISTERED{warnCount>0&&<span style={{color:'var(--amber)',marginLeft:12}}>· {warnCount} ⚠ NEED ATTENTION</span>}</p>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <a href="/dashboard/endpoints" style={s.btnSecondary}>MANAGE ENDPOINTS →</a>
          <button onClick={()=>setShowBulkImport(true)} style={{ ...s.btnGhost, borderColor:'rgba(6,182,212,0.4)', color:'var(--cyan)' }}>⊕ BULK CSV IMPORT</button>
          <button onClick={()=>setEditing('new')} style={s.btnPrimary}>⊕ ADD BOOKMAKER</button>
        </div>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name or domain…" style={{ ...s.input, flex:1, maxWidth:360 }}/>
        <button onClick={load} style={s.btnGhost}>↻ REFRESH</button>
      </div>

      {loading ? (
        <div style={s.empty}><span style={{ fontFamily:'var(--font-mono)', color:'var(--acid)', letterSpacing:4 }}>LOADING…</span></div>
      ) : bookmakers.length===0 ? (
        <div style={s.empty}>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:4, color:'var(--text-muted)', marginBottom:16 }}>{search?'NO RESULTS':'NO BOOKMAKERS YET'}</div>
          {!search&&<div style={{ display:'flex', gap:8 }}>
            <button onClick={()=>setShowBulkImport(true)} style={{ ...s.btnGhost, borderColor:'rgba(6,182,212,0.4)', color:'var(--cyan)' }}>⊕ BULK CSV IMPORT</button>
            <button onClick={()=>setEditing('new')} style={s.btnPrimary}>⊕ ADD FIRST BOOKMAKER</button>
          </div>}
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {bookmakers.map(bm=><BookmakerRow key={bm.id} bm={bm} onEdit={b=>setEditing(b)} onDelete={b=>setDeleting(b)} onToggleActive={toggleActive} onClearWarn={clearWarn}/>)}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:       { display:'flex', flexDirection:'column', gap:16 },
  header:     { display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 },
  title:      { fontFamily:'var(--font-display)', fontSize:26, fontWeight:800, letterSpacing:3 },
  subtitle:   { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'var(--text-muted)', marginTop:2 },
  empty:      { display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'60px 0', gap:16 },
  sectionHead:{ display:'flex', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:3, color:'var(--acid)', marginTop:20, marginBottom:12, borderBottom:'1px solid var(--border-dim)', paddingBottom:6 },
  grid2:      { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 },
  grid3:      { display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 },
  fieldWrap:  { display:'flex', flexDirection:'column', gap:4 },
  label:      { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, color:'var(--text-muted)' },
  input:      { width:'100%', background:'var(--bg-base)', border:'1px solid var(--border-dim)', color:'var(--text-primary)', padding:'7px 12px', fontFamily:'var(--font-mono)', fontSize:11, outline:'none', boxSizing:'border-box' as const },
  hint:       { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1 },
  miniBtn:    { background:'none', border:'1px solid var(--border-dim)', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1.5, padding:'4px 10px', cursor:'pointer' },
  btnPrimary: { background:'var(--acid)', color:'#0a0a0a', border:'none', fontFamily:'var(--font-mono)', fontSize:9, fontWeight:700, letterSpacing:2, padding:'8px 16px', cursor:'pointer', whiteSpace:'nowrap' as const },
  btnSecondary:{ display:'inline-block', textDecoration:'none', background:'transparent', color:'var(--text-muted)', border:'1px solid var(--border-base)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'8px 16px', whiteSpace:'nowrap' as const },
  btnGhost:   { background:'transparent', border:'1px solid var(--border-dim)', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:1, padding:'7px 12px', cursor:'pointer' },
  btnDanger:  { background:'rgba(255,61,90,0.15)', border:'1px solid rgba(255,61,90,0.4)', color:'var(--red)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'8px 14px', cursor:'pointer' },
};

const mst: Record<string, React.CSSProperties> = {
  header:{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 24px', borderBottom:'1px solid var(--border-dim)', background:'var(--bg-elevated)' },
  title: { fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:3, color:'var(--acid)' },
  close: { background:'none', border:'none', color:'var(--text-muted)', fontSize:14, cursor:'pointer', padding:4 },
  tabs:  { display:'flex', borderBottom:'1px solid var(--border-dim)', background:'var(--bg-elevated)' },
  tab:   { background:'none', border:'none', borderBottom:'2px solid', marginBottom:-1, fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'8px 16px', cursor:'pointer' },
  footer:{ display:'flex', justifyContent:'flex-end', gap:10, padding:'14px 24px', borderTop:'1px solid var(--border-dim)', background:'var(--bg-elevated)' },
};