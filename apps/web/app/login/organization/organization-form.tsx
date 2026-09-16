'use client';

import { useActionState } from 'react';
import { Button, Field, describedBy } from '@polycast/ui';
import { createOrganization, type OrganizationState } from './actions';

export function OrganizationForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<OrganizationState, FormData>(
    createOrganization,
    {},
  );
  const fe = state.fieldErrors ?? {};
  return (
    <form
      action={action}
      className="card"
      aria-describedby={state.error ? 'organization-error' : undefined}
    >
      <input type="hidden" name="next" value={next} />
      {state.error && (
        <div id="organization-error" role="alert" className="alert">
          {state.error}
        </div>
      )}
      <Field
        id="name"
        label="Organization name"
        required
        description="You become its owner."
        error={fe.name}
      >
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="organization"
          maxLength={120}
          required
          aria-invalid={fe.name ? true : undefined}
          aria-describedby={describedBy('name', { description: true, error: Boolean(fe.name) })}
        />
      </Field>
      <div className="actions">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating…' : 'Create organization'}
        </Button>
      </div>
    </form>
  );
}
