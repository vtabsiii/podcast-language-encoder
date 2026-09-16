/** Row → wire mappings for organizations and users, shared by the auth and organization routes. */

export interface OrgRow {
  id: string;
  name: string;
  plan: string;
  region: string;
  retention_days: number;
  monthly_budget_cents: number | null;
  status: 'active' | 'suspended' | 'deleting';
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
}

export const ORG_COLUMNS = 'id, name, plan, region, retention_days, monthly_budget_cents, status';

export const orgView = (o: OrgRow) => ({
  id: o.id,
  name: o.name,
  plan: o.plan,
  region: o.region,
  retentionDays: o.retention_days,
  monthlyBudgetCents: o.monthly_budget_cents,
  status: o.status,
});

export const userView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  createdAt: u.created_at.toISOString(),
});
