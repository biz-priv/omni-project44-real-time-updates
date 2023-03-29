const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');
const axios = require("axios")
const { putItem, get, allqueries } = require("../shared/dynamo")
const { run } = require("../shared/tokengenerator")
const moment = require('moment');



module.exports.handler = async (event, context) => {
    console.log("event:", JSON.stringify(event))
    const records = event.Records;
    const id = uuidv4();

    for (const record of records) {
        try {
            console.log('Processing record:', JSON.stringify(record));
            const body = (record.body);
            const newImage = body.NewImage;
            // const note = newImage.Note.S;
            const orderNo = newImage.FK_OrderNo.S;
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
            const note = trackingResult.Items[0].Note.S;
            const lat = note.split('Latitude=')[1].split(' ')[0];
            const long = note.split('Longitude=')[1].split(' ')[0];
            if (trackingResult.Items.length > 0) {
                console.log("note:", note)
                console.log("Latitude:", lat)
                console.log("Longitude:", long)
            } else {
                console.log("No Location Updates found for orderNo:", orderNo);
                return null;
            }

            const Params = {
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
            console.log("Params", Params)
            const referenceResult = await allqueries(Params);
            console.log("referenceResult", referenceResult)
            console.log("test")
            const referenceNo = referenceResult.Items[0].ReferenceNo.S;
            console.log('ReferenceNo:', referenceNo);
            if (referenceResult.Items.length === 0) {
                console.log(`No Bill of Lading found for order ${orderNo}`);
                continue;
            }

            const billOfLading = referenceNo;

            const milestoneparams = {
                TableName: process.env.SHIPMENT_MILESTONE_TABLE_NAME,
                KeyConditionExpression: `FK_OrderNo = :orderNo`,
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                },
            };
            console.log("milestoneparams:", milestoneparams)
            const milestoneResult = await allqueries(milestoneparams);
            const eventTimezone = milestoneResult.Items[0].EventTimeZone.S;
            console.log("eventTimezone:",eventTimezone)
            for (let i = 0; i < milestoneResult.Items.length; i++) {
                let fkOrderNo = milestoneResult.Items[i].FK_OrderNo.S;
                if (fkOrderNo == orderNo) {
                    console.log("Order numbers matched");
                } else {
                    console.log("Order numbers do not match");
                    break;
                }
            }
            const headerparams = {
                TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
                Key: {
                    PK_OrderNo: { S: orderNo }
                },
                ProjectionExpression: "BillNo"
            };
            console.log("headerparams:", headerparams)
            const headerResult = await get(headerparams);
            console.log("headerResult:", headerResult)
            const BillNo = headerResult.Item.BillNo.S;
            console.log("BillNo:", BillNo)
            if (!headerResult.Item || !(process.env.MCKESSON_CUSTOMER_NUMBERS).includes(BillNo)) {
                console.log("MCKESSON_CUSTOMER_NUMBERS:", process.env.MCKESSON_CUSTOMER_NUMBERS)
                console.log(`Skipping record with invalid Bill of Lading ${billOfLading}`);
                continue;
            }

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
                throw "trackingnotesResult have no values"
            }
            const eventDateTime = trackingnotesResult.Items[0].EventDateTime.S;
            console.log("eventDateTime", eventDateTime)
            const timezoneparams = {
                TableName: process.env.TIME_ZONE_TABLE_NAME,
                KeyConditionExpression: `PK_TimeZoneCode = :code`,
                ExpressionAttributeValues: {
                    ":code": { S: eventTimezone }
                }
            };
            console.log("timezoneparams:",timezoneparams)
            const timezoneResult = await allqueries(timezoneparams);
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
                latitude: lat,
                longitude: long,
                utcTimestamp: utcTimestamp,
                customerId: "MCKESSON",
                eventType: "POSITION"
            };
            console.log("payload:", payload)
            const getaccesstocken = await run()
            console.log("getaccesstocken", getaccesstocken)
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
            console.log("pushed payload to P44 Api successfully")
            console.log("p44Response", p44Response)
            // Save response code and payload in DynamoDB
            console.log(id, billOfLading)
            const dynamoParams = {
                TableName: process.env.P44_MILESTONE_LOGS_TABLE_NAME,
                Item: {
                    UUID: id,
                    ReferenceNo: billOfLading,
                    p44ResponseCode: p44Response.status,
                    p44Payload: JSON.stringify(payload)
                }
            };
            const result = await putItem(dynamoParams);
            console.log("record is inserted successfully")
        } catch (error) {
            console.error(error);
            return error
        }
    }
}