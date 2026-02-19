let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false; // tracks last known state

// --- CACHE VARIABLES (Protects from API Bans) ---
let cachedAddress = "Waiting for GPS...";
let lastGeocodeLat = 0;
let lastGeocodeLon = 0;

const https = require("https");

// ================================================================
// 1. EMAILJS HELPER (Your proven working version)
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
// 2. SMART ADDRESS HELPER (Kingsway Mall / NAIT extractor)
// ================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    // --- FREE TIER PROTECTOR ---
    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    console.log("Moved significantly. Asking OpenStreetMap for new address...");

    const req = https.request({
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

              // Extract Landmark / Short Address
              if (parsed.address) {
                const a = parsed.address;
                shortName = a.amenity || a.mall || a.university || a.college || a.building || a.shop || a.hospital || a.leisure || a.office;
                
                if (!shortName) {
                  if (a.house_number && a.road) {
                    shortName = `${a.house_number} ${a.road}`;
                  } else if (a.road) {
                    shortName = a.road;
                  } else if (parsed.display_name) {
                    shortName = parsed.display_name.split(',')[0].trim();
                  }
                }
              } else if (parsed.display_name) {
                 shortName = parsed.display_name.split(',')[0].trim();
              }
              
              cachedAddress = shortName;
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

// ================================================================
// 3. MAIN HANDLER
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

  // --- ARDUINO POSTS DATA ---
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");

      const status = latestData?.status;
      const isFall = status === "Fall Alert!";
      //const lat = latestData?.lat;
      //const lon = latestData?.lon;

      // 1. Get the readable location (e.g., "Kingsway Mall")
      const streetAddress = await getAddress(lat, lon);
      latestData.address = streetAddress;

      // 2. Email trigger logic
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
          accessToken: process.env.EMAILJS_PRIVATE_KEY, // <-- YOUR FIX IS HERE!
          template_params: { 
            address: streetAddress, // <-- Sends "Kingsway Mall" to the email!
            lat: lat, 
            lon: lon 
          }
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

  // --- WEBSITE REQUESTS DATA ---
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(latestData),
    };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
