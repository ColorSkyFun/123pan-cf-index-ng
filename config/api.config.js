/**
 * This file contains the configuration for the API endpoints and tokens we use to connect 123pan (123云盘).
 *
 * This project uses the **web client API** (the same endpoints the 123pan web app uses), following
 * OpenList's `123Pan` driver, so no paid Open Platform developer access is required.
 *
 * Authentication (choose one):
 * - PAN_USERNAME + PAN_PASSWORD: the server logs in and re-authenticates automatically when the
 *   token expires. Recommended.
 * - PAN_PASSPORT_TOKEN: paste the Bearer token of a logged-in web session (F12 -> Network, copy
 *   the `authorization` header value of any yun.123pan.com request). No auto-refresh; you must
 *   replace it when it expires.
 */
// Read lazily via getters: the edge runtime may recycle isolates slowly, and
// getters make credential changes (e.g. a freshly pasted passport token)
// take effect without waiting for old instances to die.
module.exports = {
  get username() { return process.env.PAN_USERNAME || '' },
  get password() { return process.env.PAN_PASSWORD || '' },
  get passportToken() { return process.env.PAN_PASSPORT_TOKEN || '' },

  // Endpoints of the 123pan web API. Override with PAN_API_BASE / PAN_LOGIN_API for testing.
  apiBase: process.env.PAN_API_BASE || 'https://yun.123pan.com/b/api',
  loginApi: process.env.PAN_LOGIN_API || 'https://login.123pan.com/api/user/sign_in',

  // Sent as the `platform` header and inside the URL signature. Do not change.
  platform: 'web',
  appVersion: '3',

  // Cache-Control header, check Vercel/Cloudflare documentation for more details. The default settings imply:
  // - max-age=0: no cache for your browser
  // - s-maxage=0: cache is fresh for 60 seconds on the edge, after which it becomes stale
  // - stale-while-revalidate: allow serving stale content while revalidating on the edge
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
  cacheControlHeader: 'max-age=0, s-maxage=60, stale-while-revalidate',
}
