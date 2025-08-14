// api/gateway.js
const TARGET_URL = process.env.ORIGIN_URL || 'https://awakiplayer.awaki.top/api_v34.php';

export default async function handler(req, res) {
  try {
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

    const originRes = await fetch(TARGET_URL, {
      method: req.method,
      headers: {
        ...req.headers,
        host: undefined, // avoid passing original host
      },
      body,
    });

    res.status(originRes.status);
    originRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const buffer = await originRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(err.message);
  }
}
