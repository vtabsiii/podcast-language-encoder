'use client';

import { useActionState, useState } from 'react';
import type { MeResponse } from '@polycast/contracts';
import { Button, Field, describedBy } from '@polycast/ui';
import { devLogin, type LoginState } from './actions';

export interface LoginFormProps {
  memberships: MeResponse['memberships'];
  defaults: { email: string; displayName: string; organizationId: string | null };
  next: string;
}

export function LoginForm({ memberships, defaults, next }: LoginFormProps) {
  const [state, action, pending] = useActionState<LoginState, FormData>(devLogin, {});
  const canJoin = memberships.length > 0;
  const [mode, setMode] = useState<'join' | 'create'>(canJoin ? 'join' : 'create');
  const fe = state.fieldErrors ?? {};

  return (
    <form
      action={action}
      className="card"
      aria-describedby={state.error ? 'login-error' : undefined}
    >
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="mode" value={mode} />
      {state.error && (
        <div id="login-error" role="alert" className="alert">
          {state.error}
        </div>
      )}

      <Field id="email" label="Email" required error={fe.email}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={defaults.email}
          aria-invalid={fe.email ? true : undefined}
          aria-describedby={describedBy('email', { error: Boolean(fe.email) })}
        />
      </Field>

      <Field id="displayName" label="Display name" error={fe.displayName}>
        <input
          id="displayName"
          name="displayName"
          type="text"
          autoComplete="name"
          maxLength={120}
          defaultValue={defaults.displayName}
          aria-invalid={fe.displayName ? true : undefined}
          aria-describedby={describedBy('displayName', { error: Boolean(fe.displayName) })}
        />
      </Field>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 var(--pc-space-4)' }}>
        <legend style={{ fontWeight: 500, marginBottom: 'var(--pc-space-2)' }}>Organization</legend>
        <div className="checkbox-row">
          <input
            type="radio"
            id="mode-join"
            name="mode-choice"
            checked={mode === 'join'}
            disabled={!canJoin}
            onChange={() => setMode('join')}
          />
          <label htmlFor="mode-join">
            Use an organization I belong to
            {!canJoin && <span className="muted"> (sign in first)</span>}
          </label>
        </div>
        <div className="checkbox-row">
          <input
            type="radio"
            id="mode-create"
            name="mode-choice"
            checked={mode === 'create'}
            onChange={() => setMode('create')}
          />
          <label htmlFor="mode-create">Create a new organization</label>
        </div>
      </fieldset>

      {mode === 'join' ? (
        <Field id="organizationId" label="Organization" required error={fe.organizationId}>
          <select
            id="organizationId"
            name="organizationId"
            defaultValue={defaults.organizationId ?? memberships[0]?.organization.id}
            aria-invalid={fe.organizationId ? true : undefined}
          >
            {memberships.map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.name} ({m.role})
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field
          id="organizationName"
          label="Organization name"
          required
          description="You become its owner. Budgets and members are managed later under Admin."
          error={fe.organizationName}
        >
          <input
            id="organizationName"
            name="organizationName"
            type="text"
            maxLength={120}
            required
            aria-invalid={fe.organizationName ? true : undefined}
            aria-describedby={describedBy('organizationName', {
              description: true,
              error: Boolean(fe.organizationName),
            })}
          />
        </Field>
      )}

      <div className="actions">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}
