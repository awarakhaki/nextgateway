// api/gateway.js
// Deploy this in your Vercel project under /api/gateway.js

const ORIGIN_URL = process.env.ORIGIN_URL || 'https://awaki.top/awakisoftsgateway.php';

module.exports = async (req, res) => {
  try {
    // Build body text
    let bodyText = '';
    if (req.body) {
      // req.body may be parsed by Vercel; try to get a string
      if (typeof req.body === 'string') bodyText = req.body;
      else bodyText = JSON.stringify(req.body);
    } else {
      // fallback to raw text
      bodyText = await req.text().catch(() => '');
    }

    // Forward to origin
    const target = ORIGIN_URL; // exact origin endpoint
    const fetchOptions = {
      method: req.method || 'GET',
      headers: {
        // Forward content-type if present
        'content-type': req.headers['content-type'] || 'application/json'
      },
      // omit body for GET/HEAD
      body: ['GET','HEAD'].includes((req.method||'GET').toUpperCase()) ? undefined : bodyText
    };

    const originRes = await fetch(target, fetchOptions);
    const respText = await originRes.text();

    // Return origin response back to client
    res.status(originRes.status);
    // copy limited headers (optional)
    res.setHeader('Content-Type', originRes.headers.get('content-type') || 'text/plain');
    res.send(respText);
  } catch (err) {
    console.error('gateway error', err);
    res.status(500).json({ error: 'gateway_error', detail: String(err.message || err) });
  }
};
