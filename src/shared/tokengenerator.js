const AWS = require("aws-sdk");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function run() {
  
  const formData = {
    client_id: process.env.P44_CLIENT_ID,
    client_secret: process.env.P44_CLIENT_SECRET,
    grant_type: 'client_credentials'


    
  };

  const resp = await fetch(
    process.env.P44_AUTH_API,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(formData).toString()
    }
  ).then(res => res.json())
  .catch(err => console.error(err));

  console.log(resp);
  const accToken = resp.access_token;
  return accToken
}

module.exports ={
    run
}