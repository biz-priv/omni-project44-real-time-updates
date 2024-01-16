const AWS = require("aws-sdk");
const {SNS_TOPIC_ARN } = process.env;
const sns = new AWS.SNS({ region: process.env.REGION });
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { mapStatusfunc } = require("../../shared/datamapping");
const { putItem, allqueries } = require("../../shared/dynamo");
const { run } = require("../../shared/tokengenerator");
const moment = require("moment-timezone");
const Flatted = require("flatted");

module.exports.handler = async (event, context) => {
  console.info("Received event:", JSON.stringify(event));
  const records = event.Records;

  for (const record of records) {
    try {
      const body = JSON.parse(record.body);
      const newImage = body.NewImage;
      // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
      const orderNo = newImage.FK_OrderNo.S;
      const orderStatusId = newImage.FK_OrderStatusId.S;

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
        continue;
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

      if (items && items.length > 0) {
        BillNo = items[0].BillNo.S;
        housebill = items[0].Housebill.S;
        console.info("BillNo:", BillNo);
        console.info("housebill:", housebill);
      } else {
        console.info("headerResult has no values");
        continue;
      }

      if (!headerResult.Items) {
        console.info(`Skipping the record as headerResult.Items is falsy`);
        continue;
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
      if (customerName === "") {
        console.info(
          `Skipping the record as the BillNo does not match with valid customer numbers`
        );
        continue;
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
          continue;
        } else {
          referenceNo = referenceResult.Items[0].ReferenceNo.S;
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

      const eventDateTime = newImage.EventDateTime.S;
      const mappedStatus = await mapStatusfunc(orderStatusId);
      const timeStamp = await formatTimestamp(eventDateTime);
      // construct payload required to sending P44 API
      const payload = {
        customerAccount: {
          accountIdentifier: customerName,
        },
        carrierIdentifier: {
          type: "SCAC",
          value: "OMNG",
        },

        shipmentIdentifiers: [
          {
            type: "BILL_OF_LADING",
            value: billOfLading,
            primaryForType: false,
            source: "CAPACITY_PROVIDER",
          },
        ],
        statusCode: mappedStatus.eventType,
        stopType: mappedStatus.stopType,
        stopNumber: mappedStatus.stopNumber,
        timestamp: timeStamp,
        sourceType: "API",
      };
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
      const params = {
        Message: `Error in ${context.functionName}, Error: ${error.Message}`,
        TopicArn: SNS_TOPIC_ARN,
      };
      await sns.publish(params).promise();
      return error;
    }
  }
};

async function formatTimestamp(eventdatetime) {
  const date = moment(eventdatetime);
  const week = date.week();
  const offset = week >= 11 && week <= 44 ? "-0500" : "-0600";
  return date.format("YYYY-MM-DDTHH:mm:ss") + offset;
}