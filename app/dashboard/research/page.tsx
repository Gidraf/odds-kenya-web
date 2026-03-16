'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../lib/api';
import { useResearchSocket } from '../../lib/useResearchSocket';  // ← fixed typo

// ─── Types ────────────────────────────────────────────────────────────────────

interface Session {
  id: number; bookmaker_id: number; phase: string;
  started_at: string; completed_at: string | null;
  otp_required: boolean; login_success: boolean | null;
  findings_count: number; endpoints_count: number;
}

interface Finding {
  id: number; category: string; title: string;
  severity: string; phase: string; detail: string; code: string;
}

// ─── Level config ─────────────────────────────────────────────────────────────

const LC: Record<string, { color: string; bg: string; icon: string }> = {
  SUCCESS: { color:'var(--green)',  bg:'rgba(0,230,118,0.07)',  icon:'✓' },
  INFO:    { color:'var(--text-secondary)', bg:'transparent',   icon:'·' },
  WARN:    { color:'var(--amber)',  bg:'rgba(255,179,0,0.07)',   icon:'!' },
  ERROR:   { color:'var(--red)',    bg:'rgba(255,61,90,0.07)',   icon:'✗' },
  AI:      { color:'var(--cyan)',   bg:'rgba(0,212,232,0.07)',   icon:'⟁' },
  NET:     { color:'#5577ff',       bg:'rgba(85,119,255,0.05)', icon:'⇄' },
  CAPTURE: { color:'var(--acid)',   bg:'rgba(198,241,53,0.07)', icon:'◎' },
};

const PHASE_COLORS: Record<string, string> = {
  UNAUTHENTICATED: 'var(--cyan)',
  LOGIN_PENDING:   'var(--amber)',
  AUTHENTICATING:  'var(--amber)',
  AUTHENTICATED:   'var(--green)',
  COMPLETE:        'var(--acid)',
  FAILED:          'var(--red)',
};

const CATEGORY_ICONS: Record<string, string> = {
  JS_ANALYSIS:    '📜',
  JS_ENCRYPTION:  '🔐',
  WEBSOCKET:      '🔌',
  AUTH_FLOW:      '🔑',
  FORM_STRUCTURE: '📋',
  AVIATOR:        '✈️',
  GAME_ENGINE:    '🎮',
  ANTI_BOT:       '🤖',
  ODDS_ENDPOINT:  '📡',
  MATCH_LIST:     '📋',
  ODDS:           '💰',
  LIVE_SCORES:    '🟢',
  MARKETS:        '📊',
  LINEUPS:        '👥',
  RATE_LIMIT:     '⚡',
  OTHER:          '🔍',
};

// ─── Credential Modal ─────────────────────────────────────────────────────────

function CredentialModal({ req, onSubmit, onCancel }: {
  req: any;
  onSubmit: (username: string, password: string) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);

  return (
    <div style={m.overlay}>
      <div style={m.modal}>
        <div style={m.modalHeader}>
          <div style={m.modalIcon}>🔑</div>
          <div>
            <div style={m.modalTitle}>LOGIN CREDENTIALS REQUIRED</div>
            <div style={m.modalSubtitle}>{req.domain}</div>
          </div>
        </div>
        <div style={m.infoBar}>
          <span style={m.infoText}>Login URL:</span>
          <span style={{ ...m.infoVal, fontFamily:'var(--font-mono)', fontSize:10 }}>{req.login_url}</span>
        </div>
        {req.otp_required && (
          <div style={{ ...m.infoBar, background:'rgba(255,179,0,0.1)', borderColor:'rgba(255,179,0,0.3)' }}>
            <span style={{ color:'var(--amber)' }}>⚠</span>
            <span style={{ ...m.infoText, color:'var(--amber)' }}>OTP LIKELY REQUIRED — you will be prompted after login</span>
          </div>
        )}
        {req.phone_format && (
          <div style={m.infoBar}>
            <span style={m.infoText}>Phone format:</span>
            <span style={{ ...m.infoVal, color:'var(--acid)' }}>{req.phone_format?.example}</span>
          </div>
        )}
        <div style={m.fields}>
          <div style={m.field}>
            <label style={m.label}>USERNAME / PHONE / EMAIL</label>
            <input value={username} onChange={e => setUsername(e.target.value)}
              placeholder={req.phone_format?.example || 'username or phone'}
              style={m.input} autoFocus />
          </div>
          <div style={m.field}>
            <label style={m.label}>PASSWORD</label>
            <div style={{ position:'relative' }}>
              <input type={showPass ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                style={m.input}
                onKeyDown={e => e.key === 'Enter' && username && password && onSubmit(username, password)} />
              <button onClick={() => setShowPass(!showPass)} style={m.eyeBtn}>{showPass ? '🙈' : '👁'}</button>
            </div>
          </div>
        </div>
        <div style={m.warning}>⚠ Credentials are used only for this research session and are not stored in plaintext.</div>
        <div style={m.buttons}>
          <button onClick={onCancel} style={m.cancelBtn}>CANCEL</button>
          <button onClick={() => onSubmit(username, password)} disabled={!username || !password}
            style={{ ...m.submitBtn, opacity: (!username || !password) ? 0.5 : 1 }}>
            LAUNCH AUTHENTICATED RESEARCH →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── OTP Modal ────────────────────────────────────────────────────────────────

function OtpModal({ req, onSubmit, onCancel }: {
  req: any; onSubmit: (otp: string) => void; onCancel: () => void;
}) {
  const [otp, setOtp] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div style={m.overlay}>
      <div style={{ ...m.modal, maxWidth: 420 }}>
        <div style={m.modalHeader}>
          <div style={{ ...m.modalIcon, fontSize: 32 }}>📱</div>
          <div>
            <div style={m.modalTitle}>OTP REQUIRED</div>
            <div style={m.modalSubtitle}>Session #{req.session_id}</div>
          </div>
        </div>
        <p style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-secondary)', marginBottom:20 }}>{req.msg}</p>
        <div style={m.field}>
          <label style={m.label}>ONE-TIME PASSWORD</label>
          <input ref={inputRef} value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,8))}
            placeholder="123456"
            style={{ ...m.input, fontSize:24, textAlign:'center', letterSpacing:8 }}
            onKeyDown={e => e.key === 'Enter' && otp && onSubmit(otp)} />
        </div>
        <div style={m.buttons}>
          <button onClick={onCancel} style={m.cancelBtn}>SKIP</button>
          <button onClick={() => onSubmit(otp)} disabled={otp.length < 4}
            style={{ ...m.submitBtn, opacity: otp.length < 4 ? 0.5 : 1 }}>SUBMIT OTP →</button>
        </div>
      </div>
    </div>
  );
}

// ─── Report Viewer ────────────────────────────────────────────────────────────

function ReportViewer({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const [report, setReport]   = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Note: fetchWithAuth prepends /api, so this hits /api/admin/research/<id>/report
        const res = await fetchWithAuth(`/admin/research/${sessionId}/report`);
        if (res.ok) {
          const d = await res.json();
          setReport(d.report_md || '');
        } else if (res.status === 202) {
          setError('Report is still being generated. Try again in a moment.');
        } else {
          setError('Failed to load report.');
        }
      } catch {
        setError('Could not reach server.');
      }
      setLoading(false);
    })();
  }, [sessionId]);

  // Minimal markdown → JSX renderer (no deps)
  const renderMd = (md: string) => {
    let inCode = false;
    let codeLines: string[] = [];
    const out: React.ReactNode[] = [];

    md.split('\n').forEach((line, i) => {
      if (line.startsWith('```')) {
        if (inCode) {
          out.push(<pre key={i} style={rp.pre}>{codeLines.join('\n')}</pre>);
          codeLines = [];
        }
        inCode = !inCode;
        return;
      }
      if (inCode) { codeLines.push(line); return; }

      if (line.startsWith('# '))   { out.push(<h1 key={i} style={rp.h1}>{line.slice(2)}</h1>); return; }
      if (line.startsWith('## '))  { out.push(<h2 key={i} style={rp.h2}>{line.slice(3)}</h2>); return; }
      if (line.startsWith('### ')) { out.push(<h3 key={i} style={rp.h3}>{line.slice(4)}</h3>); return; }
      if (line.startsWith('| '))   { out.push(<div key={i} style={rp.tableRow}><code style={rp.code}>{line}</code></div>); return; }
      if (line.startsWith('- '))   { out.push(<div key={i} style={rp.li}>• {line.slice(2)}</div>); return; }
      if (line.startsWith('**') && line.endsWith('**')) {
        out.push(<p key={i} style={{ ...rp.p, fontWeight:600, color:'var(--text-primary)' }}>{line.replace(/\*\*/g,'')}</p>);
        return;
      }
      if (line.trim() === '')      { out.push(<div key={i} style={{ height:8 }} />); return; }
      out.push(<p key={i} style={rp.p}>{line}</p>);
    });
    return out;
  };

  return (
    <div style={rp.overlay}>
      <div style={rp.panel}>
        <div style={rp.header}>
          <span style={rp.headerTitle}>📄 RESEARCH REPORT · SESSION #{sessionId}</span>
          <div style={{ display:'flex', gap:8 }}>
            {report && (
              <button onClick={() => {
                const blob = new Blob([report], { type:'text/markdown' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `research-${sessionId}.md`;
                a.click();
              }} style={rp.downloadBtn}>⬇ DOWNLOAD .MD</button>
            )}
            <button onClick={onClose} style={rp.closeBtn}>✕ CLOSE</button>
          </div>
        </div>
        <div style={rp.body}>
          {loading  && <div style={rp.center}>Loading report...</div>}
          {error    && <div style={{ ...rp.center, color:'var(--red)' }}>{error}</div>}
          {!loading && !error && report && <div style={rp.content}>{renderMd(report)}</div>}
          {!loading && !error && !report && <div style={rp.center}>Report is empty.</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ResearchPage() {
  const {
    logs, connected, loginRequest, otpRequest, researchDone,
    submitCredentials, submitOtp, clearLogs, dismissResearchDone,
    discoveryDone,   // ← new: fires when playwright_engine finishes onboarding
  } = useResearchSocket();

  const [domain,        setDomain]        = useState('');
  const [sessions,      setSessions]      = useState<Session[]>([]);
  const [selected,      setSelected]      = useState<number | null>(null);
  const [findings,      setFindings]      = useState<Finding[]>([]);
  const [sessionDetail, setSessionDetail] = useState<any>(null);
  const [showReport,    setShowReport]    = useState<number | null>(null);
  const [launching,     setLaunching]     = useState(false);
  const [tab,           setTab]           = useState<'logs'|'findings'|'endpoints'>('logs');
  const [filterLevel,   setFilterLevel]   = useState('ALL');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }); }, [logs]);

  const loadSessions = useCallback(async () => {
    const res = await fetchWithAuth('/admin/research/sessions');
    if (res.ok) setSessions(await res.json());
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Reload session list whenever research OR discovery completes
  useEffect(() => { if (researchDone || discoveryDone) loadSessions(); }, [researchDone, discoveryDone, loadSessions]);

  const loadSession = async (id: number) => {
    setSelected(id);
    setTab('findings');
    const res = await fetchWithAuth(`/admin/research/${id}`);
    if (res.ok) {
      const d = await res.json();
      setSessionDetail(d);
      setFindings(d.findings || []);
    }
  };

  const startResearch = async () => {
    if (!domain.trim()) return;
    setLaunching(true);
    const res = await fetchWithAuth('/admin/research/start', {
      method: 'POST',
      body: JSON.stringify({ domain: domain.trim() }),
    });
    if (res.ok) { setDomain(''); await loadSessions(); setTab('logs'); }
    setLaunching(false);
  };

  const visibleLogs  = filterLevel === 'ALL' ? logs : logs.filter(l => l.level === filterLevel);
  const levelCounts  = logs.reduce((acc, l) => { acc[l.level] = (acc[l.level]||0)+1; return acc; }, {} as Record<string,number>);

  return (
    <div style={s.root}>
      {/* ── Modals ── */}
      {loginRequest && (
        <CredentialModal req={loginRequest}
          onSubmit={(u,p) => submitCredentials(loginRequest.session_id, u, p)}
          onCancel={() => {}} />
      )}
      {otpRequest && (
        <OtpModal req={otpRequest}
          onSubmit={otp => submitOtp(otpRequest.session_id, otp)}
          onCancel={() => {}} />
      )}
      {showReport !== null && (
        <ReportViewer sessionId={showReport} onClose={() => setShowReport(null)} />
      )}

      {/* ── Completion banners ── */}
      {researchDone && (
        <div style={s.completeBanner}>
          <span>✅ Research complete — <strong>{researchDone.domain}</strong>
            {researchDone.sports_endpoints !== undefined &&
              ` · ${researchDone.sports_endpoints} sports endpoints · ${researchDone.ws_streams} WS streams`}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => { setShowReport(researchDone.session_id); dismissResearchDone(); }} style={s.bannerBtn}>
              📄 VIEW REPORT
            </button>
            <button onClick={dismissResearchDone} style={s.bannerClose}>✕</button>
          </div>
        </div>
      )}
      {discoveryDone && (
        <div style={{ ...s.completeBanner, borderColor:'rgba(0,212,232,0.3)', background:'rgba(0,212,232,0.07)' }}>
          <span style={{ color:'var(--cyan)' }}>
            🔍 Discovery complete — <strong>{discoveryDone.domain}</strong>
            {` · ${discoveryDone.endpoints_found} endpoints · ${discoveryDone.actions_taken} actions`}
          </span>
          <button onClick={() => dismissResearchDone()} style={{ ...s.bannerClose }}>✕</button>
        </div>
      )}

      {/* ── Header ── */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>RESEARCH LAB</h1>
          <p style={s.subtitle}>AUTONOMOUS BOOKMAKER INTELLIGENCE · AI-DRIVEN DEEP RESEARCH</p>
        </div>
        <div style={{ ...s.connBadge, borderColor: connected ? 'rgba(0,230,118,0.3)' : 'rgba(255,61,90,0.3)' }}>
          <span style={{ ...s.connDot, background: connected ? 'var(--green)' : 'var(--red)' }} />
          <span style={{ color: connected ? 'var(--green)' : 'var(--red)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2 }}>
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* ── Launch bar ── */}
      <div style={s.launchBar}>
        <div style={s.launchLabel}>TARGET DOMAIN</div>
        <div style={s.launchRow}>
          <input value={domain} onChange={e => setDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && startResearch()}
            placeholder="sportpesa.co.ke" style={s.launchInput} disabled={launching} />
          <button onClick={startResearch} disabled={!domain.trim() || launching} style={s.launchBtn}>
            {launching ? '⠿ DISPATCHING...' : '🔬 START RESEARCH →'}
          </button>
        </div>
        <div style={s.phaseHints}>
          {[
            '01  AI navigates all pages autonomously',
            '02  Every click observed 5s for network traffic',
            '03  Login found → credential popup appears',
            '04  Full MD report generated on completion',
          ].map((h,i) => <span key={i} style={s.phaseHint}>{h}</span>)}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={s.body}>
        {/* Sessions sidebar */}
        <div style={s.sessionList}>
          <div style={s.sectionHeader}>SESSIONS · {sessions.length}</div>
          {sessions.length === 0 && (
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', padding:'12px 4px' }}>
              No sessions yet. Enter a domain above.
            </div>
          )}
          {sessions.map(sess => (
            <div key={sess.id} onClick={() => loadSession(sess.id)}
              style={{ ...s.sessionCard, ...(selected===sess.id ? s.sessionCardActive : {}) }}>
              <div style={s.sessionTop}>
                <span style={s.sessionId}>#{sess.id}</span>
                <span style={{ ...s.phaseBadge,
                  color: PHASE_COLORS[sess.phase] || 'var(--text-muted)',
                  borderColor: PHASE_COLORS[sess.phase] || 'var(--border-dim)' }}>
                  {sess.phase}
                </span>
              </div>
              <div style={s.sessionMeta}>
                <span>{sess.findings_count} findings</span>
                <span>{sess.endpoints_count} endpoints</span>
              </div>
              {sess.phase === 'COMPLETE' && (
                <button onClick={e => { e.stopPropagation(); setShowReport(sess.id); }} style={s.reportBtn}>
                  📄 VIEW REPORT
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Detail panel */}
        <div style={s.detail}>
          <div style={s.tabs}>
            {(['logs','findings','endpoints'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ ...s.tab, ...(tab===t ? s.tabActive:{}) }}>
                {t.toUpperCase()}
                {t==='logs'      && <span style={s.tabCount}>{logs.length}</span>}
                {t==='findings'  && selected && <span style={s.tabCount}>{findings.length}</span>}
                {t==='endpoints' && sessionDetail && <span style={s.tabCount}>{sessionDetail.research_endpoints?.length||0}</span>}
              </button>
            ))}
          </div>

          {/* LOGS */}
          {tab==='logs' && (
            <div style={s.termWrap}>
              <div style={s.levelFilters}>
                {['ALL','SUCCESS','AI','CAPTURE','NET','WARN','ERROR'].map(lvl => {
                  const cfg = LC[lvl] || {};
                  const cnt = lvl==='ALL' ? logs.length : (levelCounts[lvl]||0);
                  return (
                    <button key={lvl} onClick={() => setFilterLevel(lvl)} style={{
                      ...s.filterBtn,
                      color: filterLevel===lvl ? ((cfg as any).color||'var(--acid)') : 'var(--text-muted)',
                      borderBottomColor: filterLevel===lvl ? ((cfg as any).color||'var(--acid)') : 'transparent',
                    }}>
                      {lvl}{cnt>0 && <span style={s.filterCnt}>{cnt}</span>}
                    </button>
                  );
                })}
                <button onClick={clearLogs} style={s.clearBtn}>✕ CLEAR</button>
              </div>
              <div style={s.terminal}>
                <div style={s.termBar}>
                  <div style={s.termDots}>{['#ff5f57','#ffbd2e','#28ca41'].map(c=><div key={c} style={{...s.termDot,background:c}}/>)}</div>
                  <span style={s.termTitle}>RESEARCH_AGENT :: LIVE_STREAM</span>
                  <span style={s.termCount}>{visibleLogs.length} lines</span>
                </div>
                <div style={s.termBody}>
                  {visibleLogs.length===0
                    ? <div style={s.termEmpty}>
                        <div style={{fontFamily:'var(--font-mono)',fontSize:24,color:'var(--acid)'}}>█</div>
                        <div style={{fontFamily:'var(--font-mono)',fontSize:10,letterSpacing:4,color:'var(--text-muted)',marginTop:12}}>
                          {connected ? 'WAITING FOR RESEARCH ACTIVITY...' : 'NOT CONNECTED'}
                        </div>
                      </div>
                    : visibleLogs.map(log => {
                        const cfg = LC[log.level]||LC.INFO;
                        const t = new Date(log.ts).toLocaleTimeString('en-KE',{hour12:false});
                        return (
                          <div key={log.id} style={{...s.logRow, background:cfg.bg, borderLeft:`2px solid ${cfg.color}`}}>
                            <span style={{color:cfg.color,width:10,flexShrink:0,textAlign:'center',fontWeight:700}}>{cfg.icon}</span>
                            <span style={{color:'var(--text-muted)',fontSize:9,width:70,flexShrink:0}}>{t}</span>
                            <span style={{color:cfg.color,fontSize:9,letterSpacing:1,width:58,flexShrink:0,fontWeight:600}}>{log.level}</span>
                            <span style={{flex:1,fontSize:11,color:log.level==='ERROR'?'var(--red)':'var(--text-primary)',lineHeight:1.5}}>{log.msg}</span>
                          </div>
                        );
                      })
                  }
                  <div ref={endRef}/>
                </div>
              </div>
            </div>
          )}

          {/* FINDINGS */}
          {tab==='findings' && (
            <div style={s.findingsWrap}>
              {!selected
                ? <div style={s.emptyDetail}>← SELECT A SESSION</div>
                : findings.length===0
                  ? <div style={s.emptyDetail}>NO FINDINGS YET</div>
                  : findings.map(f => (
                      <div key={f.id} style={{...s.findingCard,
                        borderColor: f.severity==='CRITICAL'?'rgba(255,61,90,0.4)':f.severity==='WARN'?'rgba(255,179,0,0.3)':'var(--border-dim)'}}>
                        <div style={s.findingTop}>
                          <div style={s.findingMeta}>
                            <span style={s.findingIcon}>{CATEGORY_ICONS[f.category]||'🔍'}</span>
                            <span style={{...s.findingCat, color:f.severity==='CRITICAL'?'var(--red)':f.severity==='WARN'?'var(--amber)':'var(--cyan)'}}>
                              {f.category}
                            </span>
                            <span style={s.findingPhase}>[{f.phase}]</span>
                          </div>
                          <span style={{...s.findingSev, color:f.severity==='CRITICAL'?'var(--red)':f.severity==='WARN'?'var(--amber)':'var(--text-muted)'}}>
                            {f.severity}
                          </span>
                        </div>
                        <div style={s.findingTitle}>{f.title}</div>
                        {f.detail && (
                          <details style={{marginTop:8}}>
                            <summary style={s.findingDetailSum}>Show detail</summary>
                            <pre style={s.findingPre}>{f.detail}</pre>
                          </details>
                        )}
                        {f.code && <pre style={s.findingCode}>{f.code.slice(0,600)}</pre>}
                      </div>
                    ))
              }
            </div>
          )}

          {/* ENDPOINTS */}
          {tab==='endpoints' && (
            <div style={s.endpointsWrap}>
              {!sessionDetail
                ? <div style={s.emptyDetail}>← SELECT A SESSION</div>
                : <>
                    {sessionDetail.production_endpoints?.length > 0 && <>
                      <div style={s.epSectionHeader}>✅ PRODUCTION ENDPOINTS (active in harvest)</div>
                      <div style={s.epTable}>
                        {sessionDetail.production_endpoints.map((ep:any,i:number) => (
                          <div key={i} style={s.epRow}>
                            <span style={{...s.epType, color:ep.type==='LIVE_SCORES'?'var(--green)':ep.type==='ODDS'?'var(--acid)':'var(--cyan)'}}>
                              {ep.type}
                            </span>
                            <code style={s.epUrl}>{ep.url_pattern}</code>
                            <div style={s.epBadges}>
                              <span style={{color:ep.parser_ok?'var(--green)':'var(--red)',fontFamily:'var(--font-mono)',fontSize:9}}>
                                {ep.parser_ok?'✓ PARSER':'✗ PARSER'}
                              </span>
                              <span style={{color:ep.active?'var(--green)':'var(--text-muted)',fontFamily:'var(--font-mono)',fontSize:9}}>
                                {ep.active?'● ACTIVE':'○ INACTIVE'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>}
                    <div style={s.epSectionHeader}>ALL OBSERVED REQUESTS · {sessionDetail.research_endpoints?.length}</div>
                    <div style={s.epTable}>
                      {(sessionDetail.research_endpoints||[]).map((ep:any,i:number) => (
                        <div key={i} style={{...s.epRow, opacity:ep.status>=400?0.5:1}}>
                          <span style={{...s.epMethod, background:ep.auth_required?'rgba(255,61,90,0.15)':'var(--bg-elevated)'}}>
                            {ep.method}
                          </span>
                          <span style={{...s.epStatus, color:ep.status<300?'var(--green)':ep.status<400?'var(--amber)':'var(--red)'}}>
                            {ep.status||'?'}
                          </span>
                          <code style={s.epUrl}>{ep.url?.slice(0,80)}</code>
                          <div style={s.epBadges}>
                            {ep.auth_required && <span style={{color:'var(--red)',fontFamily:'var(--font-mono)',fontSize:8}}>🔒AUTH</span>}
                            {ep.type && <span style={{color:'var(--cyan)',fontFamily:'var(--font-mono)',fontSize:8}}>{ep.type}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:          { display:'flex', flexDirection:'column', height:'calc(100vh - 92px)', overflow:'hidden' },
  header:        { display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16, flexShrink:0 },
  title:         { fontFamily:'var(--font-display)', fontSize:28, fontWeight:800, letterSpacing:3 },
  subtitle:      { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'var(--text-muted)', marginTop:2 },
  connBadge:     { display:'flex', alignItems:'center', gap:6, padding:'4px 10px', border:'1px solid' },
  connDot:       { width:5, height:5, borderRadius:'50%' },
  launchBar:     { background:'var(--bg-surface)', border:'1px solid var(--border-dim)', padding:'14px 20px', marginBottom:16, flexShrink:0 },
  launchLabel:   { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:3, color:'var(--text-muted)', marginBottom:8 },
  launchRow:     { display:'flex', gap:8, marginBottom:10 },
  launchInput:   { flex:1, background:'var(--bg-base)', border:'1px solid var(--border-base)', color:'var(--text-primary)', padding:'10px 14px', fontFamily:'var(--font-mono)', fontSize:13, outline:'none' },
  launchBtn:     { background:'var(--acid)', color:'var(--bg-void)', border:'none', padding:'10px 24px', fontFamily:'var(--font-display)', fontSize:13, fontWeight:700, letterSpacing:2, cursor:'pointer', whiteSpace:'nowrap' },
  phaseHints:    { display:'flex', gap:20, flexWrap:'wrap' },
  phaseHint:     { fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', letterSpacing:1 },
  body:          { display:'grid', gridTemplateColumns:'200px 1fr', gap:12, flex:1, minHeight:0 },
  sessionList:   { display:'flex', flexDirection:'column', gap:6, overflow:'auto' },
  sectionHeader: { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:3, color:'var(--text-muted)', padding:'4px 0', borderBottom:'1px solid var(--border-dim)', marginBottom:4 },
  sessionCard:   { background:'var(--bg-surface)', border:'1px solid var(--border-dim)', padding:'10px 12px', cursor:'pointer', transition:'all 0.15s' },
  sessionCardActive: { borderColor:'var(--acid)', background:'var(--bg-elevated)' },
  sessionTop:    { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 },
  sessionId:     { fontFamily:'var(--font-mono)', fontSize:11, fontWeight:600, color:'var(--acid)' },
  phaseBadge:    { fontFamily:'var(--font-mono)', fontSize:7, letterSpacing:1, border:'1px solid', padding:'1px 5px' },
  sessionMeta:   { display:'flex', gap:8, fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', marginBottom:4 },
  reportBtn:     { width:'100%', padding:'4px', background:'rgba(198,241,53,0.1)', border:'1px solid rgba(198,241,53,0.3)', color:'var(--acid)', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, cursor:'pointer' },
  detail:        { display:'flex', flexDirection:'column', border:'1px solid var(--border-dim)', minHeight:0 },
  tabs:          { display:'flex', borderBottom:'1px solid var(--border-dim)', flexShrink:0, background:'var(--bg-base)' },
  tab:           { background:'none', border:'none', borderBottom:'2px solid transparent', marginBottom:-1, color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'8px 16px', cursor:'pointer', display:'flex', alignItems:'center', gap:6 },
  tabActive:     { color:'var(--acid)', borderBottomColor:'var(--acid)' },
  tabCount:      { background:'var(--bg-elevated)', color:'var(--text-muted)', borderRadius:2, padding:'1px 5px', fontFamily:'var(--font-mono)', fontSize:7 },
  termWrap:      { flex:1, display:'flex', flexDirection:'column', minHeight:0 },
  levelFilters:  { display:'flex', gap:0, padding:'0 8px', borderBottom:'1px solid var(--border-dim)', flexShrink:0, alignItems:'center' },
  filterBtn:     { background:'none', border:'none', borderBottom:'2px solid', marginBottom:-1, fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, padding:'5px 10px', cursor:'pointer', display:'flex', alignItems:'center', gap:4 },
  filterCnt:     { background:'var(--bg-elevated)', padding:'0 4px', borderRadius:2, fontSize:7 },
  clearBtn:      { marginLeft:'auto', background:'none', border:'none', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2, cursor:'pointer', padding:'5px 8px' },
  terminal:      { flex:1, display:'flex', flexDirection:'column', minHeight:0 },
  termBar:       { background:'var(--bg-elevated)', padding:'6px 12px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid var(--border-dim)', flexShrink:0 },
  termDots:      { display:'flex', gap:4 },
  termDot:       { width:9, height:9, borderRadius:'50%' },
  termTitle:     { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:2, flex:1, textAlign:'center' },
  termCount:     { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' },
  termBody:      { flex:1, overflow:'auto', padding:'6px 0', background:'var(--bg-base)' },
  termEmpty:     { display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'60%' },
  logRow:        { display:'flex', alignItems:'baseline', gap:8, padding:'3px 12px 3px 8px', fontFamily:'var(--font-mono)', fontSize:11, borderBottom:'1px solid rgba(255,255,255,0.02)' },
  findingsWrap:  { flex:1, overflow:'auto', padding:10 },
  emptyDetail:   { display:'flex', alignItems:'center', justifyContent:'center', height:'60%', fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:4, color:'var(--text-muted)' },
  findingCard:   { border:'1px solid', padding:'12px', marginBottom:8 },
  findingTop:    { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 },
  findingMeta:   { display:'flex', alignItems:'center', gap:8 },
  findingIcon:   { fontSize:14 },
  findingCat:    { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, fontWeight:600 },
  findingPhase:  { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)' },
  findingSev:    { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:2 },
  findingTitle:  { fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-primary)' },
  findingDetailSum: { fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', cursor:'pointer', letterSpacing:1, marginTop:6 },
  findingPre:    { background:'var(--bg-base)', padding:'10px', marginTop:6, fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-secondary)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' },
  findingCode:   { background:'rgba(198,241,53,0.05)', border:'1px solid rgba(198,241,53,0.15)', padding:'8px', marginTop:6, fontFamily:'var(--font-mono)', fontSize:9, color:'var(--acid)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' },
  endpointsWrap: { flex:1, overflow:'auto', padding:10 },
  epSectionHeader: { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:3, color:'var(--text-muted)', padding:'8px 0 6px', borderBottom:'1px solid var(--border-dim)', marginBottom:6 },
  epTable:       { display:'flex', flexDirection:'column', gap:3, marginBottom:20 },
  epRow:         { display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--bg-surface)', border:'1px solid var(--border-dim)' },
  epType:        { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:1, fontWeight:600, flexShrink:0, width:100 },
  epMethod:      { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:1, padding:'1px 5px', flexShrink:0 },
  epStatus:      { fontFamily:'var(--font-mono)', fontSize:9, fontWeight:600, flexShrink:0, width:30 },
  epUrl:         { flex:1, fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  epBadges:      { display:'flex', gap:6, flexShrink:0 },
  completeBanner: { display:'flex', justifyContent:'space-between', alignItems:'center', background:'rgba(198,241,53,0.1)', border:'1px solid rgba(198,241,53,0.3)', padding:'10px 16px', marginBottom:12, flexShrink:0 },
  bannerBtn:     { background:'var(--acid)', color:'var(--bg-void)', border:'none', fontFamily:'var(--font-display)', fontSize:11, fontWeight:700, letterSpacing:2, padding:'5px 14px', cursor:'pointer' },
  bannerClose:   { background:'none', border:'none', color:'var(--text-muted)', fontSize:14, cursor:'pointer' },
};

const m: Record<string, React.CSSProperties> = {
  overlay:      { position:'fixed', inset:0, background:'rgba(7,8,10,0.85)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, backdropFilter:'blur(4px)' },
  modal:        { background:'var(--bg-surface)', border:'1px solid var(--border-bright)', width:'100%', maxWidth:520, padding:32, boxShadow:'0 32px 80px rgba(0,0,0,0.8)' },
  modalHeader:  { display:'flex', alignItems:'center', gap:16, marginBottom:20 },
  modalIcon:    { fontSize:40 },
  modalTitle:   { fontFamily:'var(--font-display)', fontSize:18, fontWeight:800, letterSpacing:3, color:'var(--text-primary)' },
  modalSubtitle:{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--acid)', letterSpacing:2, marginTop:2 },
  infoBar:      { display:'flex', alignItems:'center', gap:10, background:'var(--bg-base)', border:'1px solid var(--border-dim)', padding:'8px 12px', marginBottom:8 },
  infoText:     { fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, color:'var(--text-muted)', flexShrink:0 },
  infoVal:      { fontFamily:'var(--font-body)', fontSize:11, color:'var(--text-secondary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  fields:       { display:'flex', flexDirection:'column', gap:14, margin:'20px 0' },
  field:        { display:'flex', flexDirection:'column', gap:5 },
  label:        { fontFamily:'var(--font-mono)', fontSize:8, letterSpacing:3, color:'var(--text-muted)' },
  input:        { background:'var(--bg-base)', border:'1px solid var(--border-bright)', color:'var(--text-primary)', padding:'12px 14px', fontFamily:'var(--font-mono)', fontSize:13, outline:'none', width:'100%' },
  eyeBtn:       { position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', fontSize:14 },
  warning:      { fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-muted)', letterSpacing:1, background:'var(--bg-base)', padding:'8px 12px', marginBottom:20, lineHeight:1.6 },
  buttons:      { display:'flex', gap:10 },
  cancelBtn:    { flex:1, padding:'10px', background:'transparent', border:'1px solid var(--border-base)', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:2, cursor:'pointer' },
  submitBtn:    { flex:2, padding:'12px', background:'var(--acid)', color:'var(--bg-void)', border:'none', fontFamily:'var(--font-display)', fontSize:13, fontWeight:700, letterSpacing:2, cursor:'pointer' },
};

const rp: Record<string, React.CSSProperties> = {
  overlay:     { position:'fixed', inset:0, background:'rgba(7,8,10,0.92)', zIndex:999, display:'flex', flexDirection:'column' },
  panel:       { display:'flex', flexDirection:'column', height:'100%', background:'var(--bg-base)' },
  header:      { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 20px', borderBottom:'1px solid var(--border-dim)', background:'var(--bg-surface)', flexShrink:0 },
  headerTitle: { fontFamily:'var(--font-display)', fontSize:16, fontWeight:700, letterSpacing:3 },
  downloadBtn: { background:'var(--acid)', color:'var(--bg-void)', border:'none', fontFamily:'var(--font-mono)', fontSize:9, letterSpacing:2, padding:'6px 14px', cursor:'pointer' },
  closeBtn:    { background:'none', border:'1px solid var(--border-base)', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:12, padding:'5px 10px', cursor:'pointer' },
  body:        { flex:1, overflow:'auto', padding:'32px 48px' },
  center:      { textAlign:'center', padding:60, fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)', letterSpacing:3 },
  content:     { maxWidth:860, margin:'0 auto' },
  h1:          { fontFamily:'var(--font-display)', fontSize:28, fontWeight:800, color:'var(--acid)', letterSpacing:2, margin:'24px 0 12px' },
  h2:          { fontFamily:'var(--font-display)', fontSize:20, fontWeight:700, color:'var(--text-primary)', letterSpacing:2, margin:'20px 0 8px', borderBottom:'1px solid var(--border-dim)', paddingBottom:6 },
  h3:          { fontFamily:'var(--font-display)', fontSize:16, fontWeight:600, color:'var(--cyan)', letterSpacing:1, margin:'16px 0 6px' },
  p:           { fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, margin:'4px 0' },
  li:          { fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, paddingLeft:12, margin:'2px 0' },
  code:        { fontFamily:'var(--font-mono)', fontSize:10, color:'var(--acid)', display:'block', padding:'2px 0' },
  pre:         { background:'var(--bg-surface)', border:'1px solid var(--border-dim)', padding:'14px', margin:'8px 0', fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-secondary)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all', lineHeight:1.5 },
  tableRow:    { fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-muted)', padding:'2px 0', overflowX:'auto', whiteSpace:'nowrap', display:'block' },
};