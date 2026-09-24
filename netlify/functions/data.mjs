import { getStore } from "@netlify/blobs";

export const config = { path: "/api/data" };

const MAX_BYTES = 1_000_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Storage. If SHEETS_URL and SHEETS_SECRET are set, everything goes to the Google
 * Sheet. If they aren't, it falls back to Netlify Blobs exactly as before — so an
 * existing deployment keeps working untouched until you add the variables.
 */
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

/**
 * Establish who is calling.
 * Fast path: Netlify injects the verified Identity user into clientContext.
 * Fallback: ask the site's own Identity service to validate the bearer token.
 * Either way the token is verified by Netlify, never by us.
 */
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
    const res = await fetch(`${base}/.netlify/identity/user`, {
      headers: { authorization: auth },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id) return null;
    return { id: user.id, email: user.email, meta: user.app_metadata || {} };
  } catch {
    return null;
  }
}

export default async (req, context) => {
  const user = await authenticate(req, context);
  if (!user) return json({ error: "Sign in required" }, 401);

  const isAdmin = Array.isArray(user.meta.roles) && user.meta.roles.includes("admin");
  const store = usingSheets() ? null : getStore("members");

  if (req.method === "GET") {
    try {
      const record = usingSheets()
        ? (await sheets("get", { id: user.id })).record
        : await store.get(user.id, { type: "json" });
      return json({ data: record || null, email: user.email, isAdmin });
    } catch (err) {
      // Don't invent an empty record when the backend is unreachable — the client
      // falls back to its local copy instead of overwriting good data with nothing.
      return json({ error: "Storage unreachable" }, 502);
    }
  }

  if (req.method === "PUT" || req.method === "POST") {
    let body;
    try {
      body = await req.text();
    } catch {
      return json({ error: "Could not read the request" }, 400);
    }
    if (body.length > MAX_BYTES) return json({ error: "Too much data in one save" }, 413);

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: "That wasn't valid JSON" }, 400);
    }

    // The member id and email come from the verified token, never from the client.
    const record = {
      profile: payload.profile || {},
      entries: payload.entries || {},
      sessions: payload.sessions || {},
      email: user.email,
      updatedAt: new Date().toISOString(),
    };

    try {
      if (usingSheets()) await sheets("put", { id: user.id, email: user.email, record });
      else await store.setJSON(user.id, record);
      return json({ ok: true, updatedAt: record.updatedAt });
    } catch (err) {
      return json({ error: "Save failed, try again" }, 502);
    }
  }

  if (req.method === "DELETE") {
    try {
      if (usingSheets()) await sheets("delete", { id: user.id });
      else await store.delete(user.id);
      return json({ ok: true });
    } catch {
      return json({ error: "Delete failed" }, 502);
    }
  }

  return json({ error: "Method not allowed" }, 405);
};
