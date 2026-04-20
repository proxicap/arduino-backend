// =================================================================
// HYBRID NETLIFY FUNCTION
// - keeps your old POST/GET flow
// - can still accept direct POSTs from the board if needed
// - on GET, it refreshes from Arduino Cloud first
// - keeps your EmailJS + geocoding + fall-time logic
// =================================================================

const https = require("https");

// =================================================================
// GLOBAL STATE / CACHE
// =================================================================

// latest dashboard payload kept in memory while function instance is warm
let latestData = {};

// email cooldown
let lastEmailSentAt = 0;

// previous fall state for rising-edge detection
let wasFall = false;

// current active fall time
let latestFallTime = null;

// last fall time even after fall ends
let lastRecordedFallTime = null;

// cached address + geocoding memo
let cachedAddress = "Waiting for GPS...";
let lastGeocodeLat = 0;
let lastGeocodeLon = 0;

// =================================================================
// TIME FORMATTER (EDMONTON TIME)
// =================================================================
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
  }).replace(",", "          |             ");
}

// =================================================================
// GENERIC HTTPS REQUEST HELPER
// =================================================================
function httpsRequest({ hostname, path, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: data,
          });
        });
      }
    );

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

// =================================================================
// EMAILJS HELPER
// =================================================================
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

// =================================================================
// REVERSE GEOCODING
// =================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    if (
      lat === null || lon === null ||
      lat === undefined || lon === undefined ||
      (lat === 0 && lon === 0)
    ) {
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

// =================================================================
// ARDUINO CLOUD TOKEN
// =================================================================
async function getArduinoToken() {
  const clientId = process.env.ARDUINO_CLIENT_ID;
  const clientSecret = process.env.ARDUINO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing ARDUINO_CLIENT_ID or ARDUINO_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    audience: "https://api2.arduino.cc/iot"
  }).toString();

  const result = await httpsRequest({
    hostname: "api2.arduino.cc",
    path: "/iot/v1/clients/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Arduino token failed: ${result.status} ${result.body}`);
  }

  const parsed = JSON.parse(result.body || "{}");

  if (!parsed.access_token) {
    throw new Error("Arduino token missing access_token");
  }

  return parsed.access_token;
}

// =================================================================
// ARDUINO CLOUD PROPERTIES
// =================================================================
async function getArduinoProperties() {
  const thingId = process.env.ARDUINO_THING_ID;

  if (!thingId) {
    throw new Error("Missing ARDUINO_THING_ID");
  }

  const token = await getArduinoToken();

  const result = await httpsRequest({
    hostname: "api2.arduino.cc",
    path: `/iot/v2/things/${thingId}/properties`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Arduino properties failed: ${result.status} ${result.body}`);
  }

  const parsed = JSON.parse(result.body || "[]");

  return Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.properties)
    ? parsed.properties
    : [];
}

// =================================================================
// PROPERTY HELPERS
// =================================================================
function findProp(props, wantedName) {
  return props.find(
    (p) =>
      p?.name === wantedName ||
      p?.variable_name === wantedName ||
      p?.identifier === wantedName
  );
}

function tryParse(value) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getPropValue(prop) {
  if (!prop) return null;

  if (prop.last_value !== undefined) return tryParse(prop.last_value);
  if (prop.value !== undefined) return tryParse(prop.value);
  if (prop.persisted_value !== undefined) return tryParse(prop.persisted_value);

  return null;
}

function getPropUpdatedAt(prop) {
  if (!prop) return null;

  return (
    prop.updated_at ||
    prop.last_value_updated_at ||
    prop.value_updated_at ||
    null
  );
}

// =================================================================
// FALL / EMAIL / CACHE LOGIC
// Reused for both:
// 1. direct POST payloads
// 2. Arduino Cloud-fetched payloads
// =================================================================
async function processIncomingState(incoming) {
  latestData = { ...incoming };

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

  if (fallRisingEdge) {
    const formatted = formatTime(now);
    latestFallTime = formatted;
    lastRecordedFallTime = formatted;
  }

  latestData.fallTime = isFall ? latestFallTime : null;
  latestData.lastFallTime = lastRecordedFallTime;

  if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
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
      const result = await emailjsSend(payload);
      console.log("EmailJS response:", result.status, result.body);

      lastEmailSentAt = now;

      if (result.status < 200 || result.status >= 300) {
        throw new Error(`EmailJS failed: ${result.status} ${result.body}`);
      }
    } catch (e) {
      lastEmailSentAt = now;
      console.log("Email error:", e);
    }
  }

  return latestData;
}

// =================================================================
// FETCH CURRENT BOARD STATE FROM ARDUINO CLOUD
// =================================================================
async function refreshFromArduinoCloud() {
  const props = await getArduinoProperties();

  const pStatus = findProp(props, "statusText");
  const pTiltX = findProp(props, "tiltX");
  const pDistance = findProp(props, "obstacleDistance");
  const pLocation = findProp(props, "userLocation");
  const pFall = findProp(props, "fallAlert");

  const statusText = getPropValue(pStatus);
  const tiltX = getPropValue(pTiltX);
  const obstacleDistance = getPropValue(pDistance);
  const fallAlert = getPropValue(pFall);
  const locationValue = getPropValue(pLocation);

  let lat = null;
  let lon = null;

  if (locationValue && typeof locationValue === "object") {
    lat = Number(locationValue.lat ?? locationValue.latitude ?? null);
    lon = Number(locationValue.lon ?? locationValue.lng ?? locationValue.longitude ?? null);

    if (!Number.isFinite(lat)) lat = null;
    if (!Number.isFinite(lon)) lon = null;
  }

  const payload = {
    status:
      typeof statusText === "string" && statusText.trim()
        ? statusText
        : fallAlert
        ? "Fall Alert!"
        : "Normal",
    tiltX: tiltX ?? null,
    obstacleDistance: obstacleDistance ?? null,
    lat,
    lon,
    // if you want, later we can use property timestamps instead
    cloudUpdatedAt:
      getPropUpdatedAt(pStatus) ||
      getPropUpdatedAt(pFall) ||
      getPropUpdatedAt(pLocation) ||
      null
  };

  return processIncomingState(payload);
}

// =================================================================
// MAIN HANDLER
// =================================================================
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

  // ---------------------------------------------------------------
  // POST
  // Keep this so your old direct-device flow still works if needed
  // ---------------------------------------------------------------
  if (event.httpMethod === "POST") {
    try {
      const incoming = JSON.parse(event.body || "{}");
      await processIncomingState(incoming);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };
    } catch (e) {
      console.log("POST error:", e);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON or POST processing failed" }),
      };
    }
  }

  // ---------------------------------------------------------------
  // GET
  // Refresh from Arduino Cloud first, then return dashboard JSON
  // ---------------------------------------------------------------
  if (event.httpMethod === "GET") {
    try {
      await refreshFromArduinoCloud();
    } catch (e) {
      console.log("Arduino Cloud refresh error:", e);
      // fallback: return cached latestData if Cloud fetch fails
    }

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
