// /api/otp.js
// Vercel Serverless Function — calls Deriv's OTP endpoint using the
// access_token to get an authenticated WebSocket URL for trading.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { account_id, access_token, app_id } = req.body || {};

  if (!account_id || !access_token) {
    return res.status(400).json({ error: "Missing account_id or access_token" });
  }

  try {
    const derivRes = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${account_id}/otp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
          "Deriv-App-ID": app_id || "1089",
        },
      }
    );

    const data = await derivRes.json();

    if (!derivRes.ok) {
      return res.status(derivRes.status).json({ error: "OTP fetch failed", details: data });
    }

    return res.status(200).json(data); // { ws_url, ... }
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err.message });
  }
}
