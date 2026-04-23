// =============== Netlify Backend ====================
// Receive data from arduino and update previous data
// Connect to emailjs and trigger mail
// await GET request from frontend
// save date when fall is detected

// ================= GLOBAL STATE =================
let latestData = {}; // store recent data from aurduino 
let lastEmailSentAt = 0; // tracks when last email was sent
let wasFall = false; // becomes true when fall is detected
let latestFallTime = null; // stores time of current fall
let lastRecordedFallTime = null; // last known fall 
const https = require("https"); // Imports Node.js HTTPS module - allows backend to send https connection

// ================= TIME FORMAT =================
// format date() function into readable time format 
function formatTime(ts) { // ts  = timestamp
  const d = new Date(ts); // use date function to convert timestamp into a date

  // convert date into readable text
  return d.toLocaleString("en-CA", { // canadian formata
    timeZone: "America/Edmonton", // forcest time into edmonton time
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).replace(",", " | "); // fromat the date itself
}

// ================= EMAIL =================
// Function allows us to send a POST request to emailjs over HTTPS to trigger an email
function emailjsSend(payload) { // payload is the email data (service id, template id, etc.)
  return new Promise((resolve, reject) => { // return resolve when successfull , return reject when email fails
    const body = JSON.stringify(payload); // take the payload and format into JSON package
    // HTTP CONNECTION TO EMAILJS 
    const req = https.request( 
      {
        hostname: "api.emailjs.com",
        path: "/api/v1.0/email/send",
        method: "POST", // POST REQUEST
        headers: {
          "Content-Type": "application/json", // telling emailjs we are sending json data
          "Content-Length": Buffer.byteLength(body), // length of json we are sending
        },
      },
      (res) => { // COLLECT RESPONSE FROM EMAILJS 
        // PACKAGE RESPONSE
        let data = "";
        res.on("data", (c) => (data += c)); // COMBINE RESPONSE
        // return response code and response body
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject); // will return error if sending of data fails
    req.write(body); // SENDS JSON PACKAGE -------------------------------------
    req.end(); // finish the POST REQUEST
  });
}

// ================= MAIN HANDLER =================
// MAIN FUNCTION NETLFIY RUNS EVERYTIME A REQUEST COMES IN 
exports.handler = async (event) => { // NETLIFY WAITS FOR EXTERNAL EVENT
  // THIS ALLOWS TYPE OF REQUESTS BACKEND CAN RECIEVE
  const headers = {
    "Access-Control-Allow-Origin": "*", // ALLOWS ANY WEBSITE TO ACCESS BACKEND 
    "Access-Control-Allow-Headers": "Content-Type", // ALLOWS JSON DATA TO BE SENT
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS", // TYPES OF REQUESTS
  };

  if (event.httpMethod === "OPTIONS") { // If event is option
    return { statusCode: 204, headers, body: "" }; // return success code
  }

  // ================= POST =================
  // RECIEVE DATA FROM AURDIONO 
  // READS DATA AND DETECTS THE FALL
  // RECORDS TIME OF FALL
  // ========================================
  if (event.httpMethod === "POST") { // IF ARDUINO IS DOING A POST REQUEST:
    try {
      // Convert JSON into a JavaScript object
      latestData = JSON.parse(event.body || "{}"); // THIS STORES DATA INTO LATESTDATA VARIABLE (latestData.status,latestData.lat,latestData.lon);
      const status = latestData?.status; // GET FALL DATA FROM LATEST DATA
      const isFall = status === "Fall Alert!"; // ISFALL BECOMES TRUE IF DATA SENT IT FALL ALERT!
      const lat = latestData?.lat; // STORE LATITUDE DATA FROM JAVASCRIP OBJECT
      const lon = latestData?.lon; // STORE LONGTITUDE DATA FROM JAVASCRIPT OBJECT
      const fallRisingEdge = isFall && !wasFall; // PREVENTS EMAIL SPAMMING WHEN FALL HAPPENS
      wasFall = isFall; // SAVES CURRENT STATE OF USER
      const now = Date.now(); // CURRENT TIME EACH TIME POST REQUEST HAPPENS - STORE INTO NOW VAIRABLE
      const COOLDOWN_MS = 30000; // MINIMUM COOLDOWN BETWEEN EACH EMAIL

      if (fallRisingEdge) { // IF FALL HAPPENS
        const formatted = formatTime(now); // RECORD TIME AND FORMAT IT USING FORMATTIME
        latestFallTime = formatted; // LAST FALL TIME IS STORED
        lastRecordedFallTime = formatted; // SAVES OLD FALL TIME
      }

      latestData.fallTime = isFall ? latestFallTime : null; // IF NO FALL DONT SHOW FALL TIME
      latestData.lastFallTime = lastRecordedFallTime; //  REMEMBER LATEST FALL TIME

      // ================= EMAIL =================
      // EMAIL SENDING PROCESS 
      if (fallRisingEdge && (now - lastEmailSentAt > COOLDOWN_MS)) { // if fall has happened and time has past cooldown 
        const payload = { // WHAT WE ARE SENDING TO EMAILJS
          service_id: "service_vavz75e", // CODE THAT TELLS EMAILJS WHAT EMAIL WE ARE SENDING FROM
          template_id: "template_y317gq5", // CODE THAT TELLS EMAILJS WHAT TEMPLATE TO SEND FROM
          user_id: "fwfVSV07CXWtpPxNb", // TELLS EMAILJS THAT PEDRAMS ACCOUNT WANT TO SEND EMAIL
          accessToken: process.env.EMAILJS_PRIVATE_KEY,
          template_params: {
            lat: lat,
            lon: lon,
            fall_time: latestFallTime,
          }
        };

        try {
          
          const result = await emailjsSend(payload); // THIS SENDS THE EMAIL AND STORES THE RESULT -----------------------------
          console.log("EmailJS response:", result.status, result.body); // SHOWS THE RESULT OF REQUEST
          lastEmailSentAt = now; // STORE TIME OF LAST EMAIL SENT
          // LETS US KNOW IF ERROR OCCURED
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`EmailJS failed: ${result.status}`);
          }
          // IF ERROR OCCURS STILL LOG FALL TIME
        } catch (e) {
          lastEmailSentAt = now;
          console.log("Email error:", e);
        }
      }
// RETURN ANY SUCCESS OR FAIL CODES
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
  // SEND DATA TO FRONTEND IF REQUESTED
  if (event.httpMethod === "GET") {
    const displayData = { ...latestData }; // CREATE COPY OF DATA

    // ENSURE THAT FALL TIME SENT IS THE LATEST ONE
    displayData.fallTime = latestFallTime;
    displayData.lastFallTime = lastRecordedFallTime;

    // SEND DATA TO FRONTEND
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(displayData), // PACKAGE CODE INTO JSON AND SND IT ------------------------
    };
  }

  return { statusCode: 405, headers, body: "Method Not Allowed" };
};
