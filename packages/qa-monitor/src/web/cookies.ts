// landingAgent-specific (not upstream openclaw)
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) {
      continue;
    }
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
