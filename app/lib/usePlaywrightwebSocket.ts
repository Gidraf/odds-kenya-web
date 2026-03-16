'use client';
// lib/usePlaywrightSocket.ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://5.78.137.59:5050';

export interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG' | 'CAPTURE';
  msg: string;
  session_id?: string;
  [key: string]: unknown;
}

// ── Event payloads ────────────────────────────────────────────────────────────

export interface BrowserReadyPayload {
  session_id: string; url: string; title: string;
  phases: string[]; phase_guide: Record<string, any>;
}

export interface PageNavigatedPayload {
  session_id: string; url: string; title: string;
}

export interface RequestCapturedPayload {
  session_id: string; phase: string; url: string; method: string;
  status: number; score: number; body_size: number;
  body_preview: string; params: Record<string, string>;
  params_extracted: Record<string, string>;
}

export interface PhasePromptPayload {
  session_id: string; phase: string; phase_index: number;
  total_phases: number; name: string; message: string;
  hint: string; icon: string; capture_count: number;
}

export interface StepConfirmedPayload {
  session_id: string; phase: string; url_template: string;
  placeholder_map: Record<string, string>;
  partner_config: Record<string, string>;
  sample_count: number; array_path: string;
}

export interface SessionCompletePayload {
  session_id: string; bookmaker_id: number;
  vendor_slug: string | null;
  partner_config: Record<string, string>;
  phases: Record<string, any>;
}

export interface SessionErrorPayload {
  session_id?: string; error: string;
}

export interface PlaywrightSocketCallbacks {
  onBrowserReady?:     (d: BrowserReadyPayload)     => void;
  onPageNavigated?:    (d: PageNavigatedPayload)     => void;
  onRequestCaptured?:  (d: RequestCapturedPayload)   => void;
  onPhasePrompt?:      (d: PhasePromptPayload)       => void;
  onStepConfirmed?:    (d: StepConfirmedPayload)     => void;
  onSessionComplete?:  (d: SessionCompletePayload)   => void;
  onSessionError?:     (d: SessionErrorPayload)      => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePlaywrightSocket(
  sessionId: string | null,
  callbacks: PlaywrightSocketCallbacks,
) {
  const [connected,   setConnected]   = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [logs,        setLogs]        = useState<LogEntry[]>([]);

  const socketRef   = useRef<Socket | null>(null);
  const callbackRef = useRef(callbacks);
  useEffect(() => { callbackRef.current = callbacks; }, [callbacks]);

  const addLog = useCallback((level: LogEntry['level'], msg: string, sid?: string) => {
    setLogs(prev => [
      ...prev.slice(-500),
      { id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), level, msg, session_id: sid },
    ]);
  }, []);

  useEffect(() => {
    const socket = io(`${SOCKET_URL}/playwright`, {
      path: '/socket.io',
      transports: ['polling'],          // matches Flask threading async_mode
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 10_000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
      forceNew: true,
      withCredentials: false,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setSocketError(null);
      addLog('SUCCESS', `Connected to /playwright (id: ${socket.id})`);
    });

    socket.on('disconnect', (reason: string) => {
      setConnected(false);
      addLog('WARN', `Disconnected: ${reason}`);
    });

    socket.on('connect_error', (err: Error) => {
      const detail = [
        err.message || 'no message',
        (err as any).description ? `desc=${JSON.stringify((err as any).description)}` : '',
        (err as any).type       ? `type=${(err as any).type}` : '',
      ].filter(Boolean).join(' | ');
      setSocketError(detail);
      addLog('ERROR', `Connection error: ${detail}`);
    });

    // ── Playwright events ────────────────────────────────────────────────────

    socket.on('browser_ready', (d: BrowserReadyPayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog('SUCCESS', `Browser ready: ${d.title}`, d.session_id);
      callbackRef.current.onBrowserReady?.(d);
    });

    socket.on('page_navigated', (d: PageNavigatedPayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      callbackRef.current.onPageNavigated?.(d);
    });

    socket.on('request_captured', (d: RequestCapturedPayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog('CAPTURE', `[${d.phase.toUpperCase()}] ${d.method} ${d.url.slice(0, 80)} (score:${d.score})`, d.session_id);
      callbackRef.current.onRequestCaptured?.(d);
    });

    socket.on('phase_prompt', (d: PhasePromptPayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog('INFO', `${d.icon} ${d.name}: ${d.message}`, d.session_id);
      callbackRef.current.onPhasePrompt?.(d);
    });

    socket.on('step_confirmed', (d: StepConfirmedPayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog('SUCCESS', `✓ Phase "${d.phase}" confirmed — ${d.sample_count} samples`, d.session_id);
      callbackRef.current.onStepConfirmed?.(d);
    });

    socket.on('session_complete', (d: SessionCompletePayload) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog('SUCCESS', `✓ Session complete — vendor: ${d.vendor_slug ?? 'unknown'}`, d.session_id);
      callbackRef.current.onSessionComplete?.(d);
    });

    socket.on('session_error', (d: SessionErrorPayload) => {
      if (sessionId && d.session_id && d.session_id !== sessionId) return;
      addLog('ERROR', d.error, d.session_id);
      callbackRef.current.onSessionError?.(d);
    });

    socket.on('log', (d: { session_id: string; level: string; msg: string }) => {
      if (sessionId && d.session_id !== sessionId) return;
      addLog((d.level as LogEntry['level']) || 'INFO', d.msg, d.session_id);
    });

    return () => { socket.disconnect(); };
  // Re-connect only if sessionId reference changes — callbacks are stable via ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { connected, socketError, logs, clearLogs };
}