const https = require("https");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod === "POST") {
    try {
      const data = JSON.parse(event.body || "{}");
      console.log("Received:", data);

      // 🔥 ALWAYS SEND EMAIL on any POST
      const body = JSON.stringify({
        service_id: "service_vavz75e",
        template_id: "template_y317gq5",
        user_id: "fwfVSV07CXWtpPxNb"
      });

      const req = https.request({
        hostname: "api.emailjs.com",
        path: "/api/v1.0/email/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      });

      req.write(body);
      req.end();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ test: "email triggered" })
      };

    } catch (e) {
      console.log("Error:", e);
      return { statusCode: 500, headers, body: "Error" };
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true })
  };
};

