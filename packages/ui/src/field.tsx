import type { ReactNode } from 'react';

export interface FieldProps {
  /** Id of the control this field labels. */
  id: string;
  label: string;
  description?: string;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}

/**
 * Label + control + description + error, wired with htmlFor / aria-describedby.
 * The child control must carry `id={id}` and, when `error` is set, `aria-invalid`.
 */
export function Field({ id, label, description, error, required, children }: FieldProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--pc-space-1)', marginBottom: 'var(--pc-space-4)' }}>
      <label htmlFor={id} style={{ font: '500 14px/1.4 var(--pc-font-sans)' }}>
        {label}
        {required && (
          <span aria-hidden="true" style={{ color: 'var(--pc-color-status-error)' }}>
            {' '}
            *
          </span>
        )}
      </label>
      {description && (
        <span
          id={`${id}-description`}
          style={{ color: 'var(--pc-color-text-muted)', fontSize: 13 }}
        >
          {description}
        </span>
      )}
      {children}
      {error && (
        <span
          id={`${id}-error`}
          role="alert"
          style={{ color: 'var(--pc-color-status-error)', fontSize: 13 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

/** Helper to compute aria-describedby for a Field's control. */
export function describedBy(
  id: string,
  opts: { description?: boolean; error?: boolean },
): string | undefined {
  const ids = [
    opts.description ? `${id}-description` : null,
    opts.error ? `${id}-error` : null,
  ].filter((v): v is string => v !== null);
  return ids.length ? ids.join(' ') : undefined;
}
