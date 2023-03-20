const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');
const dynamo = new AWS.DynamoDB({ apiVersion: "2012-08-10" });

// Define the DynamoDB table names
const SHIPMENT_MILESTONE_TABLE_NAME = "omni-wt-rt-shipment-milestone-dev";
const REFERENCES_TABLE_NAME = "omni-wt-rt-references-dev";
const SHIPMENT_HEADER_TABLE_NAME = "omni-wt-rt-shipment-header-dev";
const UPDATE_TABLE_NAME = "omni-dw-p44-tl-update-dev";

exports.handler = async (event, context) => {
    const records = event.Records;

    for (const record of records) {
        try {
            const oldImage = record.dynamodb.OldImage;
            const newImage = record.dynamodb.NewImage;

            // Get the FK_OrderNo and FK_OrderStatusId from the shipment milestone table
            const orderNo = newImage.FK_OrderNo.S;
            const orderStatusId = newImage.FK_OrderStatusId.S;
            // const orderNo = "4744820";
            // const orderStatusId ="DEL";

            // Check whether the order status is valid
            const validStatusCodes = ["APL", "TTC", "COB", "AAD", "DEL", "CAN"];
            if (!validStatusCodes.includes(orderStatusId)) {
                console.log(`Skipping record with order status ${orderStatusId}`);
                continue;
            }

            const Params = {
                TableName: REFERENCES_TABLE_NAME,
                FilterExpression: 'FK_OrderNo = :orderNo and CustomerType = :customerType and FK_RefTypeId = :refType',
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo },
                    ":customerType": { S: "B" },
                    ":refType": { S: "BOL" }
                },
            };
            console.log("Params", Params)
            const referenceResult = await dynamo.scan(Params).promise();
            console.log("referenceResult", referenceResult)
            const referenceNo = referenceResult.Items[0].ReferenceNo.S;
            console.log('ReferenceNo:', referenceNo);
            if (referenceResult.Items.length === 0) {
                console.log(`No Bill of Lading found for order ${orderNo}`);
                continue;
            }

            const billOfLading = referenceResult.Items[0].ReferenceNo;

            // Check whether the Bill of Lading belongs to MCKESSON customer
            const params2 = {
                TableName: SHIPMENT_HEADER_TABLE_NAME,
                Key: {
                    PK_OrderNo: { S: orderNo }
                },
                ProjectionExpression: "BillNo"
            };
            console.log("params2:", params2)
            const headerResult = await dynamo.getItem(params2).promise();
            console.log("headerResult:", headerResult)
            console.log(!headerResult.Item.BillNo)
            if (!headerResult.Item || !["22209", "22210", "21719"].includes(headerResult.Item.BillNo)) {
                console.log("BillNo:", headerResult.Item.BillNo)
                console.log(`Skipping record with invalid Bill of Lading ${billOfLading}`);
                continue;
            }

            // Query the tracking notes table to get the eventDateTime
            const params3 = {
                TableName: `omni-wt-rt-tracking-notes-dev`,
                FilterExpression: "FK_OrderNo = :orderNo",
                ExpressionAttributeValues: {
                    ":orderNo": { S: orderNo }
                }
            };
            const trackingnotesResult = await dynamo.scan(params3).promise();
            const eventDateTime = trackingnotesResult.Item.EventDateTime;
            const utcTimestamp = new Date(eventDateTime).toISOString();

            function mapStatus(validStatusCodes) {
                switch (validStatusCodes) {
                    case 'APL':
                        return {
                            type: 'ARRIVED',
                            StopNumber: 1
                        };
                    case 'TTC':
                        return {
                            type: 'LOADING',
                            StopNumber: 1
                        };
                    case 'COB':
                        return {
                            type: 'DEPARTED',
                            StopNumber: 1
                        };
                    case 'AAD':
                        return {
                            type: 'UNLOADING',
                            StopNumber: 2
                        };
                    case 'DEL':
                        return {
                            type: 'DELIVERED',
                            StopNumber: 2
                        };
                    case 'CAN':
                        return {
                            type: 'CANCELLED',
                            StopNumber: 2
                        };
                    default:
                        return null;
                }
            }
            const mappedStatus = mapStatus(validStatusCodes);

            // Construct the payload
            const payload = {
                shipmentIdentifiers: [
                    {
                        type: "BILL_OF_LADING",
                        value: billOfLading
                    }
                ],
                utcTimestamp,
                customerId: "MCKESSON",
                eventStopNumber: mappedStatus.StopNumber,
                eventType: mappedStatus.type
            };
            console.log("payload:", payload)
            // Call P44 API with the constructed payload
            // const p44Response = await axios.post(
            //     process.env.P44_URL,
            //     payload,
            //     {
            //         headers: {
            //             'Content-Type': 'application/json',
            //             'Authorization': `Bearer ${process.env.P44_API_KEY}`
            //         }
            //     }
            // );
            const id = uuidv4();
            // Save response code and payload in DynamoDB
            const dynamoParams = {
                TableName: UPDATE_TABLE_NAME,
                Item: {
                    PK: `id#${id}`,
                    SK: `ORDER#${orderId}`,
                    eventType: payload.eventType,
                    eventStopNumber: payload.eventStopNumber,
                    p44ResponseCode: p44Response.status,
                    p44Payload: JSON.stringify(payload)
                }
            };
            await dynamo.put(dynamoParams).promise();
        } catch (error) {
            console.error(error);
            throw new Error(`Error processing reference number `);
        }
    }
}