'use strict';

var Q = require('q'),
    helpers = require('../util/helpers'),
    exceptions = require('../util/errors'),
    url = require('url');

function create (protocols, imposters, Imposter, logger) {

    function queryIsFalse (query, key) {
        if (!query.hasOwnProperty(key)) {
            return true;
        }
        return query[key].toLowerCase() !== 'false';
    }

    function queryBoolean (query, key) {
        if (!query.hasOwnProperty(key)) {
            return false;
        }
        return query[key].toLowerCase() === 'true';
    }

    function deleteAllImposters () {
        Object.keys(imposters).forEach(function (id) {
            imposters[id].stop();
            delete imposters[id];
        });
    }

    function validatePort (port, errors) {
        var portIsValid = (port === undefined) ||
            (port.toString().indexOf('.') === -1 && port > 0 && port < 65536);

        if (!portIsValid) {
            errors.push(exceptions.ValidationError("invalid value for 'port'"));
        }
    }

    function validateProtocol (protocol, errors) {
        var Protocol = protocols[protocol];

        if (typeof protocol === 'undefined') {
            errors.push(exceptions.ValidationError("'protocol' is a required field"));
        }
        else if (!Protocol) {
            errors.push(exceptions.ValidationError('the ' + protocol + ' protocol is not yet supported'));
        }
    }

    function validate (request, logger) {
        var errors = [],
            valid = Q({ isValid: false, errors: errors });

        validatePort(request.port, errors);
        validateProtocol(request.protocol, errors);

        if (errors.length > 0) {
            return valid;
        }
        else {
            return protocols[request.protocol].Validator.create().validate(request, logger);
        }
    }

    function respondWithValidationErrors (response, validationErrors) {
        logger.warn('error creating imposter: ' + JSON.stringify(exceptions.details(validationErrors)));
        response.statusCode = 400;
        response.send({ errors: validationErrors });
    }

    function respondWithCreationError (response, error) {
        logger.warn('error creating imposter: ' + JSON.stringify(exceptions.details(error)));
        response.statusCode = (error.code === 'insufficient access') ? 403 : 400;
        response.send({ errors: [error] });
    }

    function get (request, response) {
        response.format({
            json: function () {
                var query = url.parse(request.url, true).query,
                    options = {
                        replayable: queryBoolean(query, 'replayable'),
                        removeProxies: queryBoolean(query, 'removeProxies'),
                        list: !(queryBoolean(query, 'replayable') || queryBoolean(query, 'removeProxies'))
                    },
                    result = Object.keys(imposters).reduce(function (accumulator, id) {
                        return accumulator.concat(imposters[id].toJSON(options));
                    }, []);

                response.send({ imposters: result });
            },
            html: function () {
                var result = Object.keys(imposters).reduce(function (accumulator, id) {
                    return accumulator.concat(imposters[id].toJSON());
                }, []);

                response.render('imposters', { imposters: result });
            }
        });
    }

    function post (request, response) {
        var protocol = request.body.protocol,
            validationPromise = validate(request.body, logger);

        logger.debug(helpers.socketName(request.socket) + ' => ' + JSON.stringify(request.body));

        return validationPromise.then(function (validation) {
            if (validation.isValid) {
                return Imposter.create(protocols[protocol], request.body).then(function (imposter) {
                    imposters[imposter.port] = imposter;
                    response.setHeader('Location', imposter.url);
                    response.statusCode = 201;
                    response.send(imposter.toJSON());
                }, function (error) {
                    respondWithCreationError(response, error);
                });
            }
            else {
                respondWithValidationErrors(response, validation.errors);
            }
        });
    }

    function del (request, response) {
        var query = url.parse(request.url, true).query,
            options = {
                // default to replayable for backwards compatibility
                replayable: queryIsFalse(query, 'replayable'),
                removeProxies: queryBoolean(query, 'removeProxies')
            },
            json = Object.keys(imposters).reduce(function (accumulator, id) {
                return accumulator.concat(imposters[id].toJSON(options));
             }, []);
        deleteAllImposters();
        response.send({ imposters: json });
    }

    function put (request, response) {
        var requestImposters = request.body.imposters || [],
            validationPromises = requestImposters.map(function (imposter) {
                return validate(imposter, logger);
            });

        logger.debug(helpers.socketName(request.socket) + ' => ' + JSON.stringify(request.body));

        return Q.all(validationPromises).then(function (validations) {
            var isValid =  validations.every(function (validation) {
                    return validation.isValid;
                });

            if (isValid) {
                deleteAllImposters();
                var creationPromises = request.body.imposters.map(function (imposter) {
                        return Imposter.create(protocols[imposter.protocol], imposter);
                    });

                return Q.all(creationPromises).then(function (allImposters) {
                    var json = allImposters.map(function (imposter) {
                        return imposter.toJSON({ list: true });
                    });
                    allImposters.forEach(function (imposter) {
                        imposters[imposter.port] = imposter;
                    });
                    response.send({ imposters: json });
                }, function (error) {
                    respondWithCreationError(response, error);
                });
            }
            else {
                var validationErrors = validations.reduce(function (accumulator, validation) {
                        return accumulator.concat(validation.errors);
                    }, []);

                respondWithValidationErrors(response, validationErrors);
            }
        });
    }

    return {
        get: get,
        post: post,
        del: del,
        put: put
    };
}

module.exports = {
    create: create
};
