const { processDynamoDBStream } = require("../shared/dataHelper");

module.exports.handler = async (event, context, callback) => {
  console.info("event", JSON.stringify(event));
  return await processDynamoDBStream(
    event,
    process.env.SNS_TOPIC_ARN,
    process.env.DYNAMO_DB_TABLE,
    "FK_UserId"
  );
};
