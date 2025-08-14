// api/gateway.js
// Vercel gateway that forwards any request to ORIGIN_URL and always returns JSON.
//
// Env vars:
//   ORIGIN_URL            - base origin URL (e.g. https://awaki.top/awakisoftsgateway.php)
//                          If it contains "{path}" the request path+query will replace it.
//                          Otherwise the gateway will append req.url to ORIGIN_URL.
//   TIMEOUT_MS (optional) - fetch timeout in ms (default 10000)
//   ALLOWED_CLIENT_ORIGIN (optional) - value for Access-Control-Allow-Origin header

const DEFAULT_TIMEOUT = 10000;

const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awakiplayer.awaki.top/api_v34.php';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(DEFAULT_TIMEOUT), 10);
const ALLOWED_CLIENT_ORIGIN = process.env.ALLOWED_CLIENT_ORIGIN || '';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function bufferToUtf8OrBase64(buf) {
  try {
    // Try decode as UTF-8 string
    const text = Buffer.from(buf).toString('utf8');
    return { text, isBinary: false };
  } catch (e) {
    // Fallback base64
    return { text: Buffer.from(buf).toString('base64'), isBinary: true };
  }
}

module.exports = async (req, res) => {
  // CORS (optional)
  if (ALLOWED_CLIENT_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_CLIENT_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Timestamp, X-Nonce');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle preflight quickly
  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // validate ORIGIN_URL
  if (!ORIGIN_URL) {
    res.status(500).json({ ok: false, error: 'gateway_misconfigured', detail: 'ORIGIN_URL not set' });
    return;
  }

  // Compute target URL:
  // - if ORIGIN_URL contains "{path}" replace it with req.url (path+query)
  // - otherwise append req.url to ORIGIN_URL (taking care of slashes)
  const incomingPath = req.url || '/';
  let target;
  if (ORIGIN_URL.includes('{path}')) {
    target = ORIGIN_URL.replace('{path}', incomingPath);
  } else {
    const base = ORIGIN_URL.replace(/\/$/, '');
    // if incomingPath begins with /, append directly
    target = base + incomingPath;
  }

  // Build forward headers: copy request headers except hop-by-hop and host
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const ln = k.toLowerCase();
    if (HOP_BY_HOP.has(ln)) continue;
    // Avoid sending `content-length` - fetch will set it
    if (ln === 'content-length') continue;
    // Forward other headers as-is
    forwardHeaders[k] = v;
  }
  // Add an X-Forwarded-For header (preserve if present)
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  if (clientIp) {
    forwardHeaders['x-forwarded-for'] = clientIp;
  }

  // Read incoming body robustly (string, buffer, parsed object)
  let bodyBuf = null;
  try {
    if (req.body === undefined || req.body === null) {
      // try to get raw text/arrayBuffer
      if (typeof req.text === 'function') {
        const txt = await req.text().catch(() => '');
        bodyBuf = txt ? Buffer.from(txt, 'utf8') : null;
      } else if (typeof req.arrayBuffer === 'function') {
        const ab = await req.arrayBuffer().catch(() => null);
        bodyBuf = ab ? Buffer.from(ab) : null;
      } else {
        bodyBuf = null;
      }
    } else if (typeof req.body === 'string') {
      bodyBuf = Buffer.from(req.body, 'utf8');
    } else if (Buffer.isBuffer(req.body)) {
      bodyBuf = req.body;
    } else {
      // object (likely parsed JSON)
      bodyBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
      // ensure content-type header is set if missing
      if (!forwardHeaders['content-type']) forwardHeaders['content-type'] = 'application/json';
    }
  } catch (e) {
    console.error('failed to read incoming body', e);
    bodyBuf = null;
  }

  // Prepare fetch options
  const method = (req.method || 'GET').toUpperCase();
  const fetchOptions = {
    method,
    headers: forwardHeaders,
    // body only for methods that allow it
    body: ['GET', 'HEAD'].includes(method) ? undefined : bodyBuf
  };

  // AbortController for timeout
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  fetchOptions.signal = controller.signal;

  try {
    const originRes = await fetch(target, fetchOptions);
    clearTimeout(id);

    // Read response body as arrayBuffer then convert
    const arrayBuffer = await originRes.arrayBuffer();
    const respBuf = Buffer.from(arrayBuffer);

    // Try parse JSON from origin response; if not JSON, wrap safely
    const text = respBuf.toString('utf8');
    const parsed = safeJsonParse(text);

    // Build consistent JSON response to client
    const responsePayload = {
      ok: originRes.ok,
      status: originRes.status,
      // If origin returned JSON, forward it as `body_json`
      body_json: parsed !== null ? parsed : undefined,
      // If origin returned non-json, return it as string (or base64 if binary)
      body_text: parsed === null ? text : undefined,
      // include selected origin headers (non-sensitive) if you want:
      headers: (() => {
        const out = {};
        for (const [k, v] of originRes.headers.entries()) {
          const lk = k.toLowerCase();
          // skip hop-by-hop and binary unsafe headers
          if (HOP_BY_HOP.has(lk)) continue;
          out[k] = v;
        }
        return out;
      })()
    };

    // Always return application/json
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(parsed));
  } catch (err) {
    clearTimeout(id);
    // Distinguish timeout abort
    if (err.name === 'AbortError') {
      res.status(504).json({ ok: false, error: 'gateway_timeout', detail: `upstream timeout ${TIMEOUT_MS}ms` });
    } else {
      console.error('gateway error', err);
      res.status(502).json({ ok: false, error: 'gateway_error', detail: String(err && err.message ? err.message : err) });
    }
  }
};
