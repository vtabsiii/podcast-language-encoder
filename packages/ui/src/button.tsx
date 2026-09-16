import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', style, ...rest }: ButtonProps) {
  const primary = variant === 'primary';
  return (
    <button
      {...rest}
      style={{
        font: '500 14px/1 var(--pc-font-sans)',
        padding: 'var(--pc-space-3) var(--pc-space-4)',
        borderRadius: 'var(--pc-radius-md)',
        border: primary ? '1px solid transparent' : '1px solid var(--pc-color-border)',
        background: primary ? 'var(--pc-color-accent)' : 'var(--pc-color-surface)',
        color: primary ? 'var(--pc-color-accent-contrast)' : 'var(--pc-color-text)',
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.6 : 1,
        ...style,
      }}
    />
  );
}
