// /api/token.js
// Vercel Serverless Function — exchanges the OAuth authorization code
// for an access_token. Runs on the SERVER, never in the browser,
// so the exchange is safe even though Deriv's flow is public-client PKCE.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, code_verifier, redirect_uri, client_id } = req.body || {};

  if (!code || !code_verifier || !redirect_uri || !client_id) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      code,
      code_verifier,
      redirect_uri,
    });

    const derivRes = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await derivRes.json();

    if (!derivRes.ok) {
      return res.status(derivRes.status).json({ error: data.error || "Token exchange failed", details: data });
    }

    // data: { access_token, expires_in, token_type }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err.message });
  }
}
