/*
* File: src\shared\dynamo.js
* Project: Omni-project44-real-time-updates
* Author: Bizcloud Experts
* Date: 2023-03-28
* Confidential and Proprietary
*/
const AWS = require("aws-sdk");
const dynamo = new AWS.DynamoDB({ apiVersion: "2012-08-10" });
const dydb = new AWS.DynamoDB.DocumentClient({ apiVersion: "2012-08-10" });


async function putItem(params) {
    try {

      return await dydb.put(params).promise();
    } catch (e) {
      console.error("Put Item Error: ", e, "\nPut params: ", params);
      throw "PutItemError";
    }
  }

async function get(params) {
    try {

      return await dynamo.getItem(params).promise();
    } catch (e) {
      console.error("Get Item Error: ", e, "\nGet params: ", params);
      throw "GetItemError";
    }
  }

  async function allqueries(params) {
    try {

      return await dynamo.query(params).promise();
    } catch (e) {
      console.error("query Item Error: ", e, "\nquery params: ", params);
      throw "queryItemError";
    }
  }
  module.exports = {
    get,
    putItem,
    allqueries
  }