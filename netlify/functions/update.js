// =================================================================
// GLOBAL STATE & CACHE VARIABLES
// These variables stay in memory while the Netlify function instance
// is alive. They are used to remember the most recent device data,
// track fall state changes, and reduce repeated geocoding requests.
// =================================================================

// Stores the most recent full payload received from the Arduino/device
let latestData = {};

// Stores the timestamp of the last email sent so email alerts are not
// sent too often in a short period of time
let lastEmailSentAt = 0;

// Tracks whether the previous known device state was a fall state
// This is used to detect a "rising edge" meaning normal -> fall
let wasFall = false;

// --- FALL TIME STATE ---

// Stores the time of the current active fall event
// This is only filled while a fall is currently happening
let latestFallTime = null;

// Stores the most recent fall time even after the fall is over
// This allows the frontend to still show the last detected fall time
let lastRecordedFallTime = null;

// --- CACHE VARIABLES ---

// Stores the most recently resolved street/location name from reverse geocoding
// Starts with a placeholder until real GPS data is available
let cachedAddress = "Waiting for GPS...";

// Stores the latitude used in the most recent successful geocoding lookup
let lastGeocodeLat = 0;

// Stores the longitude used in the most recent successful geocoding lookup
let lastGeocodeLon = 0;

// Built-in Node HTTPS module used to make secure requests to:
// 1. EmailJS for sending email alerts
// 2. OpenStreetMap Nominatim for reverse geocoding GPS coordinates
const https = require("https");

// ================================================================
// TIME FORMATTER (EDMONTON TIME)
// Converts a timestamp into a readable Edmonton local time string
// Example output includes date and time in Alberta timezone
// ================================================================
function formatTime(ts) {
  // Create a JavaScript Date object from the given timestamp
  const d = new Date(ts);

  // Convert the time into Edmonton local time with a readable format
  // The replace() call swaps the comma with a visual separator
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

// ================================================================
// EMAILJS HELPER
// Sends a POST request to EmailJS so the backend can trigger an
// email notification when a fall is detected
// ================================================================
function emailjsSend(payload) {
  return new Promise((resolve, reject) => {
    // Convert the JavaScript object into JSON text for transmission
    const body = JSON.stringify(payload);

    // Create the HTTPS request to EmailJS
    const req = https.request(
      {
        hostname: "api.emailjs.com",
        path: "/api/v1.0/email/send",
        method: "POST",
        headers: {
          // Tell EmailJS the request body is JSON
          "Content-Type": "application/json",

          // Send the size of the body so the server knows how much data to expect
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // Collect response chunks from EmailJS
        let data = "";

        // Keep appending data chunks as they arrive
        res.on("data", (c) => (data += c));

        // When the full response is received, resolve the Promise
        // Return both HTTP status code and response body
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );

    // If a network or request error happens, reject the Promise
    req.on("error", reject);

    // Write the JSON body into the request
    req.write(body);

    // Finish and send the request
    req.end();
  });
}

// ================================================================
// ADDRESS HELPER
// Uses reverse geocoding to convert latitude and longitude into a
// short readable place/address name for the dashboard and email alert
// ================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    // If coordinates are missing or zero, do not try geocoding
    // Return a placeholder instead
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    // Measure how far the device moved since the last geocoding lookup
    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    // If the position has barely changed and a real address is already cached
    // return the cached address instead of calling the geocoding service again
    // This reduces API usage and improves speed
    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    // Create an HTTPS request to OpenStreetMap Nominatim reverse geocoding API
    const req = https.request(
      {
        hostname: "nominatim.openstreetmap.org",
        path: `/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`,
        method: "GET",

        // Nominatim requires a User-Agent string
        headers: { "User-Agent": "ProxiCap-Wearable/1.0" },
      },
      (res) => {
        // Collect response data as text
        let data = "";

        res.on("data", (chunk) => (data += chunk));

        res.on("end", () => {
          // If the API responded successfully
          if (res.statusCode === 200) {
            try {
              // Parse the returned JSON
              const parsed = JSON.parse(data);

              // Default fallback location name
              let shortName = "Unknown Location";

              // If a detailed address object exists
              if (parsed.address) {
                const a = parsed.address;

                // Prefer a shorter more useful landmark/building style name
                // if available, instead of the full long address
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

                // If no landmark-style name was found, build a simpler fallback
                if (!shortName) {
                  if (a.house_number && a.road) {
                    shortName = `${a.house_number} ${a.road}`;
                  } else if (a.road) {
                    shortName = a.road;
                  } else if (parsed.display_name) {
                    // Use only the first part of the display name if needed
                    shortName = parsed.display_name.split(",")[0].trim();
                  }
                }
              } else if (parsed.display_name) {
                // If address details were not provided, fall back to the first part
                // of the display name
                shortName = parsed.display_name.split(",")[0].trim();
              }

              // Save the resolved address into cache
              cachedAddress = shortName;

              // Save the coordinates used for this lookup into cache
              lastGeocodeLat = lat;
              lastGeocodeLon = lon;

              // Return the cached short address
              resolve(cachedAddress);
            } catch {
              // If JSON parsing fails for some reason
              resolve("Address Parsing Error");
            }
          } else {
            // If the API responded with something other than 200 success
            resolve("Geocoding API Limit Reached");
          }
        });
      }
    );

    // If a network error happens while requesting address data
    req.on("error", () => resolve("Network Error getting address"));

    // Send the request
    req.end();
  });
}

// ================================================================
// MAIN HANDLER
// This is the Netlify serverless function entry point.
// It handles:
// 1. OPTIONS requests for CORS preflight
// 2. POST requests from the Arduino/device
// 3. GET requests from the website frontend
// ================================================================
exports.handler = async (event) => {
  // CORS headers let the frontend and device communicate with this backend
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  // Handle browser preflight request
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // ================= POST =================
  // POST is used when the Arduino/device sends new sensor data to the backend
  if (event.httpMethod === "POST") {
    try {
      // Parse incoming JSON body and store it as the latest device data
      latestData = JSON.parse(event.body || "{}");

      // Read current status from the incoming data
      const status = latestData?.status;

      // Check whether the current status exactly matches the fall alert state
      const isFall = status === "Fall Alert!";

      // Pull out latitude and longitude from incoming data
      const lat = latestData?.lat;
      const lon = latestData?.lon;

      // Convert coordinates into a short readable location/address
      const streetAddress = await getAddress(lat, lon);

      // Add the resolved address into the stored payload
      latestData.address = streetAddress;

      // Detect a fall "rising edge"
      // This becomes true only at the moment the system changes from
      // not-fall -> fall, preventing repeated triggers every POST
      const fallRisingEdge = isFall && !wasFall;

      // Update memory of the current fall state for next request
      wasFall = isFall;

      // Current backend time in milliseconds
      const now = Date.now();

      // Minimum delay between sent emails
      const COOLDOWN_MS = 30000;

      // --- RECORD FALL TIME ---
      // Only record a new fall time at the exact start of a new fall event
      if (fallRisingEdge) {
        const formatted = formatTime(now);

        // Store the currently active fall time
        latestFallTime = formatted;

        // Also store it as the last recorded fall time
        lastRecordedFallTime = formatted;
      }

      // --- ATTACH TO DATA ---
      // fallTime is only shown while a fall is active
      latestData.fallTime = isFall ? latestFallTime : null;

      // lastFallTime remains available even after the fall ends
      latestData.lastFallTime = lastRecordedFallTime;

      // --- EMAIL ---
      // Send an email only if:
      // 1. a new fall event just started
      // 2. enough time has passed since the last email
      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
        // Build EmailJS payload
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",

          // Private key comes from environment variables for security
          accessToken: process.env.EMAILJS_PRIVATE_KEY,

          // Values sent into the email template
          template_params: {
            address: streetAddress,
            lat: lat,
            lon: lon,
            fall_time: latestFallTime,
          }
        };

        try {
          // Send the email through EmailJS
          const result = await emailjsSend(payload);

          // Log EmailJS response for debugging in Netlify logs
          console.log("EmailJS response:", result.status, result.body);

          // Update cooldown timestamp even if service rejects
          // This prevents repeated hammering of the mail service
          lastEmailSentAt = now;

          // If EmailJS responded but with an error status, throw an error
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`EmailJS failed: ${result.status} ${result.body}`);
          }
        } catch (e) {
          // Even on error, still apply cooldown to avoid repeated retries
          lastEmailSentAt = now;

          // Log the error to Netlify logs
          console.log("Email error:", e);
        }
      }

      // Return success response to the device
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };

    } catch (e) {
      // If the incoming JSON is invalid or another POST error occurs
      console.log("POST error:", e);
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // ================= GET =================
  // GET is used by the frontend website to read the latest stored device data
  if (event.httpMethod === "GET") {
    // Create a copy of the latest saved data so we can safely attach display values
    let displayData = { ...latestData };

    // Ensure the frontend always receives current fall-related values
    displayData.fallTime = latestFallTime;
    displayData.lastFallTime = lastRecordedFallTime;

    // Send the most recent dashboard data to the website
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(displayData),
    };
  }

  // If request method is not GET, POST, or OPTIONS, reject it
  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
