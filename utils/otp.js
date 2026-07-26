// In-memory OTP store — resets on server restart, which is fine (OTPs are short-lived)
const store = {};

function generate() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Create and store a new OTP for email + purpose.
 * Returns the 6-digit plaintext code (to be emailed to the user).
 */
function setOTP(email, purpose) {
  const code = generate();
  store[`${email}:${purpose}`] = {
    code,
    expires: Date.now() + 10 * 60 * 1000  // 10 minutes
  };
  return code;
}

/**
 * Verify an OTP. Returns { ok: true } or { ok: false, error: '...' }.
 * Deletes the entry on success (one-time use).
 */
function checkOTP(email, code, purpose) {
  const key = `${email}:${purpose}`;
  const entry = store[key];
  if (!entry) return { ok: false, error: 'No verification code found. Please request a new code.' };
  if (Date.now() > entry.expires) {
    delete store[key];
    return { ok: false, error: 'Verification code has expired. Please request a new one.' };
  }
  if (entry.code !== String(code).trim()) {
    return { ok: false, error: 'Incorrect code. Please check your email and try again.' };
  }
  delete store[key];
  return { ok: true };
}

module.exports = { setOTP, checkOTP };
