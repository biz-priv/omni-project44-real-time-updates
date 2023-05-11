const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');
const axios = require("axios");
const { putItem, allqueries } = require("../shared/dynamo");
const { run } = require("../shared/tokengenerator");
const moment = require('moment-timezone');
const Flatted = require('flatted');


module.exports.handler = async (event, context) => {
    console.log("event:", JSON.stringify(event));
    const records = event.Records;
    const id = uuidv4();

    for (const record of records) {
        try {
            console.log('Processing record:', JSON.stringify(record));
            const body = JSON.parse(record.body);
            const newImage = body.NewImage;
            const orderNo = newImage.FK_OrderNo.S;
            const note = newImage.Note.S;
            console.log("note:", note);

            const trackingparams = {
                TableName: process.env.TRACKING_NOTES_TABLE_NAME,
                IndexName: process.env.TRACKING_NOTES_ORDERNO_INDEX,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                FilterExpression: 'contains(Note, :lat) and contains(Note, :long)',
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                    ":lat": { S: "Latitude" },
                    ":long": { S: "Longitude" }
                }
            };
            const trackingResult = await allqueries(trackingparams);
            console.log("trackingResult:", trackingResult);
            if (trackingResult.Items.length === 0) {
                console.log("No Location Updates found for orderNo:", orderNo);
                continue;
            }
            let latitude;
            let longitude;
            // Extract latitude and longitude values from the note string using regular expressions
            const latRegex = /Latitude=(-?\d+(\.\d+)?)/;
            const longRegex = /Longitude=(-?\d+(\.\d+)?)/;
            const latMatch = latRegex.exec(note);
            const longMatch = longRegex.exec(note);
            if (latMatch && longMatch) {
                latitude = latMatch[1];
                longitude = longMatch[1];
                console.log("Latitude:", latitude);
                console.log("Longitude:", longitude);
            } else {
                console.log("No Location Updates:", note);
                continue;
            }

            const headerparams = {
                TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
                KeyConditionExpression: `PK_OrderNo = :orderNo`,
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                },
            };
            console.log("headerparams:", headerparams)
            const headerResult = await allqueries(headerparams);
            const items = headerResult.Items;
            let BillNo;
            let houseBill;
            if (items && items.length > 0) {
                BillNo = items[0].BillNo.S;
                houseBill = items[0].Housebill.S;
                console.log("BillNo:", BillNo);
                console.log("Housebill:", houseBill);
            } else {
                console.log("headerResult have no values");
                continue;
            }
            console.log("BillNo:", BillNo);
            if (!headerResult.Items) {
                console.log(`Skipping the record as headerResult.Item is falsy`);
                continue;
            }
            let customerId = "";
            if ((process.env.MCKESSON_CUSTOMER_NUMBERS).includes(BillNo)) {
                console.log(`This is MCKESSON_CUSTOMER_NUMBERS`);
                customerId = "MCKESSON";
            }
            if ((process.env.IMS_CUSTOMER_NUMBER).includes(BillNo)) {
                console.log(`This is IMS_CUSTOMER_NUMBER`);
                customerId = "IMS";
            }
            if (customerId === "") {
                console.log(`Skipping the record as the BillNo does not match with valid customer numbers`);
                continue;
            }

            let billOfLading
            let referenceNo;
            if (customerId === 'MCKESSON') {
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
                    console.log(`No Bill of Lading found for order ${orderNo}`);
                } else {
                    referenceNo = referenceResult.Items[0].ReferenceNo.S;
                    console.log('ReferenceNo:', referenceNo);
                }
            }
            if (customerId == "IMS") {
                billOfLading = houseBill
            } else {
                billOfLading = referenceNo;
            }
            console.log("billOfLading", billOfLading);

            const milestoneparams = {
                TableName: process.env.SHIPMENT_MILESTONE_TABLE_NAME,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                },
            };
            console.log("milestoneparams:", milestoneparams);
            const milestoneResult = await allqueries(milestoneparams);
            for (let i = 0; i < milestoneResult.Items.length; i++) {
                let fkOrderNo = milestoneResult.Items[i].FK_OrderNo.S;
                if (fkOrderNo == orderNo) {
                    console.log("Order numbers matched");
                } else {
                    console.log("Order numbers do not match");
                    break;
                }
            }
            const eventTimezone = milestoneResult.Items[0].EventTimeZone.S;
            console.log("eventTimezone:", eventTimezone);

            // Query the tracking notes table to get the eventDateTime
            const trackingnotesparams = {
                TableName: process.env.TRACKING_NOTES_TABLE_NAME,
                IndexName: process.env.TRACKING_NOTES_ORDERNO_INDEX,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo }
                }
            };
            const trackingnotesResult = await allqueries(trackingnotesparams);
            if (trackingnotesResult.Items.length == 0) {
                console.log("trackingnotesResult have no values");
                continue;
            }
            // const eventDateTime = trackingnotesResult.Items[0].EventDateTime.S;
            const eventDateTime = newImage.EventDateTime.S;
            console.log("eventDateTime", eventDateTime);
            const timezoneparams = {
                TableName: process.env.TIME_ZONE_TABLE_NAME,
                KeyConditionExpression: `PK_TimeZoneCode = :code`,
                ExpressionAttributeValues: {
                    ":code": { S: eventTimezone }
                }
            };
            console.log("timezoneparams:", timezoneparams);
            const timezoneResult = await allqueries(timezoneparams);
            if (timezoneResult.Items.length === 0) {
                console.log(`timezoneResult have no values`);
                continue;
            }
            const hoursaway = timezoneResult.Items[0].HoursAway.S;
            const utcTimestamp = moment(eventDateTime).add(5 - hoursaway, 'hours').format('YYYY-MM-DDTHH:mm:ss');

            // Construct the payload
            const payload = {
                shipmentIdentifiers: [
                    {
                        type: "BILL_OF_LADING",
                        value: billOfLading
                    }
                ],
                latitude: latitude,
                longitude: longitude,
                utcTimestamp: utcTimestamp,
                customerId: customerId,
                eventType: "POSITION"
            };
            console.log("payload:", payload);
            // generating token with P44 oauth API 
            const getaccesstocken = await run();
            console.log("getaccesstocken", getaccesstocken);
            // Call P44 API with the constructed payload
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
            console.log("pushed payload to P44 Api successfully");
            console.log("p44Response", p44Response);
            // Inserted time stamp in (YYYY-MM-DDTHH:mm:ss) ISO format
            const InsertedTimeStamp = moment().tz('America/Chicago').format("YYYY-MM-DDTHH:mm:ss")

            // As json stringyfy is not supported for converting circular reference object to string
            // used Flatted npm package
            const jsonp44Response = Flatted.stringify(p44Response);
            // Save response code and payload in DynamoDB
            console.log(id, billOfLading);
            const dynamoParams = {
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
            const result = await putItem(dynamoParams)
            console.log("record is inserted successfully");
        } catch (error) {
            console.error(error);
            return error;
        }
    }
};