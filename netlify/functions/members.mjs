import { getStore } from "@netlify/blobs";

export const config = { path: "/api/members" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function authenticate(req, context) {
  const fromContext = context?.clientContext?.user;
  if (fromContext && fromContext.sub) {
    return { id: fromContext.sub, email: fromContext.email, meta: fromContext.app_metadata || {} };
  }

  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) return null;

  try {
    const res = await fetch(`${base}/.netlify/identity/user`, { headers: { authorization: auth } });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id) return null;
    return { id: user.id, email: user.email, meta: user.app_metadata || {} };
  } catch {
    return null;
  }
}

const SHEETS_URL = process.env.SHEETS_URL;
const SHEETS_SECRET = process.env.SHEETS_SECRET;
const usingSheets = () => Boolean(SHEETS_URL && SHEETS_SECRET);

async function sheets(op, payload = {}) {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op, ...payload }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Sheet responded ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export default async (req, context) => {
  const user = await authenticate(req, context);
  if (!user) return json({ error: "Sign in required" }, 401);

  const roles = Array.isArray(user.meta.roles) ? user.meta.roles : [];
  if (!roles.includes("admin")) return json({ error: "Admins only" }, 403);

  // The sheet already keeps one row per member, so it can summarise in one call.
  if (usingSheets()) {
    try {
      return json(await sheets("list"));
    } catch {
      return json({ error: "Could not read the sheet" }, 502);
    }
  }

  const store = getStore("members");

  let keys = [];
  try {
    const listing = await store.list();
    keys = (listing.blobs || []).map((b) => b.key);
  } catch {
    return json({ error: "Could not read the member store" }, 500);
  }

  const members = [];
  for (const key of keys) {
    try {
      const rec = await store.get(key, { type: "json" });
      if (!rec) continue;
      const p = rec.profile || {};
      const dates = Object.keys(rec.entries || {}).sort();
      const last = dates[dates.length - 1] || null;

      // trailing 7-day average of the most recent weigh-ins
      const weights = dates
        .map((d) => rec.entries[d]?.weight)
        .filter((w) => typeof w === "number");
      const recent = weights.slice(-7);
      const trend = recent.length
        ? recent.reduce((s, w) => s + w, 0) / recent.length
        : null;

      const banked = dates.reduce((s, d) => s + (rec.entries[d]?.burn || 0), 0);

      members.push({
        id: key,
        name: p.name || "",
        email: rec.email || "",
        startWeight: p.startWeight ?? null,
        goalWeight: p.goalWeight ?? null,
        currentWeight: trend != null ? Number(trend.toFixed(2)) : null,
        daysLogged: dates.length,
        lastLog: last,
        bankedKcal: Math.round(banked),
        updatedAt: rec.updatedAt || null,
      });
    } catch {
      // a member record that won't parse shouldn't take down the whole list
    }
  }

  members.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return json({ count: members.length, members });
};
