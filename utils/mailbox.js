// @ts-check
/**
 * Gmail IMAP helper.
 *
 * The DMoney agent login is protected by a 4-digit OTP emailed to the registered
 * Gmail address, and the password-reset flow emails a one-time link. There is no
 * fixed/bypass OTP, so the only reliable way to automate the agent is to read those
 * emails straight from the inbox.
 *
 * A SINGLE persistent IMAP connection is reused for the whole run. Opening a fresh
 * connection for every poll makes Gmail throttle new logins, which manifests as
 * searches that quietly stop returning new mail — so we connect once and keep it.
 *
 * To avoid reading a stale OTP, callers grab the current highest UID (`latestUid`)
 * before triggering, then wait for a NEW message with a higher UID.
 */
const { ImapFlow } = require('imapflow');
require('dotenv').config();

let clientPromise = null;

async function getClient() {
  if (clientPromise) {
    try {
      const c = await clientPromise;
      if (c.usable) return c;
    } catch {
      /* fall through and reconnect */
    }
    clientPromise = null;
  }
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD missing in .env — see .env.example');
  }
  clientPromise = (async () => {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
      // Keep the socket alive across the whole test run.
      socketTimeout: 5 * 60 * 1000,
    });
    await client.connect();
    await client.mailboxOpen('INBOX');
    return client;
  })();
  return clientPromise;
}

/** Close the shared connection (call once at the end of the run). */
async function closeMailbox() {
  if (!clientPromise) return;
  try {
    const c = await clientPromise;
    await c.logout();
  } catch {
    /* ignore */
  } finally {
    clientPromise = null;
  }
}

/** Highest UID currently in the inbox — a baseline so we only read mail arriving after. */
async function latestUid() {
  const client = await getClient();
  await client.noop().catch(() => {}); // surface any mail that arrived since SELECT
  const all = await client.search({ all: true }, { uid: true });
  return all && all.length ? Math.max(...all) : 0;
}

/**
 * Poll the inbox until a message newer than `afterUid` matches `matcher`,
 * returning whatever `matcher(subject, body)` returns (falsy = keep waiting).
 */
async function waitForMail(afterUid, matcher, { timeoutMs = 180_000, pollMs = 2_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const client = await getClient();
  const debug = process.env.DEBUG_MAIL === '1';
  while (Date.now() < deadline) {
    // A selected IMAP mailbox only surfaces mail that arrived after SELECT once the
    // client issues a NOOP, so refresh the view before every search.
    await client.noop().catch(() => {});
    // `since` is day-granular, so we additionally filter precisely by UID.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    const fresh = uids.filter((u) => u > afterUid).sort((a, b) => b - a);
    if (debug) {
      // eslint-disable-next-line no-console
      console.log(`[mail] afterUid=${afterUid} seen=${uids.length} max=${uids.length ? Math.max(...uids) : 0} fresh=${fresh.length}`);
    }
    for (const uid of fresh) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) continue;
      const subject = (msg.envelope && msg.envelope.subject) || '';
      const body = msg.source.toString().replace(/=\r?\n/g, ''); // undo quoted-printable soft breaks
      const result = matcher(subject, body);
      if (result) return result;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for matching email (afterUid=${afterUid})`);
}

/** Wait for the login OTP email and return the 4-digit code as a string. */
async function waitForOtp(afterUid, opts) {
  return waitForMail(
    afterUid,
    (subject, body) => {
      if (!/otp|login/i.test(subject)) return null;
      const near = body.match(/(?:otp|code)[^0-9]{0,40}(\d{4})/i);
      const any = body.match(/\b(\d{4})\b/);
      return (near && near[1]) || (any && any[1]) || null;
    },
    opts,
  );
}

/** Wait for the password-reset email and return the reset URL. */
async function waitForResetLink(afterUid, opts) {
  return waitForMail(
    afterUid,
    (subject, body) => {
      if (!/reset|password/i.test(subject)) return null;
      const m = body.match(/https?:\/\/[^\s"'<>]*reset-password[^\s"'<>]*/i);
      return m ? m[0].replace(/=$/, '') : null;
    },
    opts,
  );
}

module.exports = { latestUid, waitForOtp, waitForResetLink, closeMailbox };
