# Feishu Onboarding Search: Service-Account Bootstrap Runbook

`feishu_search` normally uses the app's **tenant_access_token**, which cannot
read enterprise-public wiki content (`wiki/v1/nodes/search` requires a real
user identity). To let the onboarding bot search the internal wiki
(TTC 制度、billing 说明等), configure a dedicated service account whose
**user_access_token** the bot refreshes automatically via
`onboardingSearch.seedRefreshToken` (see `extensions/feishu/src/user-token.ts`
and `extensions/feishu/src/search.ts`).

This is a one-time bootstrap per environment. The seed refresh_token is
exchanged once by hand; after that `createFeishuUserTokenProvider` refreshes
it on demand and persists the rotated refresh_token to the configured store
path (default `~/.openclaw/feishu-user-token.json`, or an explicit
`refreshTokenStorePath` — recommended in the BCC deployment so it survives
container restarts, e.g. a mounted volume path).

## Steps

1. **Create a dedicated Feishu account for the bot** (a real user account in
   your tenant, not the app's own bot identity). Using a service/shared
   account — rather than a real employee's — avoids breaking the bot if that
   person leaves or changes their password.

2. **Enable user-identity OAuth scopes** on the Feishu app used by the bot
   (开发者后台 → 权限管理): add the scope needed to call
   `wiki:wiki:readonly` (or the broader wiki read scope covering
   `wiki/v1/nodes/search`) under the **User** authorization type, not just
   tenant. Publish the app version if scopes changed.

3. **Have that service account authorize the app** to get an
   `authorization_code`: open the OAuth authorize URL in a browser logged in
   as the service account:

   ```
   https://open.feishu.cn/open-apis/authen/v1/index?app_id=<appId>&redirect_uri=<redirect_uri>
   ```

   After consenting, Feishu redirects to `<redirect_uri>?code=<code>`. Copy
   `<code>` (it is short-lived, use it immediately).

4. **Exchange the code for a seed refresh_token** with the bootstrap script:

   ```bash
   node scripts/feishu-exchange-refresh.mjs <appId> <appSecret> <code>
   ```

   This prints `refresh_token`, `scope`, and the access-token TTL. Copy the
   `refresh_token` value — this is the "seed" the runtime will exchange for
   access tokens (and rotate) going forward.

5. **Wire it into the BCC deployment:**
   - Add the secret to the BCC `.env`:
     ```
     FEISHU_ONBOARDING_REFRESH_TOKEN=<refresh_token from step 4>
     ```
   - In `openclaw.json`, on the relevant Feishu account, add:
     ```json
     "onboardingSearch": {
       "seedRefreshToken": { "secretRef": "env:FEISHU_ONBOARDING_REFRESH_TOKEN" },
       "spaceId": "7065297004640878595"
     }
     ```
     (`spaceId` is optional — omit to search across all wiki spaces the
     service account can see; set it to scope search to one wiki space.)
   - Restart the gateway so the new config and env var are picked up.

## Notes

- **Refresh tokens expire after ~30 days of inactivity.** If the bot has been
  idle (no searches) for 30+ days, the seed/rotated refresh_token may be
  invalid; `feishu_search` will fail for the onboarding path and you must
  redo steps 3–5 to mint a fresh one.
- If `onboardingSearch.seedRefreshToken` is not configured for an account,
  `feishu_search` transparently falls back to the original tenant-token
  `search.docWiki.search` behavior — no functional regression for accounts
  that don't need wiki access.
- Never commit the refresh_token or app secret; always reference via
  `secretRef`/env, matching the rest of the Feishu extension's secret
  handling.
