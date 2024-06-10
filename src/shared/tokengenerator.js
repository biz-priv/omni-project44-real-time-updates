/*
* File: src\shared\tokengenerator.js
* Project: Omni-project44-real-time-updates
* Author: Bizcloud Experts
* Date: 2023-09-20
* Confidential and Proprietary
*/
const axios = require('axios');
const AWS = require("aws-sdk");

async function run() {
  const formData = {
    client_id: process.env.P44_CLIENT_ID,
    client_secret: process.env.P44_CLIENT_SECRET,
    grant_type: 'client_credentials'
  };

  const resp = await axios.post(
    process.env.P44_AUTH_API,
    new URLSearchParams(formData).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    }
  ).then(res => res.data)
    .catch(err => console.error(err));

  const accToken = resp.access_token;
  return accToken
}

module.exports = {
  run
}