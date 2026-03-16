// lib/useSocket.ts
'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'AI' | 'NET' | 'CAPTURE';
  msg: string;
  bookmaker_id?: number;
  [key: string]: unknown;
}

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://5.78.137.59:5050';

export function useAdminSocket() {
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [connected, setConnected]     = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const addLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    setLogs(prev => [...prev.slice(-500), { ...entry, id: Math.random().toString(36).slice(2) }]);
  }, []);

  useEffect(() => {
    // IMPORTANT: Use 'polling' only when Flask is in threading async_mode.
    // Werkzeug dev server cannot upgrade HTTP→WebSocket.
    // Only switch to ['websocket','polling'] with eventlet/gevent.
    socketRef.current = io(`${SOCKET_URL}/admin`, {  // ← /admin in the URL
      path: '/socket.io',
      transports: ['polling'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      forceNew: true,
      withCredentials: false,
    });

    const s = socketRef.current;

    s.on('connect', () => {
      setConnected(true);
      setSocketError(null);
      addLog({ level: 'SUCCESS', msg: `Connected to server (id: ${s.id})`, ts: new Date().toISOString() });
    });

    s.on('disconnect', (reason: string) => {
      setConnected(false);
      addLog({ level: 'WARN', msg: `Disconnected: ${reason}`, ts: new Date().toISOString() });
    });

    s.on('connect_error', (err: Error) => {
      const detail = [
        err.message || 'no message',
        (err as any).description ? `desc=${JSON.stringify((err as any).description)}` : '',
        (err as any).type ? `type=${(err as any).type}` : '',
      ].filter(Boolean).join(' | ');

      setSocketError(detail);
      addLog({ level: 'ERROR', msg: `Connection error: ${detail}`, ts: new Date().toISOString() });
      console.error('[SocketIO connect_error]', err);
    });

    s.on('agent_status',  (data: Partial<LogEntry>) => addLog({ level: 'INFO', ...data, ts: data.ts || new Date().toISOString(), id: '' } as any));
    s.on('harvest_log',   (data: Partial<LogEntry>) => addLog({ level: 'INFO', ...data, ts: data.ts || new Date().toISOString(), id: '' } as any));

    return () => { s.disconnect(); };
  }, [addLog]);

  const clearLogs = useCallback(() => setLogs([]), []);
  return { logs, connected, socketError, clearLogs };
}

