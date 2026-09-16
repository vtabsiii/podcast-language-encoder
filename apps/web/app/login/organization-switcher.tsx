'use client';

import { useActionState } from 'react';
import type { MeResponse } from '@polycast/contracts';
import { Button, Field } from '@polycast/ui';
import { switchOrganization, type LoginState } from './actions';

export interface OrganizationSwitcherProps {
  memberships: MeResponse['memberships'];
  current: string;
  next: string;
}

export function OrganizationSwitcher({ memberships, current, next }: OrganizationSwitcherProps) {
  const [state, action, pending] = useActionState<LoginState, FormData>(switchOrganization, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form
      action={action}
      className="card"
      aria-describedby={state.error ? 'switch-error' : undefined}
    >
      <input type="hidden" name="next" value={next} />
      {state.error && (
        <div id="switch-error" role="alert" className="alert">
          {state.error}
        </div>
      )}
      <Field id="organizationId" label="Organization" required error={fe.organizationId}>
        <select
          id="organizationId"
          name="organizationId"
          defaultValue={current}
          aria-invalid={fe.organizationId ? true : undefined}
        >
          {memberships.map((m) => (
            <option key={m.organization.id} value={m.organization.id}>
              {m.organization.name} ({m.role})
            </option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Switching…' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}
