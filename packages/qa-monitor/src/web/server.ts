import { randomBytes } from "node:crypto";
// landingAgent-specific (not upstream openclaw)
import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { QaConfig } from "../config.ts";
import { aggregate, type QaFilters } from "../store/aggregate.ts";
import { parseCookies } from "./cookies.ts";
import { renderDashboardHtml } from "./dashboard-html.ts";
import { buildAuthorizeUrl, exchangeCodeForOpenId } from "./feishu-oauth.ts";
import { createSession, getSession } from "./session-store.ts";
import { isAllowed } from "./whitelist.ts";

const COOKIE = "dcadmin_sid";
const STATE_COOKIE = "qa_oauth_state";
const TTL = 24 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 600;

function setCookie(cfg: QaConfig, sid: string): string {
  const parts = [
    `${COOKIE}=${sid}`,
    "Path=/qa-admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TTL / 1000}`,
  ];
  if (cfg.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
function setStateCookie(cfg: QaConfig, state: string): string {
  const parts = [
    `${STATE_COOKIE}=${state}`,
    "Path=/qa-admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL_SECONDS}`,
  ];
  if (cfg.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/qa-admin; Max-Age=0`;
}
function filtersFromUrl(u: URL): QaFilters {
  const num = (k: string) => (u.searchParams.get(k) ? Number(u.searchParams.get(k)) : undefined);
  return {
    from: num("from"),
    to: num("to"),
    user: u.searchParams.get("user") ?? undefined,
    chatType: u.searchParams.get("chatType") ?? undefined,
    channel: u.searchParams.get("channel") ?? undefined,
  };
}

async function handleRequest(
  db: DatabaseSync,
  cfg: QaConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const now = Date.now();
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(db, cookies[COOKIE], now);

  // login
  if (u.pathname === "/qa-admin/login") {
    if (cfg.devToken && u.searchParams.get("dev") === cfg.devToken) {
      const sid = createSession(db, "dev-admin", "Dev Admin", now, TTL);
      res.writeHead(302, { "set-cookie": setCookie(cfg, sid), location: "/qa-admin/dashboard" });
      res.end();
      return;
    }
    const state = randomBytes(16).toString("hex");
    res.writeHead(302, {
      "set-cookie": setStateCookie(cfg, state),
      location: buildAuthorizeUrl(cfg, state),
    });
    res.end();
    return;
  }
  // oauth callback
  if (u.pathname === "/qa-admin/auth/callback") {
    const code = u.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("missing code");
      return;
    }
    const state = u.searchParams.get("state");
    const cookieState = cookies[STATE_COOKIE];
    if (!state || !cookieState || state !== cookieState) {
      res.writeHead(400);
      res.end("invalid oauth state");
      return;
    }
    try {
      const { openId, name } = await exchangeCodeForOpenId(cfg, code);
      if (!isAllowed(cfg.adminAllowedUsers, openId)) {
        res.writeHead(403, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": clearStateCookie(),
        });
        res.end("<h1>403 无权限</h1>");
        return;
      }
      const sid = createSession(db, openId, name, now, TTL);
      res.writeHead(302, {
        "set-cookie": [setCookie(cfg, sid), clearStateCookie()],
        location: "/qa-admin/dashboard",
      });
      res.end();
      return;
    } catch {
      res.writeHead(500);
      res.end("login failed");
      return;
    }
  }
  if (u.pathname === "/qa-admin/logout") {
    res.writeHead(302, {
      "set-cookie": `${COOKIE}=; Path=/qa-admin; Max-Age=0`,
      location: "/qa-admin/login",
    });
    res.end();
    return;
  }
  // API (needs auth)
  if (u.pathname === "/qa-admin/api/dashboard") {
    if (!session) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const data = aggregate(db, filtersFromUrl(u));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }
  // Dashboard page (needs auth)
  if (u.pathname === "/qa-admin/dashboard") {
    if (!session) {
      res.writeHead(302, { location: "/qa-admin/login" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboardHtml(session));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

export function createServer(db: DatabaseSync, cfg: QaConfig): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(db, cfg, req, res);
  });
}
