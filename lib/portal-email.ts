// Deliberately stricter than RFC 5322: ASCII only, and no markup-significant characters
// (< > " & backtick, whitespace) anywhere, because portal emails are echoed back in HTML pages.
const PORTAL_EMAIL_RE =
  /^[A-Za-z0-9.!#$%'*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** True when `email` is a plain ASCII address accepted for portal sign-in (max 254 chars). */
export function isValidPortalEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length <= 254 && PORTAL_EMAIL_RE.test(trimmed);
}
