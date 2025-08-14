// api/gateway.js
// Minimal raw-forwarding gateway for Vercel
// - Forwards raw body + headers (including Content-Type with boundary)
// - Uses ORIGIN_URL intelligently (see README below)
// - Returns origin response bytes + headers unchanged

const DEFAULT_TIMEOUT = 15000;
const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awakiplayer.awaki.top/api_v34.php';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(DEFAULT_TIMEOUT), 10);
const ALLOWED_CLIENT_ORIGIN = process.env.ALLOWED_CLIENT_ORIGIN || '';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export const config = { api: { bodyParser: false } }; // Important for Next.js / Vercel to provide raw stream

export default async function handler(req, res) {
  // Optional CORS for testing
  if (ALLOWED_CLIENT_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_CLIENT_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  }
  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!ORIGIN_URL) {
    res.status(500).json({ error: 'ORIGIN_URL not configured' });
    return;
  }

  try {
    // compute target:
    const incomingPath = req.url || '/';
    let target;
    if (ORIGIN_URL.includes('{path}')) {
      target = ORIGIN_URL.replace('{path}', incomingPath);
    } else if (ORIGIN_URL.match(/\.\w{2,4}($|\?)/) || ORIGIN_URL.includes('?')) {
      // looks like a file endpoint (e.g., ends with .php, .php?..., .asp, .html)
      // Use exact origin URL (do not append incomingPath)
      target = ORIGIN_URL;
    } else {
      // append incoming path
      const base = ORIGIN_URL.replace(/\/$/, '');
      target = base + incomingPath;
    }

    // Read raw body
    const rawBody = await readRawBody(req);

    // Build forward headers: copy original except hop-by-hop and host/content-length
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'content-length') continue;
      if (lk === 'host') continue;
      // preserve content-type exactly (including boundary)
      forwardHeaders[k] = v;
    }

    // Add x-forwarded-for (append)
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    if (clientIp) forwardHeaders['x-forwarded-for'] = clientIp;

    // Logging for debugging (Vercel logs)
    console.log('Gateway -> target:', target);
    console.log('Gateway -> forwarded Content-Type:', forwardHeaders['content-type'] || forwardHeaders['Content-Type'] || 'none');

    // Forward request with raw buffer
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const originRes = await fetch(target, {
      method: (req.method || 'GET').toUpperCase(),
      headers: forwardHeaders,
      body: rawBody && rawBody.length ? rawBody : undefined,
      signal: controller.signal
    });

    clearTimeout(id);

    // copy status
    res.status(originRes.status);

    // copy headers (except hop-by-hop)
    originRes.headers.forEach((value, name) => {
      const ln = name.toLowerCase();
      if (HOP_BY_HOP.has(ln)) return;
      res.setHeader(name, value);
    });

    // handle HEAD
    if ((req.method || 'GET').toUpperCase() === 'HEAD') {
      res.end();
      return;
    }

    // stream / return raw bytes unchanged
    const ab = await originRes.arrayBuffer();
    res.send(Buffer.from(ab));

  } catch (err) {
    if (err && err.name === 'AbortError') {
      res.status(504).json({ error: 'gateway_timeout' });
    } else {
      console.error('gateway error:', err);
      res.status(502).json({ error: 'gateway_error', detail: String(err && err.message ? err.message : err) });
    }
  }
}
