let latestData = {};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    latestData = JSON.parse(event.body);
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "ok" })
    };
  } catch (err) {
    return {
      statusCode: 400,
      body: "Invalid JSON"
    };
  }
};
