/** Organization roles and the permissions each grants. Enforced server-side only. */

export const ROLES = ['owner', 'admin', 'producer', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:manage',
  'org:billing',
  'members:manage',
  'consent:manage',
  'project:create',
  'project:read',
  'project:configure',
  'job:create',
  'job:cancel',
  'transcript:edit',
  'segment:regenerate',
  'review:approve',
  'review:comment',
  'deliverable:download',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = ['project:read', 'deliverable:download'];
const REVIEWER: readonly Permission[] = [
  ...VIEWER,
  'review:comment',
  'review:approve',
  'transcript:edit',
  'segment:regenerate',
];
const PRODUCER: readonly Permission[] = [
  ...REVIEWER,
  'project:create',
  'project:configure',
  'job:create',
  'job:cancel',
];
const ADMIN: readonly Permission[] = [
  ...PRODUCER,
  'members:manage',
  'consent:manage',
  'audit:read',
];
const OWNER: readonly Permission[] = [...ADMIN, 'org:manage', 'org:billing'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  producer: new Set(PRODUCER),
  reviewer: new Set(REVIEWER),
  viewer: new Set(VIEWER),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
