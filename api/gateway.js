// File: /api/mock.js

import querystring from 'querystring';

export const config = {
  api: {
    bodyParser: false, // Disable automatic body parsing
  },
};

export default async function handler(req, res) {
  const targetUrl = 'https://awakiplayer.awaki.top/api_v34.php';

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Read raw body stream
    let rawBody = '';
    await new Promise((resolve, reject) => {
      req.on('data', chunk => {
        rawBody += chunk;
      });
      req.on('end', resolve);
      req.on('error', reject);
    });

    // Forward to target API
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'okhttp/4.9.0',
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: rawBody,
    });

    const responseBody = await response.text();
    res.status(response.status).send(responseBody);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}
