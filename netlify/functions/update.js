// ================================================================
// GLOBAL STATE & CACHE VARIABLES
// Note: In serverless functions, these variables stay "warm" in memory 
// for a few minutes between requests, which allows us to remember past states.
// ================================================================
let latestData = {};       // Stores the most recent JSON payload sent by the Arduino
let lastEmailSentAt = 0;   // Timestamp of the last email sent (used for the 30-second cooldown)
let wasFall = false;       // Tracks if the previous state was a fall (prevents email spam)

// --- CACHE VARIABLES (Protects from OpenStreetMap API Bans) ---
let cachedAddress = "Waiting for GPS..."; // Remembers the last successful address translation
let lastGeocodeLat = 0; // Remembers the latitude of the last translation
let lastGeocodeLon = 0; // Remembers the longitude of the last translation

const https = require("https"); // Native Node.js library to make web requests

// ================================================================
// 1. EMAILJS HELPER (Sends the emergency email)
// ================================================================
function emailjsSend(payload) {
  // We wrap the HTTPS request in a Promise so our main code can "await" its completion
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload); // Convert the EmailJS data into a text string

    // Configure the connection to the EmailJS server
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
        res.on("data", (c) => (data += c)); // Gather chunks of the server's response
        res.on("end", () => resolve({ status: res.statusCode, body: data })); // Finish and return the status code
      }
    );

    req.on("error", reject); // Catch network errors
    req.write(body);         // Send the payload
    req.end();               // Close the connection
  });
}

// ================================================================
// 2. SMART ADDRESS HELPER (Kingsway Mall / NAIT extractor)
// ================================================================
function getAddress(lat, lon) {
  return new Promise((resolve) => {
    // Failsafe: If the Arduino sends empty or 0.0 coordinates, don't ping the API
    if (!lat || !lon || (lat === 0 && lon === 0)) {
      return resolve("Searching for GPS signal...");
    }

    // --- FREE TIER PROTECTOR ---
    // Calculates the difference between current coordinates and the last checked coordinates
    const movedLat = Math.abs(lat - lastGeocodeLat);
    const movedLon = Math.abs(lon - lastGeocodeLon);

    // 0.0005 degrees is roughly 50 meters. 
    // If the wearer hasn't moved further than that, instantly return the old address from memory.
    // This stops OpenStreetMap from banning our Netlify server for spamming requests every 5 seconds.
    if (movedLat < 0.0005 && movedLon < 0.0005 && cachedAddress !== "Waiting for GPS...") {
      return resolve(cachedAddress);
    }

    console.log("Moved significantly. Asking OpenStreetMap for new address...");

    // Setup the request to OpenStreetMap's free Nominatim reverse-geocoding API
    // The "addressdetails=1" tells the API to break down the address into dictionary parts (mall, road, etc.)
    const req = https.request({
        hostname: "nominatim.openstreetmap.org",
        path: `/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`,
        method: "GET",
        headers: { "User-Agent": "ProxiCap-Wearable/1.0" }, // Required by OpenStreetMap terms of service
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
              // Digs through the API response to find the most readable, shortest location name
              if (parsed.address) {
                const a = parsed.address;
                // Priority 1: Check if we are inside a major landmark (e.g., NAIT, Kingsway Mall, Hospital)
                shortName = a.amenity || a.mall || a.university || a.college || a.building || a.shop || a.hospital || a.leisure || a.office;
                
                // Priority 2: If not a landmark, piece together the house number and street name
                if (!shortName) {
                  if (a.house_number && a.road) {
                    shortName = `${a.house_number} ${a.road}`;
                  } else if (a.road) {
                    shortName = a.road; // Just the street name
                  } else if (parsed.display_name) {
                    // Priority 3: Absolute fallback, grab the first chunk of the raw string before the first comma
                    shortName = parsed.display_name.split(',')[0].trim();
                  }
                }
              } else if (parsed.display_name) {
                 shortName = parsed.display_name.split(',')[0].trim();
              }
              
              // Save this new successful translation into the cache variables
              cachedAddress = shortName;
              lastGeocodeLat = lat;
              lastGeocodeLon = lon;
              
              resolve(cachedAddress); // Return the clean string
            } catch (e) {
              resolve("Address Parsing Error"); // Failsafe if the API sends broken JSON
            }
          } else {
            resolve("Geocoding API Limit Reached"); // Failsafe if OpenStreetMap blocks us temporarily
          }
        });
      }
    );

    req.on("error", () => resolve("Network Error getting address"));
    req.end();
  });
}

// ================================================================
// 3. MAIN SERVERLESS HANDLER
// ================================================================
exports.handler = async (event) => {
  // CORS Headers: These tell web browsers that it is safe for your frontend website 
  // to request data from this backend server.
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  // Pre-flight request handler (Browsers automatically send an OPTIONS request before a POST request to check security)
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // --- A. DATA INGESTION (Arduino sends data here) ---
  if (event.httpMethod === "POST") {
    try {
      // Decode the JSON sent by the Arduino
      latestData = JSON.parse(event.body || "{}");

      const status = latestData?.status;
      const isFall = status === "Fall Alert!";
      const lat = latestData?.lat;
      const lon = latestData?.lon;

      // 1. Convert the raw coordinates into a readable address (e.g., "Kingsway Mall")
      const streetAddress = await getAddress(lat, lon);
      
      // Inject that new string back into the data object so the frontend can read it
      latestData.address = streetAddress;

      // 2. Rising Edge Trigger Logic
      // This checks if the user JUST fell down. (Current state is Fall, but previous state was Normal)
      const fallRisingEdge = isFall && !wasFall;
      wasFall = isFall; // Update the memory tracker for the next cycle

      const now = Date.now();
      const COOLDOWN_MS = 30000; // 30 seconds

      // 3. Email Execution
      // Only send an email IF it's a new fall AND 30 seconds have passed since the last email
      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) {
        lastEmailSentAt = now; // Update the cooldown timer

        // Construct the specific package EmailJS requires
        const payload = {
          service_id: "service_vavz75e",
          template_id: "template_y317gq5",
          user_id: "fwfVSV07CXWtpPxNb",
          accessToken: process.env.EMAILJS_PRIVATE_KEY, // Pulls your secret password securely from Netlify settings
          template_params: { 
            address: streetAddress, 
            lat: lat, 
            lon: lon 
          }
        };

        try {
          // Trigger the email helper function
          const r = await emailjsSend(payload);
          console.log("EmailJS:", r.status, r.body);
        } catch (e) {
          console.log("EmailJS ERROR:", String(e));
        }
      }

      // Tell the Arduino that the data was received successfully
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" }),
      };
    } catch {
      // If the Arduino sends corrupted data, reject it safely
      return { statusCode: 400, headers, body: "Invalid JSON" };
    }
  }

  // --- B. DATA SERVING (Your website requests data from here) ---
  if (event.httpMethod === "GET") {
    // 1. Create a shallow copy of the data (so we don't accidentally delete the master copy)
    let displayData = { ...latestData };
    
    // 2. Delete the raw GPS numbers from the copy. 
    // This hides the exact coordinates from the public website, showing only the clean Address string.
    delete displayData.lat;
    delete displayData.lon;

    // 3. Send the cleaned-up data to the frontend browser
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(displayData), 
    };
  }

  // Security fallback: If a script tries to use PUT or DELETE, reject it
  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
