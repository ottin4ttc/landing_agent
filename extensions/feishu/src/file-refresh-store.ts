// landingAgent-specific (not upstream openclaw): file-backed RefreshTokenStore.
// Atomic write (temp file + rename), 0600 perms.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RefreshTokenStore } from "./user-token.js";

export function createFileRefreshTokenStore(path: string): RefreshTokenStore {
  return {
    read(): string | null {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { refresh_token?: unknown };
        return typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
      } catch {
        return null;
      }
    },
    write(token: string): void {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ refresh_token: token, updated_at: Date.now() }), {
        mode: 0o600,
      });
      renameSync(tmp, path);
    },
  };
}
