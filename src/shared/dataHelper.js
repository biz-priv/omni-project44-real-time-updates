const { snsPublish } = require("./snsHelper");



/**
 * preparing the payload for sqs of failed sqs events
 * @param {*} data
 * @returns
 */
function prepareBatchFailureObj(data) {
  const batchItemFailures = data.map((e) => ({
    itemIdentifier: e.messageId,
  }));
  console.log("batchItemFailures", batchItemFailures);
  return { batchItemFailures };
}

/**
 * main function for all dynamodb to sns lambdas
 * @param {*} event
 * @param {*} TopicArn
 * @param {*} tableName
 * @param {*} msgAttName
 * @returns
 */
function processDynamoDBStream(event, TopicArn, tableName, msgAttName = null) {
  return new Promise(async (resolve, reject) => {
    try {
      const records = event.Records;
      let messageAttributes = null;
      for (let index = 0; index < records.length; index++) {
        try {
          const element = records[index];
          if (element.eventName === "REMOVE") {
            console.log("Dynamo REMOVE event");
            continue;
          }
          if (msgAttName != null) {
            const msgAttValue = element.dynamodb.NewImage[msgAttName].S;
            console.log("msgAttValue", msgAttValue);
            messageAttributes = {
              [msgAttName]: {
                DataType: "String",
                StringValue: msgAttValue.toString(),
              },
            };
            console.log("messageAttributes", messageAttributes);
          }
          await snsPublish(element, TopicArn, tableName, messageAttributes);
        } catch (error) {
          console.log("error:forloop", error);
        }
      }
      resolve("Success");
    } catch (error) {
      console.log("error", error);
      resolve("process failed Failed");
    }
  });
}

module.exports = {
  prepareBatchFailureObj,
  processDynamoDBStream,
};
