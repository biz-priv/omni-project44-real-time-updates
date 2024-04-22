const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { mapStatusfunc } = require("../../shared/datamapping");
const { putItem, allqueries } = require("../../shared/dynamo");
const { run } = require("../../shared/tokengenerator");
const moment = require("moment-timezone");
const Flatted = require("flatted");
const { get } = require("lodash");

module.exports.handler = async (event, context) => {
  console.info("Received event:", JSON.stringify(event));
  const records = event.Records;

  const promises = records.map(async (record) => {
    try {
      const body = JSON.parse(record.body);
      const newImage = get(body, "NewImage", {});
      const oldImage = get(body, "OldImage", '');
      let newRecordUpdateFlag = '';
      if(oldImage !== ''){
        for(const key in oldImage){
          if(oldImage[key]['S'] !== newImage[key]['S'] && !['UUid', 'ProcessState', 'InsertedTimeStamp'].includes(key)){
            console.info(key);
            newRecordUpdateFlag = 'Yes';
          }
        }
        if(newRecordUpdateFlag === ''){
          console.info('There is no new update for this record.So, ignoring');
          return;
        }
      }
       // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
      const orderNo = get(newImage, "FK_OrderNo.S");
      const orderStatusId = get(newImage, "FK_OrderStatusId.S");

      // Check whether the order status is valid
      const validStatusCodes = [
        "PUP",
        "AHO",
        "DOH",
        "ADH",
        "DDH",
        "OFD",
        "DEL",
      ];

      if (!validStatusCodes.includes(orderStatusId)) {
        console.info(`Skipping record with order status ${orderStatusId}`);
        return;
      }
      // Checking whether the Bill belongs to IMS customer
      const headerparams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
        KeyConditionExpression: `PK_OrderNo = :orderNo`,
        ExpressionAttributeValues: { ":orderNo": { S: orderNo } },
      };
      const headerResult = await allqueries(headerparams);
      const items = headerResult.Items;
      let BillNo;
      let housebill;
      let fkServicelevelId ;

      if (items && items.length > 0) {
        BillNo = get(items,"[0].BillNo.S");
        housebill = get(items,"[0].Housebill.S");
        fkServicelevelId  = get(items,"[0].FK_ServiceLevelId.S");
        console.info("BillNo:", BillNo);
        console.info("housebill:", housebill);
        console.info("fk_servicelevelid:", fkServicelevelId);
      } else {
        console.info("headerResult has no values");
        return;
      }

      if (!headerResult.Items) {
        console.info(`Skipping the record as headerResult.Items is falsy`);
        return;
      }

      let customerName = "";
      let endpoint = "";
      if (process.env.IMS_CUSTOMER_NUMBER.includes(BillNo)) {
        console.info(`This is IMS_CUSTOMER_NUMBER`);
        customerName = process.env.IMS_ACCOUNT_IDENTIFIER;
        endpoint = process.env.P44_LTL_STATUS_UPDATES_API;
      }
      if (process.env.DOTERRA_CUSTOMER_NUMBER.includes(BillNo)) {
        console.info(`This is DOTERRA_CUSTOMER_NUMBER`);
        customerName = process.env.DOTERRA_CUSTOMER_NUMBER; // here account num and identifier are the same.
        endpoint = process.env.DOTERRA_CUSTOMER_ENDPOINT;
      }
      if ( process.env.MCKESSON_CUSTOMER_NUMBERS.includes(BillNo) && !["HS", "FT"].includes(fkServicelevelId) ) {
        console.info(`This is MCKESSON_CUSTOMER_NUMBERS`);
        customerName = process.env.MCKESSON_CUSTOMER_NAME;
        endpoint = process.env.P44_LTL_STATUS_UPDATES_API;
      }
      if (customerName === "") {
        console.info(
          `Skipping the record as the BillNo does not match with valid customer numbers`
        );
        return;
      }
      console.info("customerName", customerName);
      console.info("endpoint", endpoint);
      let billOfLading;
      let referenceNo;

      if (customerName !== process.env.DOTERRA_CUSTOMER_NUMBER) {
        const referenceparams = {
          TableName: process.env.REFERENCES_TABLE_NAME,
          IndexName: process.env.REFERENCES_ORDERNO_INDEX,
          KeyConditionExpression: `FK_OrderNo = :orderNo`,
          FilterExpression:
            "CustomerType = :customerType and FK_RefTypeId = :refType",
          ExpressionAttributeValues: {
            ":orderNo": { S: orderNo },
            ":customerType": { S: "B" },
            ":refType": { S: "LOA" },
          },
        };

        const referenceResult = await allqueries(referenceparams);

        if (referenceResult.Items.length === 0) {
          console.info(`No Bill of Lading found for order ${orderNo}`);
          return; 
        } else {
          referenceNo = get(referenceResult.Items, "[0].ReferenceNo.S");
        }
      }

      // Determine the value of billOfLading based on customerName
      if (customerName === process.env.DOTERRA_CUSTOMER_NUMBER) {
        // If customerName is DOTERRA, use housebill
        billOfLading = housebill;
      } else {
        // Otherwise, use referenceNo
        billOfLading = referenceNo;
      }

      const eventDateTime = get(newImage, "EventDateTime.S");
      const eventTimezone = get(newImage, "EventTimeZone.S");
      const mappedStatus = await mapStatusfunc(orderStatusId);
      const timeStamp = await formatTimestamp(eventDateTime, eventTimezone);
      // construct payload required to sending P44 API
      const payload = {
        customerAccount: {
          accountIdentifier: customerName,
        },
        carrierIdentifier: {
          type: "SCAC",
          value: "OMNG",
        },

        shipmentIdentifiers: [],
        statusCode: mappedStatus.eventType,
        stopType: mappedStatus.stopType,
        stopNumber: mappedStatus.stopNumber,
        timestamp: timeStamp,
        sourceType: "API",
      };
      if (customerName === process.env.MCKESSON_CUSTOMER_NAME) {
        payload.shipmentIdentifiers.push({
          type: "PRO",
          value: billOfLading,
          primaryForType: false,
          source: "CAPACITY_PROVIDER",
        },
          {
            type: "BILL_OF_LADING",
            value: billOfLading,
            primaryForType: false,
            source: "CAPACITY_PROVIDER",
          });
      } else {
        payload.shipmentIdentifiers.push({
          type: "BILL_OF_LADING",
          value: billOfLading,
          primaryForType: false,
          source: "CAPACITY_PROVIDER",
        });
      }
      console.info("payload:", JSON.stringify(payload));
      // generating token with P44 oauth API
      const getaccesstocken = await run();
      // Calling P44 API with the constructed payload
      const p44Response = await axios.post(endpoint, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getaccesstocken}`,
        },
      });
      console.info("p44Response", p44Response);
      // Inserted time stamp in CST format
      const InsertedTimeStamp = moment()
        .tz("America/Chicago")
        .format("YYYY-MM-DDTHH:mm:ss");
      // Saving the response code and payload in DynamoDB
      // As JSON.stringify is not supported for converting circular reference object to string, used Flatted npm package
      const jsonp44Response = Flatted.stringify(p44Response);
      const milestoneparams = {
        TableName: process.env.P44_MILESTONE_LOGS_TABLE_NAME,
        Item: {
          UUID: uuidv4(),
          ReferenceNo: billOfLading,
          p44ResponseCode: p44Response.status,
          p44Payload: JSON.stringify(payload),
          p44Response: jsonp44Response, // Added JSON P44 response
          InsertedTimeStamp,
        },
      };
      await putItem(milestoneparams);
      console.info("Record is inserted successfully");
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

async function formatTimestamp(eventdatetime, eventTimezone) {
  const date = moment(eventdatetime);
  const week = date.week();
  let offset = week >= 11 && week <= 44 ? 5 : 6;
  const timezoneparams = {
    TableName: process.env.TIME_ZONE_TABLE_NAME,
    KeyConditionExpression: `PK_TimeZoneCode = :code`,
    ExpressionAttributeValues: {
      ":code": { S: eventTimezone }
    }
  };
  console.info("timezoneparams:", timezoneparams);
  const timezoneResult = await allqueries(timezoneparams);
  if (timezoneResult.Items.length === 0) {
    console.info(`timezoneResult have no values`);
    offset = week >= 11 && week <= 44 ? "-0500" : "-0600";
    return date.format("YYYY-MM-DDTHH:mm:ss") + offset;
  }
  const hoursaway = timezoneResult.Items[0].HoursAway.S;

  return date.format("YYYY-MM-DDTHH:mm:ss") + "-0" + (offset - hoursaway) + "00";
}