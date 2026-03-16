'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('http://5.78.137.59:5050/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('token', data.access_token);
        router.push('/dashboard');
      } else {
        setError('Invalid credentials');
      }
    } catch {
      setError('Connection failed — is the server running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.root}>
      {/* Grid background */}
      <div style={styles.grid} />

      {/* Glow orb */}
      <div style={styles.orb} />

      <div style={styles.card}>
        {/* Header */}
        <div style={styles.cardHeader}>
          <div style={styles.logo}>
            <span style={styles.logoBracket}>[</span>
            <span style={styles.logoText}>OT</span>
            <span style={styles.logoBracket}>]</span>
          </div>
          <h1 style={styles.title}>ODDS TERMINAL</h1>
          <p style={styles.subtitle}>ARBITRAGE INTELLIGENCE PLATFORM</p>
          <div style={styles.divider} />
        </div>

        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>EMAIL ADDRESS</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={styles.input}
              placeholder="admin@example.com"
              required
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              placeholder="••••••••••"
              required
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={loading} style={styles.btn}>
            {loading ? (
              <span style={styles.btnLoading}>AUTHENTICATING<span style={styles.dots}>...</span></span>
            ) : (
              'ACCESS TERMINAL →'
            )}
          </button>
        </form>

        <div style={styles.footer}>
          <span style={{ color: 'var(--green)', marginRight: 6 }}>●</span>
          SYSTEM OPERATIONAL · v2.0.0
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-void)',
    position: 'relative',
    overflow: 'hidden',
  },
  grid: {
    position: 'absolute', inset: 0,
    backgroundImage: `linear-gradient(var(--border-dim) 1px, transparent 1px),
                      linear-gradient(90deg, var(--border-dim) 1px, transparent 1px)`,
    backgroundSize: '40px 40px',
    opacity: 0.4,
  },
  orb: {
    position: 'absolute',
    width: 600, height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(198,241,53,0.06) 0%, transparent 70%)',
    top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
  },
  card: {
    position: 'relative',
    width: 420,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-base)',
    boxShadow: '0 0 0 1px var(--border-dim), 0 32px 64px rgba(0,0,0,0.6)',
    padding: '40px',
    animation: 'slide-up 0.4s ease',
  },
  cardHeader: { textAlign: 'center', marginBottom: 32 },
  logo: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontFamily: 'var(--font-mono)',
    fontSize: 28,
    fontWeight: 600,
    marginBottom: 12,
  },
  logoBracket: { color: 'var(--acid)', opacity: 0.7 },
  logoText: { color: 'var(--acid)', letterSpacing: 4 },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: 6,
    color: 'var(--text-primary)',
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: 4,
    color: 'var(--text-muted)',
  },
  divider: {
    width: 40, height: 2,
    background: 'var(--acid)',
    margin: '20px auto 0',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: 3,
    color: 'var(--text-muted)',
  },
  input: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-base)',
    color: 'var(--text-primary)',
    padding: '12px 14px',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  error: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--red)',
    background: 'rgba(255,61,90,0.08)',
    border: '1px solid rgba(255,61,90,0.2)',
    padding: '10px 14px',
  },
  btn: {
    background: 'var(--acid)',
    color: 'var(--bg-void)',
    border: 'none',
    padding: '14px',
    fontFamily: 'var(--font-display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 2,
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
  btnLoading: { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2 },
  dots: { animation: 'pulse-dot 1s infinite' },
  footer: {
    marginTop: 28,
    textAlign: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: 2,
    color: 'var(--text-muted)',
  },
};