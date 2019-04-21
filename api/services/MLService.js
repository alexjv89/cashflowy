var AWS = require('aws-sdk');
var machinelearning = new AWS.MachineLearning({
    accessKeyId: sails.config.aws.key,
    secretAccessKey: sails.config.aws.secret,
    region: sails.config.aws.region
});

var async = require('async');

module.exports = {
    predictCategory: function (tli, cb) {
        async.auto({
            getAccount: function (cb) {
                Account.findOne(tli.account).exec(cb);
            },
            createPredictionPayload: ['getAccount', function (results, cb) {
                var payload = {
                    // createdBy: tli.createdBy,
                    // description: tli.description,
                    // account: tli.account ? tli.account.toString() : '',
                    // to_account: tli.to_account ? tli.to_account.toString() : '',
                    third_party: tli.third_party,
                }
                // payload = _.pick(payload, _.identity);
                cb(null, payload)
            }],
            getPrediction: ['createPredictionPayload', function (results, cb) {
                var params = {
                    MLModelId: sails.config.aws.category_model_id, /* required */
                    PredictEndpoint: sails.config.aws.prediction_endpoint, /* required */
                    Record: results.createPredictionPayload
                };
                machinelearning.predict(params, function (err, data) {
                    if (err) {
                        console.log(err, err.stack);
                        return cb(err);
                    } // an error occurred
                    else return cb(null, data);           // successful response
                });
            }],
            findOrCreateCategory: ['getPrediction', function (results, cb) {
                // for initial trail, only categorize if category belongs to org
                var category_name = results.getPrediction.Prediction.predictedLabel
                Category.find({ name: category_name, org: results.getAccount.org }).exec(cb);
            }],
            addCategoryToTli: ['findOrCreateCategory', function (results, cb) {
                if (!_.get(results, 'findOrCreateCategory[0]', null)) return cb(null);
                Transaction_line_item.update(tli.id, { category: results.findOrCreateCategory[0].id }).exec(cb);
            }],
            addPredictionTag: ['findOrCreateCategory', async function (results, cb) {
                if (!_.get(results, 'findOrCreateCategory[0]', null)) return cb(null);

                Tag.findOrCreate({ name: 'predicted_category', type: 'global' },
                    { name: 'predicted_category', type: 'global' }).exec(async function (err, tag) {
                        try {
                            await Tag.addToCollection(tag.id, 'tlis').members([tli.id]).tolerate('E_UNIQUE');
                            return cb(null);
                        } catch (err) {
                            return cb(err);
                        }
                    })
            }]
        }, cb);
    }
}