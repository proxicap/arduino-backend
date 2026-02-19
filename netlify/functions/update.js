let latestData = {};
let lastEmailSentAt = 0; // simple cooldown (per warm function instance)

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Arduino sends data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      // ---- EMAIL TRIGGER (server-side) ----
      // Send only when status is Fall Alert!, with a cooldown to prevent spam
      const isFall = latestData && latestData.status === "Fall Alert!";
      const now = Date.now();
      const COOLDOWN_MS = 30_000; // 30 seconds

      if (isFall && (now - lastEmailSentAt > COOLDOWN_MS)) {
        lastEmailSentAt = now;

        // Node 18+ on Netlify usually has global fetch available.
        const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_id: "service_vavz75e",
            template_id: "template_y317gq5",
            user_id: "fwfVSV07CXWtpPxNb",

            // OPTIONAL: if your EmailJS template uses variables, uncomment:
            // template_params: {
            //   status: latestData.status,
            //   tiltX: latestData.tiltX,
            //   tiltZ: latestData.tiltZ,
            //   lat: latestData.lat,
            //   lon: latestData.lon,
            //   time: latestData.time,
            // },
          }),
        });

        const text = await res.text();
        console.log("EmailJS response:", res.status, text);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };
    } catch (e) {
      console.log("Invalid JSON:", e);
      return {
        statusCode: 400,
        headers,
        body: "Invalid JSON",
      };
    }
  }

  // Webpage requests data
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(latestData),
    };
  }

  return {
    statusCode: 405,
    headers,
    body: "Method Not Allowed",
  };
};
