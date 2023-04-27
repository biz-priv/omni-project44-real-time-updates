const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');
const axios = require("axios")
const { mapStatus } = require("../shared/datamapping");
const { putItem, allqueries, get } = require("../shared/dynamo")
const { run } = require("../shared/tokengenerator")
const moment = require('moment-timezone');
const Flatted = require('flatted');

module.exports.handler = async (event, context) => {

    console.log('Received event:', JSON.stringify(event));
    const records = event.Records;
    const id = uuidv4();

    for (const record of records) {
        try {
            console.log('Processing record:', JSON.stringify(record));
            const body = JSON.parse(record.body);
            const newImage = body.NewImage;
            // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
            const orderNo = newImage.FK_OrderNo.S;
            const orderStatusId = newImage.FK_OrderStatusId.S;


            // Check whether the order status is valid
            const validStatusCodes = ["APL", "TTC", "COB", "AAD", "DEL", "CAN"];
            if (!validStatusCodes.includes(orderStatusId)) {
                console.log(`Skipping record with order status ${orderStatusId}`);
                continue;
            }

            const referenceparams = {
                TableName: process.env.REFERENCES_TABLE_NAME,
                IndexName: process.env.REFERENCES_ORDERNO_INDEX,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                FilterExpression: 'CustomerType = :customerType and FK_RefTypeId = :refType',
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                    ":customerType": { S: "B" },
                    ":refType": { S: "BOL" }
                },
            };
            console.log("referenceparams:", referenceparams)
            const referenceResult = await allqueries(referenceparams);
            console.log("referenceResult", referenceResult)
            if (referenceResult.Items.length === 0) {
                console.error(`No Bill of Lading found for order ${orderNo}`);
                continue;
            }
            const referenceNo = referenceResult.Items[0].ReferenceNo.S;
            console.log('ReferenceNo:', referenceNo);
            const billOfLading = referenceNo;
            // Checking whether the Bill belongs to MCKESSON customer
            const headerparams = {
                TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
                Key: {
                    PK_OrderNo: { S: orderNo }
                },
                ProjectionExpression: "BillNo"
            };
            console.log("headerparams:", headerparams)
            const headerResult = await get(headerparams);
            if (headerResult.Item.length == 0) {
                throw "headerResult have no values";
            }
            console.log("headerResult:", headerResult)
            if (!headerResult.Item || !(process.env.MCKESSON_CUSTOMER_NUMBERS).includes(headerResult.Item.BillNo.S)) {
                console.log("BillNo:", headerResult.Item.BillNo)
                console.error(`Skipping the record as the BillNo does not match  MCKESSON customer`);
                continue;
            }

            // Querying the tracking notes table to get the eventDateTime
            const trackingparams = {
                TableName: process.env.TRACKING_NOTES_TABLE_NAME,
                IndexName: process.env.TRACKING_NOTES_ORDERNO_INDEX,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo }
                }
            };
            const trackingnotesResult = await allqueries(trackingparams);
            console.log("trackingnotesResult", JSON.stringify(trackingnotesResult))
            if (trackingnotesResult.Items.length == 0) {
                throw "trackingnotesResult have no values"
            }
            const eventDateTime = trackingnotesResult.Items[0].EventDateTime.S;
            const eventTimezone = newImage.EventTimeZone.S;
            console.log("eventTimezone", eventTimezone)
            const timezoneparams = {
                TableName: process.env.TIME_ZONE_TABLE_NAME,
                KeyConditionExpression: `PK_TimeZoneCode = :code`,
                ExpressionAttributeValues: {
                    ":code": { S: eventTimezone }
                }
            };
            console.log("timezoneparams:", timezoneparams)
            const timezoneResult = await allqueries(timezoneparams);
            if (timezoneResult.Items.length === 0) {
                console.error(`timezoneResult have no values`);
                continue;
            }
            const hoursaway = timezoneResult.Items[0].HoursAway.S;
            const utcTimestamp = moment(eventDateTime).add(5 - hoursaway, 'hours').format('YYYY-MM-DDTHH:mm:ss');
            const mappedStatus = await mapStatus(orderStatusId);
            console.log("orderStatusId", orderStatusId)
            console.log("mappedStatus", mappedStatus)

            // Construct the payload
            const payload = {
                shipmentIdentifiers: [
                    {
                        type: "BILL_OF_LADING",
                        value: billOfLading
                    }
                ],
                utcTimestamp: utcTimestamp,
                latitude: "0",
                longitude: "0",
                customerId: "MCKESSON",
                eventStopNumber: mappedStatus.stopNumber,
                eventType: mappedStatus.type
            };
            console.log("payload:", payload)
            // generating token with P44 oauth API 
            const getaccesstocken = await run()
            console.log("getaccesstocken", getaccesstocken)
            // Calling P44 API with the constructed payload
            const p44Response = await axios.post(
                process.env.P44_STATUS_UPDATES_API,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${getaccesstocken}`
                    }
                }
            );
            console.log("p44Response", p44Response)
            // Inserted time stamp in CST format
            const InsertedTimeStamp = moment().tz('America/Chicago').format("YYYY-MM-DDTHH:mm:ss")
            // Saving the response code and payload in DynamoDB
            console.log(id, billOfLading)
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
                    p44Response: jsonp44Response,          // Added json P44 response 
                    InsertedTimeStamp
                }
            };
            const result = await putItem(milestoneparams);
            console.log("record is inserted successfully")
        } catch (error) {
            console.error(error);
            return error
        }
    }
}