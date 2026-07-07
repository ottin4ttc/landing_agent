// landingAgent-specific (not upstream openclaw)
export function isAllowed(allowed: string[], openId: string | null | undefined): boolean {
  if (!openId) return false;
  if (allowed.length === 0) return false; // fail-closed
  return allowed.includes(openId);
}
