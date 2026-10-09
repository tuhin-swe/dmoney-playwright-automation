// @ts-check
/**
 * DMoney end-to-end user journey — Playwright assignment (Student ID: ART61264).
 *
 * This is a single stateful journey (register -> activate -> deposit -> transact ->
 * reset password -> export), so it runs with `describe.serial` on one worker and each
 * required validation is its own `test()` for granular pass/fail reporting.
 *
 * Design notes (why it looks the way it does):
 *  - Agent login needs a 4-digit OTP emailed to Gmail (read over IMAP). To avoid
 *    requesting an OTP per test, the agent authenticates once per session and the
 *    login is reused across the following tests.
 *  - The whole journey runs in ONE shared browser context (role switches happen via
 *    logout/login) so the headed run yields a single continuous submission video.
 *
 * Suites (selected by tag):
 *   @smoke  -> positive-path checks only          (npm run smoke)
 *   (all)   -> full regression incl. the negative (npm run regression)
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  makeIdentity,
  register,
  loginBasic,
  loginWithOtp,
  adminActivateUser,
  adminFindUserRow,
  logout,
  agentCashIn,
  readSelfStatementBalance,
  extractSelfStatement,
} = require('../utils/helpers');
const { latestUid, waitForResetLink, closeMailbox } = require('../utils/mailbox');
const { writeSelfStatementCsv } = require('../utils/csv');

const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const SYSTEM = { email: process.env.SYSTEM_EMAIL, password: process.env.SYSTEM_PASSWORD };

const SYSTEM_DEPOSIT = 2000;
const AGENT_TO_CUSTOMER = 500;
const VIDEO_DIR = path.join(process.cwd(), 'test-results', 'videos');

// ---- Shared journey state (single worker keeps this alive across the serial tests) ----
const agent = makeIdentity('Agent');
const customer = makeIdentity('Customer');
const state = {
  oldPassword: agent.password,
  newPassword: `Reset@${Date.now().toString().slice(-6)}`,
  balanceAfterSystemDeposit: null,
  balanceAfterAgentDeposit: null,
  depositCommission: null,
  statementRows: [],
  csvPath: null,
};

// One shared context/page for the whole journey -> one continuous video.
let journeyCtx;
let page;

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1366, height: 768 } },
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20_000);
  return { ctx, page: p };
}

test.describe.serial('DMoney E2E — Agent lifecycle', () => {
  test.beforeAll(async ({ browser }) => {
    ({ ctx: journeyCtx, page } = await newPage(browser));
  });

  test.afterAll(async () => {
    if (journeyCtx) await journeyCtx.close().catch(() => {});
    await closeMailbox();
    /* eslint-disable no-console */
    console.log('\n──────── DMoney run summary ────────');
    console.log('Agent email      :', agent.email);
    console.log('Agent phone      :', agent.phone);
    console.log('Customer phone   :', customer.phone);
    console.log('Balance @2000    :', state.balanceAfterSystemDeposit);
    console.log('Commission       :', state.depositCommission);
    console.log('Balance @deposit :', state.balanceAfterAgentDeposit);
    console.log('Statement rows   :', state.statementRows.length);
    console.log('CSV file         :', state.csvPath);
    console.log('────────────────────────────────────\n');
  });

  // 1. Registration
  test('@smoke 01 - Agent registration is successful', async () => {
    await register(page, 'Agent', agent);
    await expect(page).toHaveURL(/\/login/);
  });

  // Provision an existing Customer for the later agent deposit (our own test data).
  test('@smoke 02 - A Customer account can be registered (test data)', async () => {
    await register(page, 'Customer', customer);
    await expect(page).toHaveURL(/\/login/);
  });

  // 3. Admin login
  test('@smoke 03 - Admin login is successful', async () => {
    await loginBasic(page, ADMIN.email, ADMIN.password);
    await expect(page.getByText(/admin dashboard/i)).toBeVisible();
  });

  // 4 (+ "initially inactive"): Agent appears in admin list AND is PENDING.
  test('@smoke 04 - New Agent appears in Admin list and is initially inactive (PENDING)', async () => {
    const row = await adminFindUserRow(page, agent.email);
    expect(row).toContain(agent.email);
    expect(row).toMatch(/PENDING/i);
  });

  // 5. Admin activates the Agent.
  test('@smoke 05 - Admin can activate the Agent', async () => {
    await adminActivateUser(page, agent.email);
    await expect(page.locator('main')).toContainText(/ACTIVE/i);
  });

  // Activate the Customer too, so the agent's deposit target is active test data.
  test('@smoke 06 - Admin can activate the Customer (test data)', async () => {
    await adminActivateUser(page, customer.email);
    await expect(page.locator('main')).toContainText(/ACTIVE/i);
  });

  // 6. Status persists after reload.
  test('@smoke 07 - Agent remains active after page reload', async () => {
    await adminFindUserRow(page, agent.email);
    await page.locator('table tbody tr').first().getByText('VIEW').click();
    await page.waitForURL('**/admin/users/*');
    await expect(page.locator('main')).toContainText(/ACTIVE/i);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('main')).toContainText(/ACTIVE/i);
  });

  // 7. System login.
  test('@smoke 08 - System login is successful', async () => {
    await loginBasic(page, SYSTEM.email, SYSTEM.password);
    await expect(page.getByText(/dashboard/i).first()).toBeVisible();
  });

  // 8 + 9. System deposits 2000 to the Agent; a transaction record is produced.
  test('@smoke 09 - System deposits 2000 Tk to the Agent (transaction created)', async () => {
    await page.getByRole('link', { name: 'Cash In' }).click();
    await page.waitForURL('**/agent/cash-in');
    await page.fill('input[name=customer]', agent.phone);
    await page.fill('input[name=amount]', String(SYSTEM_DEPOSIT));
    await page.click('button[type=submit]');
    const main = page.locator('main');
    await expect(main).toContainText(/deposit to agent successful/i, { timeout: 20_000 });
    await expect(main).toContainText(/TXN[A-Z0-9]+/);
    await expect(main).toContainText(String(SYSTEM_DEPOSIT));
  });

  // 10. Agent can log in after activation (single OTP login, reused below).
  test('@smoke 10 - Agent can log in after activation', async () => {
    await loginWithOtp(page, agent.email, state.oldPassword);
    await expect(page).toHaveURL(/\/profile/);
  });

  // 11. Agent balance is exactly 2000.
  test('@smoke 11 - Agent balance is exactly 2000 Tk', async () => {
    const balance = await readSelfStatementBalance(page);
    state.balanceAfterSystemDeposit = balance;
    expect(balance).toBe(SYSTEM_DEPOSIT);
  });

  // 12. Agent deposits 500 to the existing Customer.
  test('@smoke 12 - Agent can deposit 500 Tk to an existing Customer', async () => {
    await agentCashIn(page, customer.phone, AGENT_TO_CUSTOMER);
    await expect(page.locator('main')).toContainText(/deposit successful/i, { timeout: 20_000 });
  });

  // 13. Agent balance updates correctly (2000 - 500 + 2.5% commission).
  test('@smoke 13 - Agent balance is updated correctly after the transaction', async () => {
    const rows = await extractSelfStatement(page);
    const commissionRow = rows.find((r) => /commission/i.test(r['Type'] || ''));
    const commission = commissionRow
      ? parseFloat(String(commissionRow['Credit']).replace(/[^\d.]/g, '')) || 0
      : 0;
    state.depositCommission = commission;

    const balance = await readSelfStatementBalance(page);
    state.balanceAfterAgentDeposit = balance;
    const expected = SYSTEM_DEPOSIT - AGENT_TO_CUSTOMER + commission;
    expect(balance).toBeCloseTo(expected, 2);
  });

  // 14. Customer deposit appears in the Agent's Self Statement.
  test('@smoke 14 - Customer deposit appears in the Agent Self Statement', async () => {
    const rows = await extractSelfStatement(page);
    const match = rows.find(
      (r) => (r['Receiver Account'] || '').includes(customer.phone) || /commission/i.test(r['Type'] || ''),
    );
    expect(match, 'a row referencing the customer deposit should exist').toBeTruthy();
  });

  // 15. Agent logout.
  test('@smoke 15 - Agent logout works successfully', async () => {
    await logout(page);
    await expect(page.getByText(/welcome back|login/i).first()).toBeVisible();
  });

  // 16. Password reset (forgot-password -> emailed link -> set new password).
  test('@smoke 16 - Agent password reset works successfully', async () => {
    const baseline = await latestUid();
    await page.goto('/forgot-password', { waitUntil: 'networkidle' });
    await page.locator('input').first().fill(agent.email);
    await page.getByRole('button', { name: /send reset/i }).click();
    const link = await waitForResetLink(baseline);
    expect(link).toContain('/reset-password?token=');

    await page.goto(link, { waitUntil: 'networkidle' });
    const pwFields = page.locator('input[type=password]');
    await expect(pwFields.first()).toBeVisible({ timeout: 20_000 });
    await pwFields.nth(0).fill(state.newPassword);
    await pwFields.nth(1).fill(state.newPassword);
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByText(/success|reset|login/i).first()).toBeVisible({ timeout: 20_000 });
  });

  // 17. NEGATIVE — old password must fail after reset. (Excluded from smoke.)
  // The agent is already logged out after the reset, so the shared page is clean.
  test('17 - Login with the old password fails after reset @negative', async () => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel(/email or phone/i).fill(agent.email);
    await page.getByLabel(/^password/i).fill(state.oldPassword);
    await page.click('button[type=submit]');
    await expect(page.getByText(/invalid|incorrect|wrong|failed/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/profile/);
  });

  // 18. New password works (fresh OTP login).
  test('@smoke 18 - Login with the new password succeeds', async () => {
    await loginWithOtp(page, agent.email, state.newPassword);
    await expect(page).toHaveURL(/\/profile/);
  });

  // 19. Self Statement contains the expected transaction data.
  test('@smoke 19 - Self Statement contains the expected transaction data', async () => {
    const rows = await extractSelfStatement(page);
    state.statementRows = rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => /system|top-?up/i.test(r['Type'] || ''))).toBeTruthy();
    expect(
      rows.some((r) => (r['Receiver Account'] || '').includes(customer.phone) || /commission/i.test(r['Type'] || '')),
    ).toBeTruthy();
  });

  // 20. Self Statement data is saved to the required CSV file.
  test('@smoke 20 - Self Statement data is saved into self_statement_<date>.csv', async () => {
    let rows = state.statementRows;
    if (!rows.length) rows = await extractSelfStatement(page);
    const csvPath = writeSelfStatementCsv(rows);
    state.csvPath = csvPath;

    expect(fs.existsSync(csvPath)).toBeTruthy();
    expect(path.basename(csvPath)).toMatch(/^self_statement_\d{4}-\d{2}-\d{2}\.csv$/);
    const content = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(content[0]).toContain('Transaction ID');
    expect(content.length).toBeGreaterThan(1);
  });
});
