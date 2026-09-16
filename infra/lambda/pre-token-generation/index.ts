/**
 * Cognito pre-token-generation trigger (V1: customises the ID token).
 *
 * Copies the pool's custom attributes into the claim shape the API's principal resolver expects
 * (assumption A-14): `org_ids` as a JSON array string, `role`, `email`, `name`. Membership is
 * stored on the user as `custom:org_ids` (space-separated organization ids) and `custom:role`.
 * No dependencies: the event shape is typed locally.
 */
export interface PreTokenGenerationEvent {
  readonly request: {
    readonly userAttributes: Record<string, string | undefined>;
    readonly groupConfiguration?: unknown;
    readonly clientMetadata?: Record<string, string>;
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
    } | null;
  };
}

/** Space-separated `custom:org_ids` -> JSON array string; `custom:role` -> `role`. */
export function buildClaims(
  attributes: Record<string, string | undefined>,
): Record<string, string> {
  const orgIds = (attributes['custom:org_ids'] ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const claims: Record<string, string> = { org_ids: JSON.stringify(orgIds) };
  const role = attributes['custom:role']?.trim();
  if (role) claims['role'] = role;
  const email = attributes['email']?.trim();
  if (email) claims['email'] = email;
  const name = attributes['name']?.trim();
  if (name) claims['name'] = name;
  return claims;
}

export const handler = async (event: PreTokenGenerationEvent): Promise<PreTokenGenerationEvent> => {
  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: buildClaims(event.request.userAttributes ?? {}),
  };
  return event;
};
