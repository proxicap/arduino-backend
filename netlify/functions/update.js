let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false; // tracks last known state (per warm function instance)

const https = require("https");

function emailjsSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: "api.emailjs.com",
        path: "/api/v1.0/email/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // Arduino posts data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      const status = latestData?.status;
      const isFall = status === "Fall Alert!";

      // Send email ONLY when we transition into fall state
      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall;

      const now = Date.now();
      const COOLDOWN_MS = 30000;

      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
        lastEmailSentAt = now;

        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          accessToken: process.env.EMAILJS_PRIVATE_KEY,
        };

        try {
          const r = await emailjsSend(payload);
          console.log("EmailJS:", r.status, r.body);
        } catch (e) {
          console.log("EmailJS ERROR:", String(e));
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };
    } catch {
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // Website requests latest data
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(latestData),
    };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};


