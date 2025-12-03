export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
}

type LinkRecord = {
  id: number;
  code: string;
  target_url: string;
  note: string | null;
  is_active: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
};

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });

const generateCode = (length = 7) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const random = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += alphabet[random[i] % alphabet.length];
  }
  return result;
};

const validateUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isAdminAuthorized = (request: Request, env: Env) => {
  const header = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || !header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  return token === env.ADMIN_TOKEN;
};

async function handleCreate(request: Request, env: Env) {
  let payload: { url?: string; note?: string };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const targetUrl = payload.url?.trim();
  const note = payload.note?.trim() ?? null;

  if (!targetUrl || !validateUrl(targetUrl)) {
    return json({ error: "A valid http/https URL is required" }, { status: 400 });
  }

  const code = generateCode();
  try {
    await env.DB.prepare(
      "INSERT INTO links (code, target_url, note) VALUES (?1, ?2, ?3)"
    )
      .bind(code, targetUrl, note)
      .run();
  } catch (error) {
    return json({ error: "Failed to store short link", details: String(error) }, { status: 500 });
  }

  return json({ code });
}

const ensureAdmin = (request: Request, env: Env) => {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
};

async function listLinks(url: URL, env: Env) {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
  const offset = (page - 1) * pageSize;

  const { results } = await env.DB.prepare(
    `SELECT * FROM links WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`
  )
    .bind(pageSize, offset)
    .all<LinkRecord>();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM links WHERE is_deleted = 0`
  ).first<{ total: number }>();

  return json({ data: results ?? [], page, pageSize, total: countRow?.total ?? 0 });
}

async function updateLink(request: Request, env: Env, id: number) {
  let payload: Partial<{ target_url: string; note: string | null; is_active: boolean }>;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (payload.target_url !== undefined) {
    if (!validateUrl(payload.target_url)) {
      return json({ error: "Invalid target_url" }, { status: 400 });
    }
    updates.push("target_url = ?");
    params.push(payload.target_url);
  }

  if (payload.note !== undefined) {
    updates.push("note = ?");
    params.push(payload.note);
  }

  if (payload.is_active !== undefined) {
    updates.push("is_active = ?");
    params.push(payload.is_active ? 1 : 0);
  }

  if (!updates.length) {
    return json({ error: "No fields to update" }, { status: 400 });
  }

  params.push(id);

  const statement = `UPDATE links SET ${updates.join(", ")} WHERE id = ? AND is_deleted = 0`;
  await env.DB.prepare(statement).bind(...params).run();

  const updated = await env.DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first<LinkRecord>();
  return json({ data: updated });
}

async function deleteLink(env: Env, id: number) {
  await env.DB.prepare("UPDATE links SET is_deleted = 1 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function redirect(code: string, env: Env) {
  const record = await env.DB.prepare(
    `SELECT target_url, is_active, is_deleted FROM links WHERE code = ?1`
  )
    .bind(code)
    .first<{ target_url: string; is_active: number; is_deleted: number }>();

  if (!record || record.is_deleted || !record.is_active) {
    return new Response("Short link not found", { status: 404 });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: record.target_url },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/api/health") {
      return json({ ok: true, timestamp: new Date().toISOString() });
    }

    if (pathname === "/api/create" && request.method === "POST") {
      return handleCreate(request, env);
    }

    if (pathname.startsWith("/api/admin")) {
      const unauthorized = ensureAdmin(request, env);
      if (unauthorized) return unauthorized;

      if (pathname === "/api/admin/links" && request.method === "GET") {
        return listLinks(url, env);
      }

      const idMatch = pathname.match(/\/api\/admin\/links\/(\d+)/);
      if (idMatch) {
        const id = Number(idMatch[1]);
        if (request.method === "PATCH") {
          return updateLink(request, env, id);
        }
        if (request.method === "DELETE") {
          return deleteLink(env, id);
        }
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    const codeMatch = pathname.match(/^\/(\w{4,32})$/);
    if (request.method === "GET" && codeMatch) {
      return redirect(codeMatch[1], env);
    }

    if (pathname === "/" && request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
