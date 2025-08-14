// This file should be placed in the /api directory of your Vercel project.
// For example: /api/proxy.js
// Vercel will automatically create a serverless function for it.

export default async function handler(req, res) {
  // Target URL from your PHP script
  const targetUrl = 'https://awakiplayer.awaki.top/api_v34.php';

  // Prepare the headers, similar to the PHP script.
  // The 'User-Agent' and 'Accept' headers are set to match.
  // 'Content-Type' is also set for the outgoing request.
  const headers = {
    'User-Agent': 'okhttp/4.9.0',
    'Accept': '*/*',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // Prepare the body of the request.
  // This converts the incoming request body (req.body) into a URL-encoded string,
  // which is the equivalent of PHP's http_build_query($_POST).
  // Assumes the incoming request body is a JSON object.
  const body = new URLSearchParams(req.body).toString();

  try {
    // Make the request using the built-in fetch API, which is the modern
    // equivalent of PHP's cURL.
    const apiResponse = await fetch(targetUrl, {
      // Use the same request method (e.g., 'POST', 'GET') as the incoming request.
      // This corresponds to CURLOPT_CUSTOMREQUEST.
      method: req.method,

      // Set the headers for the outgoing request.
      // This corresponds to CURLOPT_HTTPHEADER.
      headers: headers,

      // Attach the URL-encoded body if the method is not 'GET' or 'HEAD'.
      // This corresponds to CURLOPT_POSTFIELDS.
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? body : undefined,
    });

    // Get the response body from the target URL as text.
    // This corresponds to curl_exec() and CURLOPT_RETURNTRANSFER.
    const responseData = await apiResponse.text();

    // Get the HTTP status code from the response.
    // This corresponds to curl_getinfo($ch, CURLINFO_HTTP_CODE).
    const responseStatus = apiResponse.status;
    
    // Forward the headers from the target response to the client.
    // This is more robust than hardcoding the Content-Type.
    apiResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });

    // Set the HTTP response status code to match the one from the target URL.
    // This corresponds to http_response_code($httpCode).
    res.status(responseStatus);

    // Send the response data back to the original client (e.g., your Android app).
    // This corresponds to echo $response.
    res.send(responseData);

  } catch (error) {
    // Handle any network errors or issues with the fetch call.
    console.error('Proxy Error:', error);
    res.status(500).json({ error: 'An error occurred while proxying the request.' });
  }
}
