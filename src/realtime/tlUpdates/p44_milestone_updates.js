/*
* File: src\realtime\tlUpdates\p44_milestone_updates.js
* Project: Omni-project44-real-time-updates
* Author: Bizcloud Experts
* Date: 2024-01-30
* Confidential and Proprietary
*/
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { mapStatus } = require("../../shared/datamapping");
const { putItem, allqueries } = require("../../shared/dynamo");
const { run } = require("../../shared/tokengenerator");
const moment = require("moment-timezone");
const Flatted = require("flatted");
const { get } = require("lodash");

module.exports.handler = async (event, context) => {
  console.info("Received event:", JSON.stringify(event));
  const records = event.Records;
  const id = uuidv4();

  const promises = records.map(async (record) => {
    try {
      const body = JSON.parse(record.body);
      const newImage = get(body, "NewImage", {});
      // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
      const orderNo = get(newImage, "FK_OrderNo.S");
      const orderStatusId = get(newImage, "FK_OrderStatusId.S");

      // Check whether the order status is valid
      const validStatusCodes = [
        "APL",
        "TTC",
        "COB",
        "PUP",
        "AAD",
        "DEL",
        "CAN",
      ];
      
      // Checking whether the Billno's belongs to MCKESSON customer
      const headerparams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
        KeyConditionExpression: `PK_OrderNo = :orderNo`,
        ExpressionAttributeValues: {
          ":orderNo": { S: orderNo },
        },
      };
      const headerResult = await allqueries(headerparams);
      const items = get(headerResult, "Items", []);
      let BillNo;
      let houseBill;
      let fkServicelevelId;

      if (items && items.length > 0) {
        BillNo = get(items, "[0].BillNo.S");
        houseBill = get(items, "[0].Housebill.S");
        fkServicelevelId = get(items, "[0].FK_ServiceLevelId.S");
        console.info("BillNo:", BillNo);
        console.info("Housebill:", houseBill);
        console.info("fk_servicelevelid:", fkServicelevelId);
      } else {
        console.info("headerResult have no values");
        return;
      }

      if (!headerResult.Items) {
        console.info(`Skipping the record as headerResult.Item is falsy`);
        return;
      }
      let customerId = "";
      const mappedStatus = await mapStatus(orderStatusId);
      if (process.env.MCKESSON_CUSTOMER_NUMBERS.includes(BillNo) && ["HS", "FT"].includes(fkServicelevelId)) {
        console.info(`This is MCKESSON_CUSTOMER_NUMBERS`);
        customerId = process.env.MCKESSON_CUSTOMER_NAME;
        if (!validStatusCodes.includes(orderStatusId)) {
          console.info(`Skipping record with order status ${orderStatusId}`);
          return;
        }
      } else if (process.env.YOUNG_LIVING_CUSTOMER_NUMBER === BillNo && ["FT", "LT"].includes(fkServicelevelId)) {
        console.info(`This is YOUNG_LIVING_CUSTOMER_NUMBERS`);
        customerId = process.env.YOUNG_LIVING_CUSTOMER_NAME;
        if(fkServicelevelId === "FT"){
          if(!["APL", "TTC", "COB", "DLA", "DEL"].includes(orderStatusId)){
            console.info(`Skipping record with status code ${orderStatusId} for order no ${orderNo}`)
          }
        }else{
          if(!["APL", "PUP", "COB", "AAD", "DEL"].includes(orderStatusId)){
            console.info(`Skipping record with status code ${orderStatusId} for order no ${orderNo}`)
          }
        }
        const logsParams = {
          TableName: process.env.P44_MILESTONE_LOGS_TABLE_NAME,
          IndexName: "FK_OrderNo-StatusCode-Index",
          KeyConditionExpression: `FK_OrderNo = :orderNo and StatusCode = :StatusCode`,
          ExpressionAttributeValues: {
            ":orderNo": { S: orderNo },
            ":StatusCode": { S: get(mappedStatus, 'type', '') }
          },
        };
        const logsResult = await allqueries(logsParams);
        if(get(logsResult, "Items", []).length !== 0){
          console.info(
            `Skipping the record as this event ${orderStatusId} already sent to the OrderNo ${orderNo}`
          );
          return;
        }
      }
      if (customerId === "") {
        console.info(
          `Skipping the record as the BillNo does not match with valid customer numbers`
        );
        return;
      }

      let billOfLading;
      let referenceNo;
      const referenceparams = {
        TableName: process.env.REFERENCES_TABLE_NAME,
        IndexName: process.env.REFERENCES_ORDERNO_INDEX,
        KeyConditionExpression: `FK_OrderNo = :orderNo`,
        FilterExpression:
          "CustomerType = :customerType and FK_RefTypeId = :refType",
        ExpressionAttributeValues: {
          ":orderNo": { S: orderNo },
          ":customerType": { S: "B" },
          ":refType": { S: "BOL" },
        },
      };
      const referenceResult = await allqueries(referenceparams);
      if (referenceResult.Items.length === 0) {
        console.info(`No Bill of Lading found for order ${orderNo}`);
        return;
      } else {
        referenceNo = get(referenceResult.Items, "[0].ReferenceNo.S");
      }

      billOfLading = referenceNo;
      const eventDateTime = get(newImage, "EventDateTime.S");
      const eventTimezone = get(newImage, "EventTimeZone.S");
      const timezoneparams = {
        TableName: process.env.TIME_ZONE_TABLE_NAME,
        KeyConditionExpression: `PK_TimeZoneCode = :code`,
        ExpressionAttributeValues: {
          ":code": { S: eventTimezone },
        },
      };
      const timezoneResult = await allqueries(timezoneparams);
      if (timezoneResult.Items.length === 0) {
        console.info(`timezoneResult have no values`);
        return;
      }
      const hoursaway = get(timezoneResult.Items, "[0].HoursAway.S");
      const utcTimestamp = moment(eventDateTime)
        .add(5 - hoursaway, "hours")
        .format("YYYY-MM-DDTHH:mm:ss");

      // Construct the payload
      const payload = {
        shipmentIdentifiers: [
          {
            type: "BILL_OF_LADING",
            value: billOfLading,
          },
        ],
        utcTimestamp: utcTimestamp,
        latitude: "0",
        longitude: "0",
        customerId: customerId,
        eventStopNumber: get(mappedStatus, 'stopNumber', 0),
        eventType: get(mappedStatus, 'type', ''),
        FK_OrderNo: orderNo,
        StatusCode: get(mappedStatus, 'type', '')
      };
      console.info("payload:", payload);
      return;
      // generating token with P44 oauth API
      const getaccesstocken = await run();
      // Calling P44 API with the constructed payload
      const p44Response = await axios.post(
        process.env.P44_STATUS_UPDATES_API,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getaccesstocken}`,
          },
        }
      );
      console.info("p44Response", p44Response);
      // Inserted time stamp in CST format
      const InsertedTimeStamp = moment()
        .tz("America/Chicago")
        .format("YYYY-MM-DDTHH:mm:ss");
      // Saving the response code and payload in DynamoDB
      // As json stringyfy is not supported for converting circular reference object to string
      // used Flatted npm package
      const jsonp44Response = Flatted.stringify(p44Response);
      const milestoneparams = {
        TableName: process.env.P44_MILESTONE_LOGS_TABLE_NAME,
        Item: {
          UUID: id,
          ReferenceNo: billOfLading,
          p44ResponseCode: p44Response.status,
          p44Payload: JSON.stringify(payload),
          p44Response: jsonp44Response, // Added json P44 response
          InsertedTimeStamp,
        },
      };
      await putItem(milestoneparams);
      console.info("record is inserted successfully");
    } catch (error) {
      console.error(error);
      throw error;
    }
  });

  try {
    await Promise.all(promises);
  } catch (error) {
    console.error("An error occurred in one or more promises:", error);
    return error;
  }
};
