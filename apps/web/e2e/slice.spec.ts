import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * The first vertical slice, as a producer clicks through it (docs/implementation-plan.md M1 DoD):
 * sign in → project + upload → analysis → targets → estimate → submit → processing view →
 * review the flagged segment → regenerate → approve → deliverables. Axe runs on every screen.
 */
test.describe.configure({ mode: 'serial' });

const email = `producer-${Date.now()}@example.com`;
let projectUrl = '';
let reviewUrl = '';
// One browser page for the whole serial flow so the httpOnly session cookie carries across tests.
let page: Page;
let context: BrowserContext;
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});
test.afterAll(async () => {
  await context.close();
});

async function expectAccessible(page: Page, screen: string) {
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious,
    `${screen}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`,
  ).toEqual([]);
}

test('sign in creates an organization and lands on an empty dashboard', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expectAccessible(page, 'login');
  await page.fill('#email', email);
  await page.fill('#displayName', 'E2E Producer');
  await page.check('#mode-create');
  await page.fill('#organizationName', 'E2E Studio');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText('No localizations yet')).toBeVisible();
  await expect(page.getByText('E2E Studio')).toBeVisible();
  await expectAccessible(page, 'dashboard');
});

test('wizard: upload, analysis, targets, estimate, submit', async () => {
  await page.goto('/');
  await page.getByRole('link', { name: 'New localization', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 1: Upload source' })).toBeVisible();
  await expectAccessible(page, 'wizard step 1');

  await page.fill('#title', 'E2E Episode');
  await page.setInputFiles('#file', process.env['E2E_FIXTURE'] as string);
  await page.getByRole('button', { name: 'Create project and upload' }).click();

  await expect(page.getByRole('heading', { name: /Step 2/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Detected language')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 60_000 });
  await expectAccessible(page, 'wizard step 2');
  await page.getByRole('button', { name: /Confirm/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: /Step 3/ })).toBeVisible();
  await page.check('#target-es-MX');
  await expect(page.getByText('1 target selected.')).toBeVisible();
  await expectAccessible(page, 'wizard step 3');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: /Step 4/ })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'es-MX' })).toBeVisible();
  await page.check('#accept-beta');
  await expectAccessible(page, 'wizard step 4');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: /Step 5/ })).toBeVisible();
  await expectAccessible(page, 'wizard step 5');
  await page.getByRole('button', { name: 'Submit localization job' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/, { timeout: 30_000 });
  projectUrl = page.url();
});

test('processing view shows live stages and reaches NEEDS_REVIEW', async () => {
  await page.goto(projectUrl);
  await expect(page.getByRole('heading', { name: 'E2E Episode' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Targets' })).toBeVisible();
  const review = page.getByRole('link', { name: /Open review/ });
  await expect(review).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/1 open issue/)).toBeVisible();
  await expectAccessible(page, 'processing view');
  await review.click();
  await expect(page).toHaveURL(/\/review$/);
  reviewUrl = page.url();
});

test('review studio: flagged segment, keyboard navigation, regenerate, approve', async () => {
  await page.goto(reviewUrl);
  await expect(page.getByRole('heading', { name: /Review es-MX/ })).toBeVisible();
  await expect(page.getByText('1 open issue')).toBeVisible();
  const list = page.getByRole('list', { name: 'Segments' });
  await expect(list.locator('li').first()).toHaveAttribute('aria-current', 'true');
  await expectAccessible(page, 'review studio');

  // Keyboard-first: j moves down, k moves up.
  await page.locator('body').press('j');
  await expect(list.locator('li').nth(1)).toHaveAttribute('aria-current', 'true');
  await page.locator('body').press('k');
  await expect(list.locator('li').first()).toHaveAttribute('aria-current', 'true');

  await expect(page.getByRole('button', { name: 'Approve target' })).toBeDisabled();
  await page.getByRole('button', { name: 'Regenerate translation' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: /Regeneration queued/ })).toBeVisible();
  await expect(page.getByText('0 open issues')).toBeVisible({ timeout: 180_000 });
  // The target re-runs translate → … → QA on the whole episode before it returns to review.
  await expect(page.getByText(/v2 · mock-translation/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('button', { name: 'Approve target' })).toBeEnabled({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Approve target' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Target approved/ })).toBeVisible();
});

test('deliverables are packaged with checksums and a provenance disclosure', async () => {
  await page.goto(projectUrl);
  const deliverables = page.getByRole('link', { name: 'Deliverables' });
  await expect(deliverables).toBeVisible({ timeout: 180_000 });
  await deliverables.click();
  await expect(page.getByRole('heading', { name: /Deliverables/ })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(8); // header + 7 files
  await expect(page.getByText('checksums.sha256')).toBeVisible();
  await expect(page.getByText('provenance.json')).toBeVisible();
  await page.getByRole('button', { name: 'Show disclosure text' }).click();
  await expect(page.getByRole('blockquote')).toContainText(/mock providers/i);
  await expectAccessible(page, 'deliverables');
});

test('dashboard reflects the completed target and the languages page is RTL-aware', async () => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'E2E Episode' })).toBeVisible();
  await expect(page.getByText(/COMPLETE|Complete/).first()).toBeVisible({ timeout: 60_000 });
  await page.goto('/languages');
  await expect(page.locator('[dir="rtl"][lang="ar-SA"]')).toBeVisible();
  await expectAccessible(page, 'languages');
});
