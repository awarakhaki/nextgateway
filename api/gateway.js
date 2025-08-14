// File: /api/mock.js

export default async function handler(req, res) {
  const targetUrl = 'https://awakiplayer.awaki.top/api_v34.php';

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Prepare headers
  const headers = {
    'User-Agent': 'okhttp/4.9.0',
    'Accept': '*/*',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // Convert request body to URL-encoded string
  const postData = new URLSearchParams(req.body).toString();

  try {
    // Forward request to target API
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: postData,
    });

    const responseBody = await response.text(); // Use .text() to handle any response format

    // Return response to Android app
    res.status(response.status).send(responseBody);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}
