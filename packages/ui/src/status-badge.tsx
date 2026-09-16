import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'queued';

const ICON: Record<StatusTone, string> = {
  ok: '✓',
  warn: '!',
  error: '×',
  info: 'i',
  queued: '…',
};

export interface StatusBadgeProps {
  tone: StatusTone;
  children: ReactNode;
  /** Screen-reader label when the visible text is terse. */
  label?: string;
}

/** Status is conveyed by icon + text, never colour alone (WCAG 1.4.1). */
export function StatusBadge({ tone, children, label }: StatusBadgeProps) {
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--pc-space-1)',
        padding: '2px var(--pc-space-2)',
        borderRadius: 'var(--pc-radius-sm)',
        border: '1px solid var(--pc-color-border)',
        color: `var(--pc-color-status-${tone})`,
        font: '500 12px/1.4 var(--pc-font-sans)',
      }}
    >
      <span aria-hidden="true">{ICON[tone]}</span>
      {children}
    </span>
  );
}
