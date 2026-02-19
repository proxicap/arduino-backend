let latestData = {};

exports.handler = async (event) => {
  // CORS
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  // Arduino sends data
  if (event.httpMethod === "POST") {
    try {
      latestData = JSON.parse(event.body);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok" })
      };
    } catch {
      return {
        statusCode: 400,
        headers,
        body: "Invalid JSON"
      };
    }
  }

  // Webpage requests data
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(latestData)
    };
  }

  return {
    statusCode: 405,
    headers,
    body: "Method Not Allowed"
  };
};
