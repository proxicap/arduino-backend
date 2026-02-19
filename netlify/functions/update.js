let latestData = {};
let lastEmailSentAt = 0;
let wasFall = false; // tracks last known state

// --- CACHE VARIABLES (Protects from API Bans) ---
let cachedAddress = "Waiting for GPS...";
let lastGeocodeLat = 0;
let lastGeocodeLon = 0;

const https = require("https");

// ================================================================
// HELPER: SEND EMAIL VIA EMAILJS
// ================================================================
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

// ================================================================
// HELPER: REVERSE GEOCODING (SMART ADDRESS)
// ================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    // 1. Check if GPS is invalid or zero
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    // 2. The Free Tier Protector: Calculate how far you moved (~50 meters)
    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    // If you haven't moved significantly, DO NOT ping the API. Return cached memory.
    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    console.log("Moved significantly. Asking OpenStreetMap for new address...");

    // 3. Ping OpenStreetMap with addressdetails=1 to get specific landmarks
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

              // --- SMART ADDRESS EXTRACTOR ---
              if (parsed.address) {
                const a = parsed.address;
                
                // Look for specific landmarks first (NAIT, Kingsway, Hospitals, etc.)
                shortName = a.amenity || a.mall || a.university || a.college || a.building || a.shop || a.leisure || a.hospital || a.office;
                
                // If it's not a landmark, fall back to the Street Address
                if (!shortName) {
                  if (a.house_number && a.road) {
                    shortName = `${a.house_number} ${a.road}`;
                  } else if (a.road) {
                    shortName = a.road;
                  } else if (parsed.display_name) {
                    // Absolute fallback: just grab the first word before the comma
                    shortName = parsed.display_name.split(',')[0].trim();
                  }
                }
              } else if (parsed.display_name) {
                 shortName = parsed.display_name.split(',')[0].trim();
              }
              
              // Update our Cache with the new short location name
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
// MAIN SERVERLESS HANDLER
// ================================================================
exports.handler = async (event) => {
  // CORS Headers so your website can talk to this function
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  // Handle pre-flight checks from browsers
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  // --- A. ARDUINO POSTS DATA ---
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body || "{}");
      
      const status = latestData?.status;
      const isFall = status === "Fall Alert!";
      const lat = latestData?.lat;
      const lon = latestData?.lon;

      // 1. Convert Coordinates to Smart Address
      const streetAddress = await getAddress(lat, lon);
      
      // Inject the readable address into the data for your website
      latestData.address = streetAddress;

      // 2. Fall Detection & Email Logic
      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall;
      const now = Date.now();

      // Send email ONLY when we transition into fall state AND 30s have passed
      if (fallRisingEdge && (now - lastEmailSentAt > 30000)) {
        lastEmailSentAt = now;
        
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          // Send the specific location variables to the EmailJS template
          template_params: { 
            address: streetAddress, 
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

      return { statusCode: 200, headers, body: JSON.stringify({ status: "ok" }) };
    } catch {
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // --- B. WEBSITE REQUESTS LATEST DATA ---
  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers, body: JSON.stringify(latestData) };
  }

  // Reject any other HTTP methods
  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
