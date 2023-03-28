const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');
const axios = require("axios")
const { mapStatus } = require("../shared/datamapping");
const { putItem, allqueries, get } = require("../shared/dynamo")
const { run } = require("../shared/tokengenerator")


module.exports.handler = async (event, context) => {

    console.log("event:", event)
    const records = event.Records;
    const id = uuidv4();

    for (const record of records) {
        try {
            // Check if the event is an INSERT or MODIFY operation
            if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
                return {
                    body: "Skipping the record as it's not INSERT or MODIFY"
                };
            }
            const newImage = record.dynamodb.NewImage;
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
            const referenceNo = referenceResult.Items[0].ReferenceNo.S;
            console.log('ReferenceNo:', referenceNo);
            if (referenceResult.Items.length === 0) {
                console.log(`No Bill of Lading found for order ${orderNo}`);
                continue;
            }
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
            console.log("headerResult:", headerResult)
            console.log(!headerResult.Item.BillNo.S)
            if (!headerResult.Item || !(process.env.MCKESSON_CUSTOMER_NUMBERS).includes(headerResult.Item.BillNo.S)) {
                console.log("MCKESSON_CUSTOMER_NUMBERS:", process.env.MCKESSON_CUSTOMER_NUMBERS)
                console.log("BillNo:", headerResult.Item.BillNo)
                console.log(`Skipping record with invalid Bill of Lading ${billOfLading}`);
                continue;
            }

            // Querying the tracking notes table to get the eventDateTime
            // const trackingparams = {
            //     TableName: process.env.TRACKING_NOTES_TABLE_NAME,
            //     IndexName: process.env.TRACKING_NOTES_ORDERNO_INDEX,
            //     KeyConditionExpression: `FK_OrderNo = :orderNo`,
            //     ExpressionAttributeValues: {
            //         ":orderNo": { S: orderNo }
            //     }
            // };
            // const trackingnotesResult = await allqueries(trackingparams);
            // console.log("trackingnotesResult", JSON.stringify(trackingnotesResult))
            // if (trackingnotesResult.Items.length == 0) {
            //     throw "trackingnotesResult have no values"
            // }
            const eventDateTime = newImage.EventDateTime.S;
            // const eventDateTime = trackingnotesResult.Items[0].EventDateTime.S;
            console.log("eventDateTime", eventDateTime)
            let utcTimestamp = new Date(eventDateTime).toISOString();
            utcTimestamp = utcTimestamp.slice(0, -5);
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
                utcTimestamp,
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
            // Saving the response code and payload in DynamoDB
            console.log(id, billOfLading)
            const milestoneparams = {
                TableName: process.env.P44_MILESTONE_LOGS_TABLE_NAME,
                Item: {
                    UUID: id,
                    ReferenceNo: billOfLading,
                    p44ResponseCode: p44Response.status,
                    p44Payload: JSON.stringify(payload)
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