'use strict';

var net = require('net'),
    Q = require('q'),
    baseLogger = require('winston'),
    ScopedLogger = require('../../util/scopedLogger'),
    StubResolver = require('../stubResolver'),
    StubRepository = require('../stubRepository'),
    util = require('util'),
    helpers = require('../../util/helpers'),
    TcpProxy = require('../tcp/tcpProxy'),
    DryRunValidator = require('../dryRunValidator');

/**
 * Used to fill in defaults for the response.  A user may set up a stub
 * with not all fields filled in, and we use this function to fill in the rest
 */
function postProcess (stub) {
    return {
        data: stub.data || 'foo'
    };
}

/**
 * Used to get consistent logging look & feel
 */
function scopeFor (port, name) {
    var scope = util.format('foo:%s', port);
    if (name) {
        scope += ' ' + name;
    }
    return scope;
}
/**
 * Spins up a server listening on a socket
 * @param options - the JSON request body for the imposter create request
 * @param recordRequests - the inverse of the --nomock command line parameter
 */
function createServer (options, recordRequests) {
            // This is an async operation, so we use a deferred
    var deferred = Q.defer(),
            // and an array to record all requests for mock verification
        requests = [],
            // set up a logger with the correct log prefix
        logger = ScopedLogger.create(baseLogger, scopeFor(options.port)),
            // create the protocol-specific proxy (here we're reusing tcp's proxy)
        proxy = TcpProxy.create(logger, 'utf8'),
            // create the stub resolver, which contains the strategies for resolving is, proxy, and inject stubs
            // the postProcess parameter is used to fill in defaults for the response that were not passed by the user
        resolver = StubResolver.create(proxy, postProcess),
            // create the repository which matches the appropriate stub to respond with
        stubs = StubRepository.create(resolver, recordRequests, 'utf8'),
            // and create the actual server using node.js's net module
        server = net.createServer();

    // we need to respond to new connections
    server.on('connection', function (socket) {
        socket.on('data', function (data) {
            // This will be the request API interface used by stubs, etc.
            var request = {
                requestFrom: helpers.socketName(socket),
                data: data.toString('utf8')
            };

            // remember the request for mock verification, unless told not to
            if (recordRequests) {
                requests.push(request);
            }

            // let's resolve any stubs (don't worry - there are defaults if no stubs are defined)
            return stubs.resolve(request, logger).then(function (stubResponse) {
                var buffer = new Buffer(stubResponse.data, 'utf8');

                // This writes the response
                socket.write(buffer);
            });
        });
    });

    // Bind the socket to a port (the || 0 bit auto-selects a port if one isn't provided)
    server.listen(options.port || 0, function () {
        // Some basic bookkeeping...
        var actualPort = server.address().port,
            metadata = {};

        if (options.name) {
            metadata.name = options.name;
        }

        if (options.port !== actualPort) {
            logger.changeScope(scopeFor(actualPort));
        }

        logger.info('Open for business...');

        // This resolves the promise, allowing execution to continue after we're listening on a socket
        // The object we resolve with defines the core imposter API expected in imposter.js
        deferred.resolve({
            requests: requests,
            addStub: stubs.addStub,
            stubs: stubs.stubs,
            metadata: metadata,
            port: actualPort,
            close: function () {
                server.close();
                logger.info ('Ciao for now');
            }
        });
    });

    return deferred.promise;
}

/**
 * Creates the core protocol interface - all protocols must implement
 * @param allowInjection - represents the command line --allowInjection parameter
 * @param recordRequests - represents the inverse of the command line --nomock parameter
 */
function initialize (allowInjection, recordRequests) {
    return {
        // The name of the protocol, used in JSON representation of imposters
        name: 'foo',

        // The creation method, called in imposter.js.  The request JSON object gets passed in
        create: function (request) {
            return createServer(request, recordRequests);
        },

        // The validator used when creating imposters
        // If you don't have any protocol-specific validation, the DryRunValidator will suffice
        Validator: {
            create: function () {
                return DryRunValidator.create({
                    StubRepository: StubRepository,
                        // This is the request that will be 'dry run' through the validator
                    testRequest: {
                        requestFrom: '',
                        data: ''
                    },
                    allowInjection: allowInjection
                });
            }
        }
    };
}

module.exports = {
    // This will be called in mountebank.js when you register the protocol there
    initialize: initialize
};
