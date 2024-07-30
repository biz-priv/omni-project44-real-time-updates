/*
* File: src\realtime\ltlUpdates\p44_ltl_location_updates.js
* Project: Omni-project44-real-time-updates
* Author: Bizcloud Experts
* Date: 2024-04-19
* Confidential and Proprietary
*/
const AWS = require("aws-sdk");
const axios = require("axios");
const { putItem, allqueries } = require("../../shared/dynamo");
const { run } = require("../../shared/tokengenerator");
const moment = require("moment-timezone");
const Flatted = require("flatted");
const _ = require("lodash");
const NodeGeocoder = require('node-geocoder');
const sns = new AWS.SNS();

module.exports.handler = async (event, context) => {
    console.info("Received event:", JSON.stringify(event));
    const records = event.Records;

    const promises = records.map(async (record) => {
        let milestoneparams = {};
        let houseBill;
        let timeStamp;
        let referenceNo;
        let p44Response;
        let payload;
        const InsertedTimeStamp = moment()
            .tz("America/Chicago")
            .format("YYYY-MM-DDTHH:mm:ss");
        try {
            const body = JSON.parse(record.body);
            const message = JSON.parse(_.get(body, "Message", {}));
            const newImage = _.get(message, "dynamodb.NewImage", {});
            houseBill = _.get(newImage, "HouseBillNo.S");
            const longi = _.get(newImage, "longitude.N");
            const lati = _.get(newImage, "latitude.N");

            const address = await getAddress(lati, longi);

            console.info("address", address);

            const headerparams = {
                TableName: process.env.SHIPMENT_HEADER_TABLE_NAME,
                IndexName: "Housebill-index",
                KeyConditionExpression: `Housebill = :value`,
                ExpressionAttributeValues: { ":value": { S: houseBill } },
            };
            const headerResult = await allqueries(headerparams);
            const items = headerResult.Items;
            let BillNo;
            let fkServicelevelId;
            let orderNo;

            if (items && items.length > 0) {
                BillNo = _.get(items, "[0].BillNo.S");
                fkServicelevelId = _.get(items, "[0].FK_ServiceLevelId.S");
                orderNo = _.get(items, "[0].PK_OrderNo.S");
                console.info("BillNo:", BillNo);
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

            if (process.env.MCKESSON_CUSTOMER_NUMBERS.includes(BillNo) && !["HS", "FT"].includes(fkServicelevelId)) {
                console.info(`This is MCKESSON_CUSTOMER_NUMBERS`);
                customerName = process.env.MCKESSON_CUSTOMER_NAME;
                endpoint = process.env.P44_LTL_LOCATION_UPDATES_API;
            }
            if (customerName === "") {
                console.info(
                    `Skipping the record as the BillNo does not match with valid customer numbers`
                );
                return;
            }

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
                referenceNo = _.get(referenceResult.Items, "[0].ReferenceNo.S");
            }

            const utcTimeStamp = _.get(newImage, "UTCTimeStamp.S");
            const timezone = "CST";
            const timeStamp = await formatTimestamp(utcTimeStamp, timezone);
            payload = {
                customerAccount: {
                    accountIdentifier: customerName,
                },
                carrierIdentifier: {
                    type: "SCAC",
                    value: "OMNG",
                },

                shipmentIdentifiers: [],
                statusCode: "INFO",
                statusReason: {
                    "reasonSummaryCode": "INFO_MESSAGE",
                    "description": "IN-TRANSIT"
                },
                location: {
                    "address": {
                        "city": address.city,
                        "state": address.state,
                        "country": address.country
                    }
                },
                timestamp: timeStamp,
                sourceType: "API",
            };
            if (customerName === process.env.MCKESSON_CUSTOMER_NAME) {
                payload.shipmentIdentifiers.push({
                    type: "PRO",
                    value: referenceNo,
                    primaryForType: false,
                    source: "CAPACITY_PROVIDER",
                },
                    {
                        type: "BILL_OF_LADING",
                        value: referenceNo,
                        primaryForType: false,
                        source: "CAPACITY_PROVIDER",
                    });
            }
            console.info("payload:", JSON.stringify(payload));
            const getaccesstocken = await run();
            p44Response = await axios.post(endpoint, payload, {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${getaccesstocken}`,
                },
            });
            console.info("p44Response", p44Response);
            milestoneparams = {
                TableName: process.env.P44_LOCATION_LOGS_TABLE_NAME,
                Item: {
                    Housebill: houseBill,
                    TimeStamp: timeStamp,
                    ReferenceNo: referenceNo,
                    P44ResponseCode: p44Response.status,
                    P44Payload: JSON.stringify(payload),
                    InsertedTimeStamp,
                    Status: "SUCCESS",
                    Expiration: getExpirationTimestamp(30)
                },
            };
            await putItem(milestoneparams);
            console.info("Record is inserted successfully");
        } catch (error) {
            milestoneparams = {
                TableName: process.env.P44_LOCATION_LOGS_TABLE_NAME,
                Item: {
                    Housebill: houseBill,
                    TimeStamp: timeStamp,
                    ReferenceNo: referenceNo ?? "",
                    P44ResponseCode: p44Response.status ?? "",
                    P44Payload: JSON.stringify(payload) ?? "",
                    InsertedTimeStamp,
                    Status: "FAILED",
                    Expiration: getExpirationTimestamp(30),
                    ErrMessage: error
                },
            };
            await putItem(milestoneparams);
            console.error(error);
            try {
                const params = {
                  Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nHouse Bill: ${houseBill}.\n\nReferenceNo: ${referenceNo}`,
                  Subject: `An error occurred in function ${context.functionName}`,
                  TopicArn: process.env.ERROR_SNS_TOPIC_ARN,
                };
                await sns.publish(params).promise();
                console.info('SNS notification has been sent');
              } catch (err) {
                console.error('Error while sending SNS notification: ', err);
              }
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

async function getAddress(latitude, longitude) {
    const googleApiRes = await getAddressUsingGeocoder({ lat: latitude, long: longitude });
    console.info(':slightly_smiling_face: -> file: index.js:3 -> getAddress -> googleApiRes:', googleApiRes);
    const city = _.get(googleApiRes, '0.city');
    const state = _.get(googleApiRes, '0.administrativeLevels.level1short');
    const country = _.get(googleApiRes, '0.countryCode');
    console.info('��� -> file: index.js:3 -> getAddress -> city:', city, state, country);
    return { city, state, country };
}

async function getAddressUsingGeocoder({ lat, long }) {
    const options = {
        provider: 'google',
        apiKey: process.env.GOOGLE_API_KEY,
    };

    const geocoder = NodeGeocoder(options);

    return await geocoder.reverse({ lat, lon: long });
}

function getExpirationTimestamp(days) {
    const dayMilliseconds = 86400000;
    const expiration = Date.now() + days * dayMilliseconds;
    return Math.floor(expiration / 1000);
}
