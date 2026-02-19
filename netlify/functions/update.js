let latestData = {};
let lastEmailSentAt = 0;

let emailDebug = {
  tried: false,
  ok: false,
  status: null,
  body: null,
  at: null,
  reason: null,
};

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // Arduino sends data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      const status = latestData?.status;
      const isFall = status === "Fall Alert!";

      const now = Date.now();
      const COOLDOWN_MS = 30000;

      if (isFall && (now - lastEmailSentAt > COOLDOWN_MS)) {
        lastEmailSentAt = now;

        emailDebug = {
          tried: true,
          ok: false,
          status: null,
          body: null,
          at: new Date().toISOString(),
          reason: `status==${status}`,
        };

        // ✅ YOUR EmailJS payload
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          // If your template uses variables, uncomment and customize:
          // template_params: {
          //   status: latestData.status,
          //   tiltX: latestData.tiltX,
          //   tiltZ: latestData.tiltZ,
          //   lat: latestData.lat,
          //   lon: latestData.lon,
          //   time: latestData.time,
          // },
        };

        // ✅ IMPORTANT: wait for EmailJS to finish
        const r = await emailjsSend(payload);

        emailDebug.ok = (r.status === 200);
        emailDebug.status = r.status;
        emailDebug.body = r.body;

        console.log("EmailJS:", r.status, r.body);
      } else {
        emailDebug = {
          tried: false,
          ok: false,
          status: null,
          body: null,
          at: new Date().toISOString(),
          reason: isFall ? "cooldown" : `status_not_fall (${status})`,
        };
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
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...latestData, _email: emailDebug }),
    };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};

