// api/gateway.js
const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awakiplayer.awaki.top/api_v34.php';

export default async function handler(req, res) {
  try {
    // Convert body if present
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const originRes = await fetch(ORIGIN_URL, {
      method: req.method,
      headers: { ...req.headers, host: undefined }, // remove host header
      body,
    });

    // Copy original content type
    res.status(originRes.status);
    originRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const buffer = await originRes.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    res.status(500).json({ error: 'gateway_error', detail: err.message });
  }
}
