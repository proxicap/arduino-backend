// ================= GLOBAL STATE =================
let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false;

let latestFallTime = null;
let lastRecordedFallTime = null;

const https = require("https");

// ================= TIME FORMAT =================
function formatTime(ts) {
  const d = new Date(ts);

  return d.toLocaleString("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).replace(",", " | ");
}

// ================= EMAIL =================
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

// ================= MAIN HANDLER =================
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // ================= POST =================
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      const status = latestData?.status;
      const isFall = status === "Fall Alert!";

      const lat = latestData?.lat;
      const lon = latestData?.lon;

      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall;

      const now = Date.now();
      const COOLDOWN_MS = 30000;

      if (fallRisingEdge) {
        const formatted = formatTime(now);
        latestFallTime = formatted;
        lastRecordedFallTime = formatted;
      }

      latestData.fallTime = isFall ? latestFallTime : null;
      latestData.lastFallTime = lastRecordedFallTime;

      // ================= EMAIL =================
      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          accessToken: process.env.EMAILJS_PRIVATE_KEY,
          template_params: {
            lat: lat,
            lon: lon,
            fall_time: latestFallTime,
          }
        };

        try {
          const result = await emailjsSend(payload);
          console.log("EmailJS response:", result.status, result.body);

          lastEmailSentAt = now;

          if (result.status < 200 || result.status >= 300) {
            throw new Error(`EmailJS failed: ${result.status}`);
          }
        } catch (e) {
          lastEmailSentAt = now;
          console.log("Email error:", e);
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };

    } catch (e) {
      console.log("POST error:", e);
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // ================= GET =================
  if (event.httpMethod === "GET") {
    const displayData = { ...latestData };

    displayData.fallTime = latestFallTime;
    displayData.lastFallTime = lastRecordedFallTime;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(displayData),
    };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
