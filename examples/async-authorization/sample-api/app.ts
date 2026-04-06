const express = require("express");
const bodyParser = require("body-parser");
const { auth, requiredScopes } = require("express-oauth2-jwt-bearer");

require("dotenv").config();

const app = express();
const port = process.env.PORT || "8081";

app.use(bodyParser.json());

const checkJwt = auth({
  audience: process.env.AUDIENCE,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}/`,
});

app.post("/", checkJwt, requiredScopes(["stock:trade"]), (req, res) => {
  console.log("Received request to purchase stock");
  res.status(200).send({ message: "Stock purchase request received" });
});

app.get(
  "/portfolio",
  checkJwt,
  requiredScopes(["portfolio:read"]),
  (req, res) => {
    res.json([
      { ticker: "ATKO", quantity: 100, price: 100 },
      { ticker: "ZEKO", quantity: 100, price: 100 },
    ]);
  }
);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
