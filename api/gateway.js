// api/gateway.js
// Vercel gateway: accept any incoming body/content-type and forward it to ORIGIN_URL
// Return the origin response bytes and headers unchanged (except hop-by-hop headers).
//
// Env:
//   ORIGIN_URL            - full origin URL or base URL (e.g. https://awaki.top/awakisoftsgateway.php)
//   TIMEOUT_MS (opt)      - upstream timeout in ms (default 10000)
//   ALLOWED_CLIENT_ORIGIN (opt) - CORS allow origin for debugging (optional)

const DEFAULT_TIMEOUT = 10000;
const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awaki.top/awakisoftsgateway.php';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(DEFAULT_TIMEOUT), 10);
const ALLOWED_CLIENT_ORIGIN = process.env.ALLOWED_CLIENT_ORIGIN || '';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

// Read raw request body from Node IncomingMessage into Buffer
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      // If body already provided by platform as Buffer/string/object, prefer that (handled higher)
      const chunks = [];
      // If request has readableEnded true (body consumed), return empty buffer
      if (req.readableEnded && typeof req.body === 'undefined') {
        return resolve(Buffer.alloc(0));
      }

      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', (err) => reject(err));
      // In case no data comes, also resolve on next tick (safety)
      // (not usually needed)
    } catch (err) {
      reject(err);
    }
  });
}

export default async function handler(req, res) {
  // Optional CORS helper for debugging
  if (ALLOWED_CLIENT_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_CLIENT_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
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

  try {
    // Determine target URL:
    // If ORIGIN_URL contains '{path}' substitute req.url (path+query),
    // otherwise append req.url to ORIGIN_URL (take care of trailing slash).
    const incomingPath = req.url || '/';
    let target;
    if (ORIGIN_URL.includes('{path}')) {
      target = ORIGIN_URL.replace('{path}', incomingPath);
    } else {
      const base = ORIGIN_URL.replace(/\/$/, '');
      target = base + incomingPath;
    }

    // Build forward headers: copy incoming headers except hop-by-hop and content-length/host
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const ln = k.toLowerCase();
      if (HOP_BY_HOP.has(ln)) continue;
      if (ln === 'content-length') continue; // let fetch set it
      if (ln === 'host') continue;
      forwardHeaders[k] = v;
    }

    // If client provided a content-type and platform parsed req.body into an object,
    // we still prefer to send the original bytes. Attempt to grab raw body first.
    let bodyBuf;
    // If platform attached a raw body Buffer (some frameworks do), use it
    if (Buffer.isBuffer(req.body)) {
      bodyBuf = req.body;
    } else if (typeof req.body === 'string') {
      bodyBuf = Buffer.from(req.body, 'utf8');
    } else {
      // Try to read raw stream (works in serverless Node)
      bodyBuf = await readRawBody(req);
      // If still empty but req.body is an object (parsed JSON or form),
      // serialize it as the client would have sent (best-effort):
      if ((!bodyBuf || bodyBuf.length === 0) && req.body && typeof req.body === 'object') {
        // Use original content-type to decide encoding
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/x-www-form-urlencoded')) {
          // URL-encode object
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(req.body)) {
            params.append(k, String(v));
          }
          bodyBuf = Buffer.from(params.toString(), 'utf8');
        } else if (ct.includes('application/json') || typeof req.body === 'object') {
          bodyBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
          if (!forwardHeaders['content-type']) forwardHeaders['content-type'] = 'application/json';
        } else {
          // Fallback: best-effort serialization
          bodyBuf = Buffer.from(String(req.body), 'utf8');
        }
      }
    }

    // Prepare fetch options
    const method = (req.method || 'GET').toUpperCase();
    const fetchOptions = {
      method,
      headers: forwardHeaders,
      // only include body for methods that allow it
      body: ['GET', 'HEAD'].includes(method) ? undefined : (bodyBuf && bodyBuf.length ? bodyBuf : undefined)
    };

    // Timeout via AbortController
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    fetchOptions.signal = controller.signal;

    // Perform fetch to origin
    const originRes = await fetch(target, fetchOptions);
    clearTimeout(id);

    // Copy status
    res.status(originRes.status);

    // Copy origin headers (except hop-by-hop). Preserve content-encoding, content-type, set-cookie, etc.
    originRes.headers.forEach((value, name) => {
      const ln = name.toLowerCase();
      if (HOP_BY_HOP.has(ln)) return;
      // If you want to hide cookies, skip set-cookie here
      res.setHeader(name, value);
    });

    // For HEAD requests, end without body
    if (method === 'HEAD') {
      res.end();
      return;
    }

    // Stream / pipe the origin response bytes back unchanged
    const ab = await originRes.arrayBuffer();
    const buffer = Buffer.from(ab);
    res.send(buffer);
  } catch (err) {
    // Timeout or other error
    if (err && err.name === 'AbortError') {
      res.status(504).json({ ok: false, error: 'gateway_timeout', detail: `upstream timeout ${TIMEOUT_MS}ms` });
    } else {
      console.error('gateway error', err);
      res.status(502).json({ ok: false, error: 'gateway_error', detail: String(err && err.message ? err.message : err) });
    }
  }
}
