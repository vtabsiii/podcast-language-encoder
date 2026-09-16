'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Footer actions, typically buttons. */
  actions?: ReactNode;
}

/** Modal built on the native <dialog>, so focus trapping, Escape and inertness come for free. */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `pc-dialog-${title.replace(/\W+/g, '-').toLowerCase()}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{
        border: '1px solid var(--pc-color-border)',
        borderRadius: 'var(--pc-radius-lg)',
        padding: 'var(--pc-space-6)',
        maxWidth: 'min(90vw, 560px)',
        background: 'var(--pc-color-surface)',
        color: 'var(--pc-color-text)',
        boxShadow: 'var(--pc-shadow-md)',
      }}
    >
      <h2 id={titleId} style={{ marginTop: 0 }}>
        {title}
      </h2>
      <div>{children}</div>
      {actions && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--pc-space-2)',
            marginTop: 'var(--pc-space-6)',
          }}
        >
          {actions}
        </div>
      )}
    </dialog>
  );
}
