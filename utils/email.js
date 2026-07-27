// Gmail API over HTTPS — no SMTP ports needed, works on Railway
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Email logo block (CSS-only, email-safe) ──────────────────
const logoBlock = `<div style="text-align:center;margin-bottom:8px;"><div style="display:inline-flex;align-items:center;justify-content:center;width:54px;height:58px;background:linear-gradient(160deg,#0f1f5e,#1a3799);border-radius:8px 8px 14px 14px;border:2px solid rgba(201,162,39,0.6);font-size:28px;font-weight:900;color:white;font-family:Georgia,serif;">N</div></div>`;

// ── Base email template ───────────────────────────────────────
function baseTemplate(content) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#0d0f14;border-radius:20px;overflow:hidden;max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#0f1f5e 0%,#1a3799 100%);padding:30px 40px;text-align:center;">
    ${logoBlock}
    <h1 style="color:#fff;font-size:18px;font-weight:900;margin:10px 0 0;letter-spacing:3px;text-transform:uppercase;">Novara Heritage Bank</h1>
    <p style="color:rgba(255,255,255,0.5);font-size:10px;margin:5px 0 0;letter-spacing:3px;">SECURE &middot; TRUSTED &middot; RELIABLE</p>
  </td></tr>
  <tr><td style="padding:36px 40px;">${content}</td></tr>
  <tr><td style="padding:16px 40px 24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
    <p style="color:#475569;font-size:12px;margin:0 0 4px;">
      &#128222;&nbsp;<a href="https://wa.me/12159194436" style="color:#475569;text-decoration:none;">+1 (215) 919-4436</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="mailto:novaraheritagebank.io@gmail.com" style="color:#475569;text-decoration:none;">novaraheritagebank.io@gmail.com</a>
    </p>
    <p style="color:#334155;font-size:11px;margin:4px 0 0;">&copy; ${new Date().getFullYear()} Novara Heritage Bank. All rights reserved.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Core send function ────────────────────────────────────────
async function sendEmail(toEmail, subject, htmlBody) {
  const accessToken = await getAccessToken();
  const messageParts = [
    `From: "Novara Heritage Bank" <novaraheritagebank.io@gmail.com>`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    htmlBody
  ];
  const raw = Buffer.from(messageParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${err}`);
  }
}

// ── OTP emails ────────────────────────────────────────────────
async function sendOTP(toEmail, otp, purpose) {
  const isReg = purpose === 'register';
  const subject = isReg
    ? 'Your Novara Heritage Bank Verification Code'
    : 'Your Novara Heritage Bank Login Code';
  const content = `
    <p style="color:#94a3b8;font-size:16px;margin:0 0 8px;font-weight:700;text-align:center;">${isReg ? 'Verify Your Email Address' : 'Login Verification Code'}</p>
    <p style="color:#64748b;font-size:13px;margin:0 0 28px;line-height:1.6;text-align:center;">
      ${isReg ? 'Enter this code to verify your email and complete account creation:' : 'Enter this code to complete your sign-in. Never share this with anyone.'}
    </p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr><td style="background:#1e3a8a;border-radius:16px;padding:22px 44px;">
        <span style="font-size:46px;font-weight:900;color:#fff;letter-spacing:14px;font-family:monospace,Courier;">${otp}</span>
      </td></tr>
    </table>
    <p style="color:#94a3b8;font-size:13px;margin:28px 0 6px;text-align:center;">This code expires in <strong style="color:#e2e8f0;">10 minutes</strong></p>
    <p style="color:#475569;font-size:12px;margin:0;text-align:center;">If you didn&apos;t request this, you can safely ignore this email.</p>`;
  await sendEmail(toEmail, subject, baseTemplate(content));
}

// ── Account status emails ─────────────────────────────────────
async function sendAccountEmail(toEmail, type, data = {}) {
  const name = data.name || 'Valued Customer';
  const templates = {
    approved: {
      subject: '🎉 Your Novara Heritage Bank Account is Approved!',
      content: `
        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;background:#064e3b;border-radius:50%;width:60px;height:60px;line-height:60px;font-size:28px;">✅</div>
          <p style="color:#34d399;font-size:18px;font-weight:800;margin:12px 0 0;">Account Approved!</p>
        </div>
        <p style="color:#94a3b8;font-size:14px;text-align:center;margin:0 0 24px;line-height:1.7;">
          Welcome to Novara Heritage Bank, <strong style="color:#e2e8f0;">${name}</strong>!<br>
          Your account has been verified and is now active. You can sign in immediately.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1e293b;border-radius:12px;margin-bottom:24px;">
          <tr><td style="padding:12px 18px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);">Account Number</td><td style="padding:12px 18px;font-size:13px;color:#e2e8f0;font-weight:700;font-family:monospace;">${data.account_number || '—'}</td></tr>
          <tr><td style="padding:12px 18px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);">Routing Number</td><td style="padding:12px 18px;font-size:13px;color:#e2e8f0;font-weight:700;font-family:monospace;">${data.routing_number || '—'}</td></tr>
          <tr><td style="padding:12px 18px;font-size:12px;color:#64748b;">SWIFT / BIC</td><td style="padding:12px 18px;font-size:13px;color:#e2e8f0;font-weight:700;font-family:monospace;">NVRAUS33XXX</td></tr>
        </table>
        <p style="color:#64748b;font-size:12px;text-align:center;">Please keep your account details safe. Never share your PIN or password with anyone.</p>`
    },
    rejected: {
      subject: 'Novara Heritage Bank — Account Application Update',
      content: `
        <p style="color:#f87171;font-size:18px;font-weight:800;text-align:center;margin:0 0 12px;">Application Not Approved</p>
        <p style="color:#94a3b8;font-size:14px;text-align:center;margin:0 0 24px;line-height:1.7;">
          Dear ${name},<br><br>
          After carefully reviewing your application, we are unable to approve your account at this time.
          ${data.reason ? '<br><br>Reason: <strong style="color:#e2e8f0;">' + data.reason + '</strong>' : ''}
        </p>
        <p style="color:#64748b;font-size:13px;text-align:center;">For questions or to appeal this decision, contact our support team.</p>`
    },
    frozen: {
      subject: '⚠️ Important: Your Novara Heritage Bank Account Has Been Suspended',
      content: `
        <div style="background:#450a0a;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
          <div style="font-size:36px;margin-bottom:8px;">🔒</div>
          <p style="color:#fca5a5;font-size:16px;font-weight:800;margin:0 0 4px;">Account Suspended</p>
          <p style="color:#ef4444;font-size:12px;margin:0;">Effective immediately</p>
        </div>
        <p style="color:#94a3b8;font-size:14px;margin:0 0 16px;line-height:1.7;">
          Dear <strong style="color:#e2e8f0;">${name}</strong>,<br><br>
          Your Novara Heritage Bank account has been suspended. You will be unable to log in or conduct any transactions during this period.
        </p>
        ${data.reason ? `<div style="background:#1e293b;border-left:3px solid #ef4444;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:16px;"><p style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin:0 0 4px;">Reason</p><p style="color:#e2e8f0;font-size:13px;margin:0;">${data.reason}</p></div>` : ''}
        <p style="color:#64748b;font-size:12px;text-align:center;">To appeal, contact us at <a href="mailto:novaraheritagebank.io@gmail.com" style="color:#3b82f6;text-decoration:none;">novaraheritagebank.io@gmail.com</a></p>`
    },
    unfrozen: {
      subject: '✅ Your Novara Heritage Bank Account Has Been Reactivated',
      content: `
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:48px;">🔓</div>
          <p style="color:#34d399;font-size:16px;font-weight:800;margin:8px 0 0;">Account Reactivated</p>
        </div>
        <p style="color:#94a3b8;font-size:14px;text-align:center;margin:0 0 16px;line-height:1.7;">
          Dear <strong style="color:#e2e8f0;">${name}</strong>,<br><br>
          Great news — your Novara Heritage Bank account has been reactivated. You can now sign in and conduct transactions normally.
        </p>
        <p style="color:#64748b;font-size:12px;text-align:center;">Thank you for your patience and continued trust in Novara Heritage Bank.</p>`
    }
  };
  const tmpl = templates[type];
  if (!tmpl) return;
  await sendEmail(toEmail, tmpl.subject, baseTemplate(tmpl.content));
}

// ── Transaction notification emails ──────────────────────────
async function sendTransactionEmail(toEmail, type, data = {}) {
  const isDebit = type === 'debit';
  const sym = data.currencySymbol || '$';
  const amt = parseFloat(data.amount || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const bal = parseFloat(data.new_balance || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const subject = isDebit
    ? `Debit Alert: ${sym}${amt} sent from your account`
    : `Credit Alert: ${sym}${amt} received in your account`;
  const content = `
    <div style="background:${isDebit ? '#450a0a' : '#064e3b'};border-radius:14px;padding:22px;text-align:center;margin-bottom:22px;">
      <div style="font-size:36px;margin-bottom:6px;">${isDebit ? '📤' : '📥'}</div>
      <p style="color:${isDebit ? '#fca5a5' : '#6ee7b7'};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">${isDebit ? 'Money Sent' : 'Money Received'}</p>
      <p style="color:white;font-size:30px;font-weight:900;margin:0;font-family:monospace;">${sym}${amt}</p>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1e293b;border-radius:12px;margin-bottom:20px;">
      ${data.counterparty ? `<tr><td style="padding:11px 16px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);">${isDebit ? 'Sent To' : 'Received From'}</td><td style="padding:11px 16px;font-size:13px;color:#e2e8f0;font-weight:600;">${data.counterparty}</td></tr>` : ''}
      ${data.description ? `<tr><td style="padding:11px 16px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);">Description</td><td style="padding:11px 16px;font-size:13px;color:#94a3b8;">${data.description}</td></tr>` : ''}
      <tr><td style="padding:11px 16px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);">Available Balance</td><td style="padding:11px 16px;font-size:14px;color:#34d399;font-weight:800;">${sym}${bal}</td></tr>
      <tr><td style="padding:11px 16px;font-size:12px;color:#64748b;">Date &amp; Time</td><td style="padding:11px 16px;font-size:13px;color:#94a3b8;">${new Date().toLocaleString('en-US', {dateStyle:'medium', timeStyle:'short'})}</td></tr>
    </table>
    <p style="color:#475569;font-size:12px;text-align:center;">If you did not authorize this transaction, contact us immediately at<br><a href="mailto:novaraheritagebank.io@gmail.com" style="color:#3b82f6;text-decoration:none;">novaraheritagebank.io@gmail.com</a> or <a href="https://wa.me/12159194436" style="color:#3b82f6;text-decoration:none;">+1 (215) 919-4436</a></p>`;
  await sendEmail(toEmail, subject, baseTemplate(content));
}

module.exports = { sendOTP, sendEmail, sendAccountEmail, sendTransactionEmail };
