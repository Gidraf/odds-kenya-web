// parser/SplitPane.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Resizable horizontal split pane with a draggable divider.
// Renders left + right children separated by a draggable handle.

import { useRef, useState, useEffect, useCallback } from 'react';

interface SplitPaneProps {
  left:        React.ReactNode;
  right:       React.ReactNode;
  /** Initial split percentage for the LEFT panel (0–100). Default 40. */
  defaultSplit?: number;
  /** Minimum left pane width percent. Default 15. */
  minSplit?:   number;
  /** Maximum left pane width percent. Default 85. */
  maxSplit?:   number;
  /** Callback when split changes — lets parent persist the value */
  onSplitChange?: (pct: number) => void;
  /** Override from parent (controlled) */
  splitPct?: number;
  height?: number | string;
}

export function SplitPane({
  left, right,
  defaultSplit  = 40,
  minSplit      = 15,
  maxSplit      = 85,
  onSplitChange,
  splitPct: controlledSplit,
  height        = '100%',
}: SplitPaneProps) {
  const [localSplit, setLocalSplit] = useState(controlledSplit ?? defaultSplit);
  const split   = controlledSplit ?? localSplit;
  const dragging  = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const setSplit = useCallback((pct: number) => {
    const clamped = Math.min(maxSplit, Math.max(minSplit, pct));
    setLocalSplit(clamped);
    onSplitChange?.(clamped);
  }, [minSplit, maxSplit, onSplitChange]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct  = ((e.clientX - rect.left) / rect.width) * 100;
      setSplit(pct);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [setSplit]);

  return (
    <div ref={containerRef} style={{ display: 'flex', height, overflow: 'hidden', position: 'relative' }}>
      {/* Left pane */}
      <div style={{ width: `${split}%`, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {left}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 5,
          flexShrink: 0,
          cursor: 'col-resize',
          background: 'var(--border-dim)',
          position: 'relative',
          transition: 'background .15s',
          zIndex: 10,
        }}
        onMouseEnter={e  => (e.currentTarget.style.background = 'rgba(198,241,53,.5)')}
        onMouseLeave={e  => (e.currentTarget.style.background = 'var(--border-dim)')}
      >
        {/* Grip dots */}
        <div style={{
          position:  'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          display: 'flex', flexDirection: 'column', gap: 3,
          pointerEvents: 'none',
        }}>
          {[0,1,2,3,4].map(i => (
            <div key={i} style={{ width: 2, height: 2, borderRadius: '50%', background: 'rgba(198,241,53,.4)' }} />
          ))}
        </div>
      </div>

      {/* Right pane */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {right}
      </div>
    </div>
  );
}
