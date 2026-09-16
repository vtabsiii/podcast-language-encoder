export interface ProgressBarProps {
  /** Fraction in [0, 1]. */
  value: number;
  /** Accessible name, e.g. "Upload progress". */
  label: string;
  /** Optional visible text; defaults to the rounded percentage. */
  valueText?: string;
  id?: string;
}

/** Determinate progress bar with the ARIA progressbar pattern. */
export function ProgressBar({ value, label, valueText, id }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const text = valueText ?? `${pct}%`;
  return (
    <div
      id={id}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={text}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--pc-space-2)' }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 8,
          borderRadius: 'var(--pc-radius-sm)',
          background: 'var(--pc-color-border)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${pct}%`,
            background: 'var(--pc-color-accent)',
            transition: 'width 200ms ease-out',
          }}
        />
      </span>
      <span
        aria-hidden="true"
        style={{ font: '500 12px/1 var(--pc-font-mono)', minWidth: '4ch', textAlign: 'end' }}
      >
        {text}
      </span>
    </div>
  );
}
