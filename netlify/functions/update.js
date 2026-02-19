let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false;

// --- CACHE VARIABLES ---
let cachedAddress = "Waiting for GPS...";
let lastGeocodeLat = 0;
let lastGeocodeLon = 0;

const https = require("https");

function emailjsSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
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

function getAddress(lat, lon) {
  return new Promise((resolve) => {
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    // --- THE FREE TIER PROTECTOR ---
    // Calculate how far you moved. 0.0005 degrees is roughly 50 meters.
    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    // If you haven't moved more than 50 meters, DO NOT ping the API.
    // Just return the address we already saved in memory.
    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    console.log("Moved significantly. Asking OpenStreetMap for new address...");

    const req = https.request({
        hostname: "nominatim.openstreetmap.org",
        path: `/reverse?format=json&lat=${lat}&lon=${lon}`,
        method: "GET",
        headers: { "User-Agent": "ProxiCap-Wearable/1.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              
              // Update our Cache with the new location!
              cachedAddress = parsed.display_name || "Unknown Location";
              lastGeocodeLat = lat;
              lastGeocodeLon = lon;
              
              resolve(cachedAddress);
            } catch (e) {
              resolve("Address Parsing Error");
            }
          } else {
            resolve("Geocoding API Limit Reached");
          }
        });
      }
    );

    req.on("error", () => resolve("Network Error getting address"));
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");
      const status = latestData?.status;
      const isFall = status === "Fall Alert!";
      const lat = latestData?.lat;
      const lon = latestData?.lon;

      // This will now instantly return the cached address 99% of the time,
      // keeping your Netlify function blazing fast and API-friendly.
      const streetAddress = await getAddress(lat, lon);
      latestData.address = streetAddress;

      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall;
      const now = Date.now();

      if (fallRisingEdge && (now - lastEmailSentAt > 30000)) {
        lastEmailSentAt = now;
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          template_params: { address: streetAddress, lat: lat, lon: lon }
        };
        try {
          const r = await emailjsSend(payload);
          console.log("EmailJS:", r.status, r.body);
        } catch (e) {
          console.log("EmailJS ERROR:", String(e));
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ status: "ok" }) };
    } catch {
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers, body: JSON.stringify(latestData) };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
