// Which addresses belong to the app, and where a goviral:// link lands. No Electron here, so
// scripts/check.cjs can test it with plain Node.
"use strict";

const PROTOCOL = "goviral";

function originOf(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

function makeLinks(appOrigin) {
  const appHome = `${appOrigin}/desktop`;
  const isAppUrl = (url) => originOf(url) === appOrigin;

  // goviral://<path>?<query>  ->  <appOrigin>/desktop/<path>?<query>
  // goviral://open?url=<an address on the app's site>  ->  that address
  // Anything that would land on another site gives null.
  function deepLinkTarget(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== `${PROTOCOL}:`) return null;
      if (u.hostname === "open" && u.searchParams.get("url")) {
        const t = new URL(u.searchParams.get("url"));
        return isAppUrl(t.href) ? t.href : null;
      }
      const rest = `${u.hostname}${u.pathname}`.replace(/^\/+/, "").replace(/\/+$/, "");
      const t = new URL(rest ? `${appHome}/${rest}` : appHome);
      t.search = u.search;
      t.hash = u.hash;
      return isAppUrl(t.href) ? t.href : null;
    } catch { return null; }
  }

  const deepLinkIn = (argv) => (argv || []).find((a) => typeof a === "string" && a.toLowerCase().startsWith(`${PROTOCOL}://`));

  return { appHome, isAppUrl, deepLinkTarget, deepLinkIn };
}

// Only these go to the system (browser or mail app); file:, javascript: and custom schemes never do.
function isSafeExternal(url) {
  try { return ["https:", "http:", "mailto:"].includes(new URL(url).protocol); } catch { return false; }
}

module.exports = { PROTOCOL, originOf, makeLinks, isSafeExternal };
