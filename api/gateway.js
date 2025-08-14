// api/gateway.js
// For Vercel: forward raw body for ANY content-type (including multipart/form-data)
// Set ORIGIN_URL in Vercel env to: https://awaki.top/awakisoftsgateway.php

const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awaki.top/awakisoftsgateway.php';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '15000', 10);

// Required hop-by-hop headers we must not forward
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

// read raw body from Node request
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export default async function handler(req, res) {
  try {
    if (!ORIGIN_URL) {
      res.status(500).json({ error: 'ORIGIN_URL not configured' });
      return;
    }

    // Disable automatic body parsing in Next.js API routes by adding:
    // export const config = { api: { bodyParser: false } }; (if using Next)
    const rawBody = await readRawBody(req); // raw Buffer, exact bytes sent by client

    // Build forward headers by copying original headers but removing hop-by-hop and host
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'content-length') continue; // fetch sets this
      if (lk === 'host') continue;
      // Important: keep content-type (including boundary if multipart/form-data)
      forwardHeaders[k] = v;
    }

    // Build target URL: append incoming path+query if you want dynamic routing
    // If you want to always call the single PHP file, keep ORIGIN_URL as full path
    const incomingPath = req.url || '/';
    const target = ORIGIN_URL.includes('{path}')
      ? ORIGIN_URL.replace('{path}', incomingPath)
      : ORIGIN_URL.endsWith('/') ? (ORIGIN_URL.slice(0, -1) + incomingPath) : (ORIGIN_URL + incomingPath);

    // Forward request (buffer body)
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const originRes = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: rawBody && rawBody.length ? rawBody : undefined,
      signal: controller.signal
    });
    clearTimeout(id);

    // Copy status and headers (except hop-by-hop)
    res.status(originRes.status);
    originRes.headers.forEach((value, name) => {
      const ln = name.toLowerCase();
      if (HOP_BY_HOP.has(ln)) return;
      // optionally skip cookies: if (ln === 'set-cookie') return;
      res.setHeader(name, value);
    });

    // Send back exact bytes from origin
    const ab = await originRes.arrayBuffer();
    res.send(Buffer.from(ab));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      res.status(504).json({ error: 'gateway_timeout' });
    } else {
      console.error('gateway error', err);
      res.status(502).json({ error: 'gateway_error', detail: String(err && err.message ? err.message : err) });
    }
  }
}
