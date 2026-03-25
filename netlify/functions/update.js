// ================================================================
// GLOBAL STATE & CACHE VARIABLES
// ================================================================
let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false;

// --- FALL TIME STATE ---
let latestFallTime = null;
let lastRecordedFallTime = null;

// --- CACHE VARIABLES ---
let cachedAddress = "Waiting for GPS...";
let lastGeocodeLat = 0;
let lastGeocodeLon = 0;

const https = require("https");

// ================================================================
// TIME FORMATTER (EDMONTON TIME)
// ================================================================
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
  }).replace(",", "                ");
}

// ================================================================
// EMAILJS HELPER
// ================================================================
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

// ================================================================
// ADDRESS HELPER
// ================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    const req = https.request(
      {
        hostname: "nominatim.openstreetmap.org",
        path: `/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`,
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
              let shortName = "Unknown Location";

              if (parsed.address) {
                const a = parsed.address;
                shortName =
                  a.amenity ||
                  a.mall ||
                  a.university ||
                  a.college ||
                  a.building ||
                  a.shop ||
                  a.hospital ||
                  a.leisure ||
                  a.office;

                if (!shortName) {
                  if (a.house_number && a.road) {
                    shortName = `${a.house_number} ${a.road}`;
                  } else if (a.road) {
                    shortName = a.road;
                  } else if (parsed.display_name) {
                    shortName = parsed.display_name.split(",")[0].trim();
                  }
                }
              } else if (parsed.display_name) {
                shortName = parsed.display_name.split(",")[0].trim();
              }

              cachedAddress = shortName;
              lastGeocodeLat = lat;
              lastGeocodeLon = lon;

              resolve(cachedAddress);
            } catch {
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

// ================================================================
// MAIN HANDLER
// ================================================================
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

      const streetAddress = await getAddress(lat, lon);
      latestData.address = streetAddress;

      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall;

      const now = Date.now();
      const COOLDOWN_MS = 30000;

      // --- RECORD FALL TIME ---
      if (fallRisingEdge) {
        const formatted = formatTime(now);
        latestFallTime = formatted;
        lastRecordedFallTime = formatted;
      }

      // --- ATTACH TO DATA ---
      latestData.fallTime = isFall ? latestFallTime : null;
      latestData.lastFallTime = lastRecordedFallTime;

      // --- EMAIL ---
      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
        lastEmailSentAt = now;

        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          accessToken: process.env.EMAILJS_PRIVATE_KEY,
          template_params: {
            address: streetAddress,
            lat: lat,
            lon: lon,
            fall_time: latestFallTime,
          }
        };

        try {
          await emailjsSend(payload);
        } catch (e) {
          console.log("Email error:", e);
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

  // ================= GET =================
  if (event.httpMethod === "GET") {
    let displayData = { ...latestData };

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
