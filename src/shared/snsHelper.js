const AWS = require("aws-sdk");
const sns = new AWS.SNS({ apiVersion: "2010-03-31" });

/**
 * doing sns publish based on the parameters
 * @param {*} dBbStreamData
 * @param {*} TopicArn
 * @param {*} tableName
 * @param {*} MessageAttributes
 * @returns
 */
function snsPublish(
  dBbStreamData,
  TopicArn,
  tableName,
  MessageAttributes = null
) {
  return new Promise(async (resolve, reject) => {
    try {
      const Message = JSON.stringify({
        ...dBbStreamData.dynamodb,
        dynamoTableName: tableName,
      });
      const params = {
        Message,
        TopicArn,
        ...(MessageAttributes == null ? {} : { MessageAttributes }),
      };
      //SNS service
      const response = await sns.publish(params).promise();
      console.log("SNS publish:: ", response);
      resolve("Success");
    } catch (error) {
      console.log("SNSPublishError: ", error);
      resolve("Failed");
    }
  });
}
module.exports = { snsPublish };
