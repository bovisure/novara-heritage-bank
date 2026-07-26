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

const emailHTML = (otp, purpose) => `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#0d0f14;border-radius:20px;overflow:hidden;max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);padding:36px 40px;text-align:center;">
      <div style="font-size:44px;margin-bottom:12px;">&#127960;</div>
          <h1 style="color:#fff;font-size:20px;font-weight:900;margin:0;letter-spacing:3px;text-transform:uppercase;">Novara Heritage Bank</h1>
              <p style="color:rgba(255,255,255,0.6);font-size:11px;margin:6px 0 0;letter-spacing:3px;">SECURE &middot; TRUSTED &middot; RELIABLE</p>
                </td></tr>
                  <tr><td style="padding:40px;text-align:center;">
                      <p style="color:#94a3b8;font-size:16px;margin:0 0 8px;font-weight:700;">${purpose === 'register' ? 'Verify Your Email Address' : 'Login Verification Code'}</p>
                          <p style="color:#64748b;font-size:13px;margin:0 0 28px;line-height:1.6;">
                                ${purpose === 'register'
                                          ? 'Enter this code to verify your email and complete account creation:'
                                          : 'Enter this code to complete your sign-in. Never share this with anyone.'}
                                              </p>
                                                  <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                                                        <tr><td style="background:#1e3a8a;border-radius:16px;padding:22px 44px;">
                                                                <span style="font-size:46px;font-weight:900;color:#fff;letter-spacing:14px;font-family:monospace,Courier;">${otp}</span>
                                                                      </td></tr>
                                                                          </table>
                                                                              <p style="color:#94a3b8;font-size:13px;margin:28px 0 6px;">This code expires in <strong style="color:#e2e8f0;">10 minutes</strong></p>
                                                                                  <p style="color:#475569;font-size:12px;margin:0;">If you didn&apos;t request this, you can safely ignore this email.</p>
                                                                                    </td></tr>
                                                                                      <tr><td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
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
                                                                                                                      </html>
                                                                                                                      `;

async function sendOTP(toEmail, otp, purpose) {
    const subject = purpose === 'register'
      ? 'Your Novara Heritage Bank Verification Code'
          : 'Your Novara Heritage Bank Login Code';

  const accessToken = await getAccessToken();

  const messageParts = [
        `From: "Novara Heritage Bank" <novaraheritagebank.io@gmail.com>`,
        `To: ${toEmail}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        emailHTML(otp, purpose)
      ];

  const raw = Buffer.from(messageParts.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw })
  });

  if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gmail API error ${res.status}: ${err}`);
  }
}

module.exports = { sendOTP };
