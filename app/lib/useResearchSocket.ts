'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO'|'WARN'|'ERROR'|'SUCCESS'|'AI'|'NET'|'CAPTURE';
  msg: string;
  bookmaker_id?: number;
  [key: string]: unknown;
}

export interface LoginRequest {
  session_id:    number;
  bookmaker_id:  number;
  domain:        string;
  login_url:     string;
  fields:        { name: string; type: string; placeholder?: string }[];
  otp_required:  boolean;
  phone_format?: { prefix: string; example: string };
  msg:           string;
}

export interface OtpRequest {
  session_id:   number;
  bookmaker_id: number;
  msg:          string;
}

export interface ResearchDonePayload {
  session_id:       number;
  domain:           string;
  bookmaker_name?:  string;
  sports_endpoints?: number;
  ws_streams?:       number;
  total_requests?:   number;
  msg:              string;
}

export interface DiscoveryDonePayload {
  bookmaker_id:    number;
  domain:          string;
  endpoints_found: number;
  ws_streams:      number;
  actions_taken:   number;
  msg:             string;
}

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://5.78.137.59:5050';

export function useResearchSocket() {
  const [logs,          setLogs]          = useState<LogEntry[]>([]);
  const [connected,     setConnected]     = useState(false);
  const [loginRequest,  setLoginRequest]  = useState<LoginRequest | null>(null);
  const [otpRequest,    setOtpRequest]    = useState<OtpRequest | null>(null);
  const [researchDone,  setResearchDone]  = useState<ResearchDonePayload | null>(null);
  const [discoveryDone, setDiscoveryDone] = useState<DiscoveryDonePayload | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const addLog = useCallback((e: Omit<LogEntry, 'id'>) => {
    setLogs(prev => [
      ...prev.slice(-800),
      { ...e, id: Math.random().toString(36).slice(2), ts: e.ts || new Date().toISOString() } as LogEntry,
    ]);
  }, []);

  useEffect(() => {
    socketRef.current = io(`${SOCKET_URL}/admin`, {
      transports: ['polling'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 10000,
      forceNew: true,
      withCredentials: false,
    });

    const s = socketRef.current;

    s.on('connect', () => {
      setConnected(true);
      addLog({ level: 'SUCCESS', msg: `Connected (${s.id})` });
    });

    s.on('disconnect', (reason: string) => {
      setConnected(false);
      addLog({ level: 'WARN', msg: `Disconnected: ${reason}` });
    });

    s.on('connect_error', (err: Error) => {
      addLog({ level: 'ERROR', msg: `Connection error: ${err.message}` });
    });

    // General log streams
    s.on('agent_status', (d: any) => addLog({ level: d.level || 'INFO', ...d }));
    s.on('harvest_log',  (d: any) => addLog({ level: d.level || 'INFO', ...d }));

    // Login form discovered — show credential modal
    s.on('login_required', (d: LoginRequest) => {
      setLoginRequest(d);
      addLog({ level: 'WARN', msg: `🔑 LOGIN REQUIRED for ${d.domain}` });
    });

    // OTP prompt mid-session
    s.on('otp_required', (d: OtpRequest) => {
      setOtpRequest(d);
      addLog({ level: 'WARN', msg: `📱 OTP REQUIRED — session #${d.session_id}` });
    });

    // Full research session complete (research_engine.py)
    s.on('research_complete', (d: ResearchDonePayload) => {
      setResearchDone(d);
      addLog({
        level: 'SUCCESS',
        msg: `✅ Research complete — ${d.domain} · ${d.sports_endpoints ?? '?'} endpoints · ${d.ws_streams ?? '?'} WS`,
      });
    });

    // Quick onboarding discovery complete (playwright_engine.py)
    s.on('discovery_complete', (d: DiscoveryDonePayload) => {
      setDiscoveryDone(d);
      addLog({
        level: 'SUCCESS',
        msg: `🔍 Discovery complete — ${d.domain} · ${d.endpoints_found} endpoints · ${d.actions_taken} actions`,
      });
    });

    return () => { s.disconnect(); };
  }, [addLog]);

  const submitCredentials = useCallback((session_id: number, username: string, password: string) => {
    socketRef.current?.emit('submit_credentials', { session_id, username, password });
    setLoginRequest(null);
    addLog({ level: 'INFO', msg: 'Credentials submitted — launching authenticated research...' });
  }, [addLog]);

  const submitOtp = useCallback((session_id: number, otp: string) => {
    socketRef.current?.emit('submit_otp', { session_id, otp });
    setOtpRequest(null);
    addLog({ level: 'INFO', msg: `OTP submitted for session #${session_id}` });
  }, [addLog]);

  const dismissResearchDone  = useCallback(() => { setResearchDone(null);  setDiscoveryDone(null); }, []);
  const clearLogs            = useCallback(() => setLogs([]), []);

  return {
    logs,
    connected,
    loginRequest,
    otpRequest,
    researchDone,
    discoveryDone,
    submitCredentials,
    submitOtp,
    clearLogs,
    dismissResearchDone,
  };
}