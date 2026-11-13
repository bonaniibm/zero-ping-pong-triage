// Minimal Dataverse Web API client using the client-credentials flow.
// No SDK dependency: Node 20+ ships fetch.

const tokenCache = new Map();

function credsFromEnv(prefix) {
  const creds = {
    url: (process.env.DATAVERSE_URL || '').replace(/\/+$/, ''),
    tenantId: process.env.DATAVERSE_TENANT_ID,
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`],
  };
  for (const [k, v] of Object.entries(creds)) {
    if (!v) throw new Error(`Missing Dataverse setting for ${prefix}: ${k}`);
  }
  return creds;
}

async function getToken(creds) {
  const key = `${creds.tenantId}|${creds.clientId}|${creds.url}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: `${creds.url}/.default`,
  });
  const res = await fetch(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Entra token request failed (${res.status}): ${json.error || ''} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.entraError = json.error;
    throw err;
  }
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

class DataverseError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DataverseError';
    Object.assign(this, details);
  }
}

function client(prefix) {
  const creds = credsFromEnv(prefix);

  async function request(method, path, body, extraHeaders = {}) {
    const token = await getToken(creds);
    const res = await fetch(`${creds.url}/api/data/v9.2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'odata-version': '4.0',
        'odata-maxversion': '4.0',
        prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const requestId = res.headers.get('x-ms-service-request-id') || res.headers.get('req_id');
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new DataverseError(
        `Dataverse ${method} ${path.split('?')[0]} failed (${res.status}): ${json?.error?.message || text.slice(0, 300)}`,
        {
          status: res.status,
          dataverseRequestId: requestId,
          dataverseErrorCode: json?.error?.code,
          retryAfter: res.headers.get('retry-after'),
        },
      );
    }
    return { json, requestId, entityId: res.headers.get('odata-entityid') };
  }

  return {
    url: creds.url,
    get: async (path) => (await request('GET', path)).json,
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

module.exports = { client, DataverseError };
