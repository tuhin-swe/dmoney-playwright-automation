// @ts-check
/**
 * Reusable DMoney page actions, written as small Page-Object-style helpers so the
 * spec reads like the user journey rather than a wall of selectors.
 */
const { expect } = require('@playwright/test');
const { latestUid, waitForOtp } = require('./mailbox');

/** Build a run-unique identity whose email is a +alias of the shared Gmail inbox. */
function makeIdentity(prefix) {
  const stamp = Date.now().toString().slice(-7);
  const rand = Math.floor(Math.random() * 90 + 10); // 2 digits
  const base = (process.env.GMAIL_USER || 'test@gmail.com').split('@')[0];
  return {
    name: `${prefix} ${stamp}`,
    email: `${base}+${prefix.toLowerCase().replace(/\s+/g, '')}${stamp}@gmail.com`,
    password: `Pass@${stamp}`,
    phone: `01${prefix === 'Agent' ? '8' : '6'}${stamp}00`.slice(0, 11),
    nid: `19${stamp}456`.slice(0, 13),
  };
}

/** Register a new account with the given role ("Agent" | "Customer" | "Merchant"). */
async function register(page, role, identity) {
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(role, 'i') }).click();
  await page.fill('input[name=name]', identity.name);
  await page.fill('input[name=email]', identity.email);
  await page.fill('input[name=password]', identity.password);
  await page.fill('input[name=phone_number]', identity.phone);
  await page.fill('input[name=nid]', identity.nid);
  await page.click('button[type=submit]');
  // Successful registration bounces to the login page.
  await page.waitForURL('**/login', { timeout: 20_000 });
}

/**
 * Best-effort logout so a shared browser context can switch roles cleanly.
 * Silently returns if no one is logged in.
 */
async function tryLogout(page) {
  try {
    await page.goto('/profile', { waitUntil: 'networkidle' });
    if (!/\/profile/.test(page.url())) return; // not authenticated -> redirected to login
    const avatar = page.locator('header .MuiAvatar-root').first();
    if (await avatar.count()) {
      await avatar.click();
      await page.getByText(/logout/i).click({ timeout: 5_000 });
      await page.waitForURL(/\/(login)?$/, { timeout: 10_000 });
    }
  } catch {
    /* already logged out or menu not present */
  }
}

/** Log in a privileged account (admin/system) that does NOT require an OTP. */
async function loginBasic(page, email, password) {
  await tryLogout(page);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByLabel(/email or phone/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/profile', { timeout: 20_000 });
}

/**
 * Log in an agent/customer account: submit credentials, then read the 4-digit OTP
 * emailed to the inbox and submit it. Returns nothing; throws on failure.
 */
async function loginWithOtp(page, email, password, { attempts = 2 } = {}) {
  // Each submit emails a fresh OTP valid for ~2 minutes. We request, then read the
  // matching email; if it is slow/expired we re-request once so the run stays robust.
  let lastErr;
  await tryLogout(page);
  for (let i = 0; i < attempts; i++) {
    const baseline = await latestUid();
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel(/email or phone/i).fill(email);
    await page.getByLabel(/^password/i).fill(password);
    await page.click('button[type=submit]');
    await expect(page.getByText(/verify your identity|enter the otp/i).first()).toBeVisible({ timeout: 20_000 });
    let otp;
    try {
      otp = await waitForOtp(baseline, { timeoutMs: 130_000 });
    } catch (e) {
      lastErr = e;
      continue; // re-request a fresh OTP
    }
    await page.locator('input').first().fill(otp);
    await page.getByRole('button', { name: /verify otp/i }).click();
    try {
      await page.waitForURL('**/profile', { timeout: 15_000 });
      return otp;
    } catch (e) {
      lastErr = e; // OTP may have expired between send and submit; try again
    }
  }
  throw lastErr || new Error('OTP login failed');
}

/** Admin: find a user by email and set their Account Status to Active. */
async function adminActivateUser(page, email) {
  await page.goto('/admin/users', { waitUntil: 'networkidle' });
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Search by Email' }).click();
  await page.getByPlaceholder('e.g., user@example.com').fill(email);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await page.locator('table tbody tr').first().getByText('VIEW').click();
  await page.waitForURL('**/admin/users/*', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Edit User' }).click();
  const combos = page.getByRole('combobox');
  const count = await combos.count();
  for (let i = 0; i < count; i++) {
    if (/pending|active|suspend/i.test(await combos.nth(i).innerText())) {
      await combos.nth(i).click();
      await page.getByRole('option', { name: /^active/i }).click();
      break;
    }
  }
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/user updated successfully/i).first()).toBeVisible({ timeout: 20_000 });
}

/** Admin: search a user by email and return their status row as text (e.g. "PENDING"/"ACTIVE"). */
async function adminFindUserRow(page, email) {
  await page.goto('/admin/users', { waitUntil: 'networkidle' });
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Search by Email' }).click();
  await page.getByPlaceholder('e.g., user@example.com').fill(email);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const row = page.locator('table tbody tr').first();
  await expect(row).toContainText(email, { timeout: 20_000 });
  return (await row.innerText()).replace(/\n+/g, ' ');
}

/** From any logged-in account, open the avatar menu and log out. */
async function logout(page) {
  await page.locator('header .MuiAvatar-root').first().click();
  await page.getByText(/logout/i).click();
  await page.waitForURL(/\/(login|)$/, { timeout: 20_000 });
}

/** Agent: deposit (cash-in) an amount to a customer by phone number. */
async function agentCashIn(page, customerPhone, amount) {
  await page.getByRole('link', { name: 'Cash In' }).click();
  await page.waitForURL('**/agent/cash-in', { timeout: 20_000 });
  await page.fill('input[name=customer]', customerPhone);
  await page.fill('input[name=amount]', String(amount));
  await page.click('button[type=submit]');
}

/** Read the "Current Balance: BDT X" figure from the Self Statement page. */
async function readSelfStatementBalance(page) {
  await page.getByRole('link', { name: 'Self Statement' }).click();
  await page.waitForURL('**/agent/self-statement', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const text = await page.locator('body').innerText();
  const m = text.match(/Current Balance:\s*BDT\s*([\d,]+\.\d{2})/i);
  if (!m) throw new Error('Could not read current balance from Self Statement');
  return parseFloat(m[1].replace(/,/g, ''));
}

/** Extract every row of the Self Statement table as objects keyed by column header. */
async function extractSelfStatement(page) {
  if (!/self-statement/.test(page.url())) {
    await page.getByRole('link', { name: 'Self Statement' }).click();
    await page.waitForURL('**/agent/self-statement', { timeout: 20_000 });
  }
  await page.waitForTimeout(1500);
  const headers = await page.$$eval('table thead th', (ths) => ths.map((t) => t.textContent.trim()));
  const rows = await page.$$eval('table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim())),
  );
  return rows.map((cells) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = cells[i] ?? ''));
    return obj;
  });
}

module.exports = {
  makeIdentity,
  register,
  tryLogout,
  loginBasic,
  loginWithOtp,
  adminActivateUser,
  adminFindUserRow,
  logout,
  agentCashIn,
  readSelfStatementBalance,
  extractSelfStatement,
};
