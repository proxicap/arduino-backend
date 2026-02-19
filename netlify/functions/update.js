let latestData = {};
let lastEmailSentAt = 0;

const https = require("https");

function sendEmailJS() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      service_id: "service_vavz75e",
      template_id: "template_y317gq5",
      user_id: "fwfVSV07CXWtpPxNb",
    });

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

  // Arduino sends data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      // Send email on fall (cooldown 30s)
      const isFall = latestData.status === "Fall Alert!";
      const now = Date.now();
      const COOLDOWN_MS = 30000;

      if (isFall && now - lastEmailSentAt > COOLDOWN_MS) {
        lastEmailSentAt = now;
        const r = await sendEmailJS();
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

