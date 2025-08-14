// api/gateway.js
// Vercel gateway: forward request to ORIGIN_URL and return the exact origin response (status, headers, raw body).
// - No JSON wrapping, no body parsing/encoding.
// - Removes hop-by-hop headers (required by HTTP spec).
// - Supports all HTTP methods and binary responses.
// Env:
//   ORIGIN_URL            - base origin URL (e.g. https://awaki.top/awakisoftsgateway.php)
//                          If it contains "{path}" it will be replaced with req.url (path+query).
//                          Otherwise req.url is appended to ORIGIN_URL.
//   TIMEOUT_MS (optional) - upstream fetch timeout in ms (default 10000)
//   ALLOWED_CLIENT_ORIGIN (optional) - if set, adds Access-Control-Allow-Origin CORS header for responses

const DEFAULT_TIMEOUT = 10000;
const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awakiplayer.awaki.top/api_v34.php';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(DEFAULT_TIMEOUT), 10);
const ALLOWED_CLIENT_ORIGIN = process.env.ALLOWED_CLIENT_ORIGIN || '';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

module.exports = async (req, res) => {
  // Quick CORS preflight handling (if configured)
  if (ALLOWED_CLIENT_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_CLIENT_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Timestamp, X-Nonce');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!ORIGIN_URL) {
    res.status(500).json({ ok: false, error: 'gateway_misconfigured', detail: 'ORIGIN_URL not set' });
    return;
  }

  // Build the target URL
  const incomingPath = req.url || '/';
  let target;
  if (ORIGIN_URL.includes('{path}')) {
    target = ORIGIN_URL.replace('{path}', incomingPath);
  } else {
    const base = ORIGIN_URL.replace(/\/$/, '');
    target = base + incomingPath;
  }

  // Copy request headers except hop-by-hop and content-length (fetch sets it)
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const ln = k.toLowerCase();
    if (HOP_BY_HOP.has(ln)) continue;
    if (ln === 'content-length') continue;
    forwardHeaders[k] = v;
  }

  // Preserve X-Forwarded-For (append if exists)
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  if (clientIp) forwardHeaders['x-forwarded-for'] = clientIp;

  // Read request body robustly (supports parsed object, string, buffer or raw)
  let bodyBuf = undefined;
  try {
    if (req.body === undefined || req.body === null) {
      // try to obtain raw text/arrayBuffer via request helpers
      if (typeof req.text === 'function') {
        const txt = await req.text().catch(() => '');
        if (txt) bodyBuf = Buffer.from(txt, 'utf8');
      } else if (typeof req.arrayBuffer === 'function') {
        const ab = await req.arrayBuffer().catch(() => null);
        if (ab) bodyBuf = Buffer.from(ab);
      } else {
        // no body
        bodyBuf = undefined;
      }
    } else if (typeof req.body === 'string') {
      bodyBuf = Buffer.from(req.body, 'utf8');
    } else if (Buffer.isBuffer(req.body)) {
      bodyBuf = req.body;
    } else {
      // parsed object (likely JSON)
      bodyBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
      if (!forwardHeaders['content-type']) forwardHeaders['content-type'] = 'application/json';
    }
  } catch (e) {
    console.error('read body error', e);
    bodyBuf = undefined;
  }

  // Prepare fetch options
  const method = (req.method || 'GET').toUpperCase();
  const fetchOptions = {
    method,
    headers: forwardHeaders,
    body: ['GET', 'HEAD'].includes(method) ? undefined : bodyBuf,
  };

  // Timeout support via AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  fetchOptions.signal = controller.signal;

  try {
    const originRes = await fetch(target, fetchOptions);
    clearTimeout(timeoutId);

    // Copy status
    res.status(originRes.status);

    // Copy response headers except hop-by-hop
    originRes.headers.forEach((value, name) => {
      const ln = name.toLowerCase();
      if (HOP_BY_HOP.has(ln)) return;
      // Optionally skip `set-cookie` if you don't want cookies forwarded:
      // if (ln === 'set-cookie') return;
      // Set header as received
      res.setHeader(name, value);
    });

    // If we want to keep CORS header present for client, ensure we keep or set it
    if (ALLOWED_CLIENT_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_CLIENT_ORIGIN);
    }

    // For HEAD requests: do not send body
    if (method === 'HEAD') {
      res.end();
      return;
    }

    // Read raw body from origin and pipe back as-is
    const arrayBuffer = await originRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    // Send the exact bytes
    res.send(buffer);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      res.status(504).json({ ok: false, error: 'gateway_timeout', detail: `upstream timeout ${TIMEOUT_MS}ms` });
    } else {
      console.error('gateway error', err);
      res.status(502).json({ ok: false, error: 'gateway_error', detail: String(err && err.message ? err.message : err) });
    }
  }
};
