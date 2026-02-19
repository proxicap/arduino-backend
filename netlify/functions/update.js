let latestData = {};
let lastEmailSentAt = 0;

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
        res.on("data", (chunk) => (data += chunk));
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
  };

  // Arduino sends data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      // Only email on fall alert + cooldown
      const isFall = latestData && latestData.status === "Fall Alert!";
      const now = Date.now();
      const COOLDOWN_MS = 30_000;

      if (isFall && now - lastEmailSentAt > COOLDOWN_MS) {
        lastEmailSentAt = now;

        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb", // EmailJS public key (user_id)
          // template_params: { ... } // optional
        };

        const r = await emailjsSend(payload);
        console.log("EmailJS:", r.status, r.body);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };
    } catch (e) {
      console.log("Invalid JSON:", e);
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // Webpage requests data
  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers, body: JSON.stringify(latestData) };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
