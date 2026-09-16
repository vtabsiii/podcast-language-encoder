export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  /** Zero-based index of the current step. */
  current: number;
  label?: string;
  /** Called when a completed step is activated to go back. */
  onSelect?: (index: number) => void;
}

/** Ordered wizard steps. Only completed steps are navigable; the current one is aria-current. */
export function Stepper({ steps, current, label = 'Steps', onSelect }: StepperProps) {
  return (
    <nav aria-label={label}>
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--pc-space-4)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
          counterReset: 'step',
        }}
      >
        {steps.map((step, i) => {
          const state = i < current ? 'complete' : i === current ? 'current' : 'upcoming';
          const content = (
            <>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  width: 24,
                  height: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  font: '600 12px/1 var(--pc-font-sans)',
                  background:
                    state === 'upcoming' ? 'var(--pc-color-surface)' : 'var(--pc-color-accent)',
                  color:
                    state === 'upcoming'
                      ? 'var(--pc-color-text-muted)'
                      : 'var(--pc-color-accent-contrast)',
                  border: '1px solid var(--pc-color-border)',
                }}
              >
                {state === 'complete' ? '✓' : i + 1}
              </span>
              <span>{step.label}</span>
              <span className="pc-visually-hidden">
                {state === 'complete'
                  ? ' (completed)'
                  : state === 'upcoming'
                    ? ' (not started)'
                    : ''}
              </span>
            </>
          );
          const style = {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--pc-space-2)',
            font: `${state === 'current' ? 600 : 400} 14px/1.4 var(--pc-font-sans)`,
            color: state === 'upcoming' ? 'var(--pc-color-text-muted)' : 'var(--pc-color-text)',
          } as const;
          return (
            <li key={step.id} aria-current={state === 'current' ? 'step' : undefined} style={style}>
              {state === 'complete' && onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  style={{
                    ...style,
                    background: 'none',
                    border: 0,
                    padding: 0,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
