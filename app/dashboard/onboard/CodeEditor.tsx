// parser/CodeEditor.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight Python code editor:
//   • Gutter with line numbers synced to scroll
//   • Tab key → 4 spaces
//   • Enter → preserves indent, adds 4sp after colon
//   • Ctrl/Cmd+Enter → onRun()
//   • Monospace, dark background, green text

import { useRef, useEffect, useCallback, useState } from 'react';

interface CodeEditorProps {
  value:       string;
  onChange:    (v: string) => void;
  onRun?:      () => void;
  placeholder?: string;
  height?:     number | string;
  readOnly?:   boolean;
}

export function CodeEditor({
  value, onChange, onRun,
  placeholder = '# write your parse_data() function here…',
  height      = '100%',
  readOnly    = false,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef   = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(1);

  // Sync line count
  useEffect(() => {
    const n = (value.match(/\n/g) ?? []).length + 1;
    setLineCount(n);
  }, [value]);

  // Sync gutter scroll to textarea scroll
  const syncScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;

    // Ctrl/Cmd + Enter → run
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
      return;
    }

    // Tab → 4 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const next  = value.slice(0, start) + '    ' + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4;
      });
      return;
    }

    // Enter → auto-indent
    if (e.key === 'Enter') {
      e.preventDefault();
      const pos       = ta.selectionStart;
      const before    = value.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const curLine   = before.slice(lineStart);
      const indent    = curLine.match(/^(\s*)/)?.[1] ?? '';
      const extraIndent = curLine.trimEnd().endsWith(':') ? '    ' : '';
      const ins       = '\n' + indent + extraIndent;
      const next      = value.slice(0, pos) + ins + value.slice(ta.selectionEnd);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = pos + ins.length;
      });
    }
  }, [value, onChange, onRun]);

  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);

  return (
    <div style={{
      display: 'flex', height, overflow: 'hidden',
      background: '#060e06',
      border: '1px solid var(--border-dim)',
      fontFamily: 'var(--font-mono, "Fira Code", monospace)',
      fontSize: 11,
    }}>
      {/* Line number gutter */}
      <div
        ref={gutterRef}
        style={{
          width: 40, flexShrink: 0,
          overflowY: 'hidden',
          background: '#040b04',
          borderRight: '1px solid rgba(198,241,53,.08)',
          padding: '10px 0',
          userSelect: 'none',
        }}
      >
        {lines.map(n => (
          <div
            key={n}
            style={{
              height: 16.5,
              lineHeight: '16.5px',
              padding: '0 8px 0 4px',
              textAlign: 'right',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 10,
              color: 'rgba(198,241,53,.2)',
              whiteSpace: 'nowrap',
            }}
          >
            {n}
          </div>
        ))}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        style={{
          flex: 1,
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: '#a7f3d0',
          padding: '10px 12px',
          fontFamily: 'var(--font-mono, "Fira Code", monospace)',
          fontSize: 11,
          lineHeight: '16.5px',
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto',
          overflowY: 'auto',
          caretColor: '#c6f135',
          // Python keyword hints via selection colour
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(198,241,53,.15) transparent',
        }}
      />

      {/* Ctrl+Enter hint */}
      {onRun && (
        <div style={{
          position: 'absolute',
          bottom: 6, right: 10,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 7, letterSpacing: 1.5,
          color: 'rgba(198,241,53,.25)',
          pointerEvents: 'none',
        }}>
          ⌃↵ RUN
        </div>
      )}
    </div>
  );
}
