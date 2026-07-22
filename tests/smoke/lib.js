// Cliente HTTP mínimo con cookie jar por "actor" (teacher, student, admin, superadmin...).
// Sin dependencias: usa el fetch global de Node. redirect:'manual' para poder verificar
// 302 (sesión inválida/expirada) sin que fetch los siga automáticamente.
class SmokeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jars = new Map(); // actor -> Map(cookieName -> value)
  }

  _jar(actor) {
    if (!this.jars.has(actor)) this.jars.set(actor, new Map());
    return this.jars.get(actor);
  }

  _cookieHeader(actor) {
    if (!actor) return '';
    return [...this._jar(actor).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _storeCookies(actor, res) {
    if (!actor) return;
    const jar = this._jar(actor);
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    raw.forEach(line => {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    });
  }

  async request(actor, method, path, { body, form, headers = {}, expectStatus } = {}) {
    // Serialización: `body` = JSON; `form` = FormData multipart (para probar /upload-*)
    let payload, contentType;
    if (form !== undefined) {
      payload = form;
      contentType = undefined; // fetch setea el boundary correcto solo si NO le mandamos Content-Type
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      contentType = 'application/json';
    }

    const res = await fetch(this.baseUrl + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(actor ? { Cookie: this._cookieHeader(actor) } : {}),
        ...headers,
      },
      body: payload,
    });
    this._storeCookies(actor, res);

    let json = null, text = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { json = await res.json(); } catch {}
    } else {
      try { text = await res.text(); } catch {}
    }

    if (expectStatus !== undefined) {
      const ok = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === expectStatus;
      if (!ok) {
        const detail = json ? JSON.stringify(json) : (text || '').slice(0, 200);
        throw new Error(`${method} ${path} → esperaba ${expectStatus}, recibió ${res.status}${detail ? ' — ' + detail : ''}`);
      }
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  get(actor, path, opts)    { return this.request(actor, 'GET', path, opts); }
  post(actor, path, opts)   { return this.request(actor, 'POST', path, opts); }
  put(actor, path, opts)    { return this.request(actor, 'PUT', path, opts); }
  patch(actor, path, opts)  { return this.request(actor, 'PATCH', path, opts); }
  delete(actor, path, opts) { return this.request(actor, 'DELETE', path, opts); }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

module.exports = { SmokeClient, assert };
