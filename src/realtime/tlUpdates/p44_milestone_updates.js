const AWS = require("aws-sdk");
const {SNS_TOPIC_ARN } = process.env;
const sns = new AWS.SNS({ region: process.env.REGION });
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { mapStatus } = require("../../shared/datamapping");
const { putItem, allqueries } = require("../../shared/dynamo");
const { run } = require("../../shared/tokengenerator");
const moment = require("moment-timezone");
const Flatted = require("flatted");

module.exports.handler = async (event, context) => {
  console.info("Received event:", JSON.stringify(event));
  const records = event.Records;
  const id = uuidv4();

  for (const record of records) {
    try {
      const body = JSON.parse(record.body);
      const newImage = body.NewImage;
      // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
      const orderNo = newImage.FK_OrderNo.S;
      const orderStatusId = newImage.FK_OrderStatusId.S;

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
      if (!validStatusCodes.includes(orderStatusId)) {
        console.info(`Skipping record with order status ${orderStatusId}`);
        continue;
      }
      // Checking whether the Billno's belongs to MCKESSON customer
      const headerparams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
        KeyConditionExpression: `PK_OrderNo = :orderNo`,
        ExpressionAttributeValues: {
          ":orderNo": { S: orderNo },
        },
      };
      const headerResult = await allqueries(headerparams);
      const items = headerResult.Items;
      let BillNo;
      let houseBill;
      if (items && items.length > 0) {
        BillNo = items[0].BillNo.S;
        houseBill = items[0].Housebill.S;
        console.info("BillNo:", BillNo);
        console.info("Housebill:", houseBill);
      } else {
        console.info("headerResult have no values");
        continue;
      }

      if (!headerResult.Items) {
        console.info(`Skipping the record as headerResult.Item is falsy`);
        continue;
      }
      let customerId = "";
      if (process.env.MCKESSON_CUSTOMER_NUMBERS.includes(BillNo)) {
        console.info(`This is MCKESSON_CUSTOMER_NUMBERS`);
        customerId = "MCKESSON";
      }
      if (customerId === "") {
        console.info(
          `Skipping the record as the BillNo does not match with valid customer numbers`
        );
        continue;
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
        continue;
      } else {
        referenceNo = referenceResult.Items[0].ReferenceNo.S;
      }

      billOfLading = referenceNo;
      const eventDateTime = newImage.EventDateTime.S;
      const eventTimezone = newImage.EventTimeZone.S;
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
        continue;
      }
      const hoursaway = timezoneResult.Items[0].HoursAway.S;
      const utcTimestamp = moment(eventDateTime)
        .add(5 - hoursaway, "hours")
        .format("YYYY-MM-DDTHH:mm:ss");
      const mappedStatus = await mapStatus(orderStatusId);

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
        eventStopNumber: mappedStatus.stopNumber,
        eventType: mappedStatus.type,
      };
      console.info("payload:", payload);
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
      const params = {
        Message: `Error in ${context.functionName}, Error: ${error.Message}`,
        TopicArn: SNS_TOPIC_ARN,
      };
      await sns.publish(params).promise();
      return error;
    }
  }
};
