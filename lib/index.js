(function () {
  "use strict";

  var runInVm = require('./util/vm');
  var filesUtil = require('./util/files');

  var log = require('./util/log');
  var Config = require('./util/config');
  var when = require('when');
  var nodefn = require('when/node');
  var _ = require('lodash');
  var Promise = require('bluebird');
  var Seneca = require('seneca');
  var MsgEmitter = require('./util/msgEmitter');
  var uuid = require('uuid');

  // Static setup;
  when.node = nodefn;

  function MicroService(configOverride) {
    var self = this;
    self.msgEmitter = new MsgEmitter();
    var ready = when.defer();
    self.ready = ready.promise;
    var configObject = new Config(configOverride);
    configObject.init()
    .then(function() {
    log.init(configObject.config);

      self.config = configObject.config;
      // set the response role name for message transport
      self.config.responseRole = _.get(self.config, 'service.name') + '#' + uuid.v4();

      var seneca = Seneca({
        timeout: 120000,
        log: {
          map: [
            {
              level: 'all', handler: function () {
                try {
                  if(Array.isArray(arguments) && arguments.length < 3)
                    return;
                  switch(arguments[2].toLowerCase()) {
                    case 'error':
                    case 'fatal':
                    case 'warn':
                    case 'info':
                      console[arguments[2].toLowerCase()]('[seneca]', Array.prototype.slice.call(arguments).slice(3).map(function(item) {return JSON.stringify(item);}).join(' '));
                      break;
                    default:
                    // ignore
                  }
                }
                catch(err) {
                  console.error('internal logging error: ', err);
                }
              }
            }
          ]
        }
      })
      .use('seneca-amqp-transport')
      .use('basic')
      .use('entity')
      .use('mongo-store', self.config.db);

      var promiseAct = Promise.promisify(seneca.act, {context: seneca});

      function sendResponseMsg(msg, rspData) {
        var responsePattern = _.get(msg, 'responsePattern');
        return promiseAct(_.omit(responsePattern, 'id'), _.merge({actId: _.get(msg, 'actId')}, rspData, {responsePattern: responsePattern, requestPattern: _.pick(msg, ['role', 'cmd'])}));
      }

      self.add = function(cmdData, handler) {
        seneca.add(cmdData, function(msg, respond) {
          respond(null);
          Promise.resolve()
          .then(function() {
            return handler(_.get(msg, 'data'));
          })
          .then(function(retObj) {
            if(_.has(retObj, 'entity$')) {
              // is a seneca-entity object, convert it to a plain object
              retObj = retObj.data$(false);
            }
            else if(Array.isArray(retObj)) {
              // convert array of seneca-entity objects into plain objects
              retObj = retObj.map(function(item) {
                return _.has(item, 'entity$') ? item.data$(false) : item;
              });
            }
            return sendResponseMsg(msg, {data: retObj});
          })
          .catch(function(err) {
            console.error(err.message);
            return sendResponseMsg(msg, {error: {message:err.message, stack: err.stack}});
          });
        });
      };

      self.act = function(cmdData, data) {
        return new Promise(function(resolve, reject) {
          // wrap the input data in an object
          var responsePattern = {
            role: _.get(self.config, 'responseRole'),
            cmd: 'response'
          };
          var actId = uuid.v4();
          promiseAct(cmdData, {
            data: data,
            responsePattern: responsePattern,
            actId: actId
          })
          .then(function() {
            return self.msgEmitter.waitForMsg(JSON.stringify(_.merge({role: cmdData.role, cmd: cmdData.cmd, actId: actId})), 120000)
            .then(function(returnedData) {
              if(_.has(returnedData, 'error')) {
                // handler sent back an error
                var err = new Error(_.get(returnedData, 'error.message'));
                err.stack = _.get(returnedData, 'error.stack');
                throw err;
              }
              // unwrap the data from the response object
              resolve(_.get(returnedData, 'data'));
            });
          })
          .catch(function(err) {
            if(_.get(err, 'timeout') === true) {
              reject(new Error(JSON.stringify(cmdData)+ ': message timed out.'));
            }
            else {
              reject(err);
            }
          });
        });
      };

      self.close = function() {
        return new Promise(function(resolve, reject) {
          seneca.close(function(err) {
            if(err) {
              reject(err);
            }
            else {
              resolve();
            }
          });
        });
      };

      var senecaMake = seneca.make$;
      seneca.make = function() {
        var entity = senecaMake.apply(seneca, arguments);
        entity.save$ = Promise.promisify(entity.save$, { context: entity });
        entity.load$ = Promise.promisify(entity.load$, { context: entity });
        entity.remove$ = Promise.promisify(entity.remove$, { context: entity });
        entity.delete$ = entity.remove$;
        entity.list$ = Promise.promisify(entity.list$, { context: entity });
        return entity;
      };
      seneca.make$ = seneca.make;

      self.seneca = seneca;

      var baseSandbox = {
        Promise: Promise,
        log: log,
        _: _
      };

       _.merge(self, baseSandbox);

       var responseTransport = new Seneca()
       .use('basic')
       .use('seneca-amqp-transport');
       return Promise.resolve()
       .then(function() {
         return setupResponseListener(responseTransport, self.config);
       })
       .then(function() {
         responseTransport.add({role: _.get(self.config, 'responseRole'), cmd: 'response'}, function(data, respond) {
           var requestPattern = _.get(data, 'requestPattern');
           if(_.isObject(requestPattern) && _.isString(_.get(data, 'actId'))) {
             var evtName = JSON.stringify({
               role: requestPattern.role,
               cmd: requestPattern.cmd,
               actId: data.actId
             });
             self.msgEmitter.emit(evtName, data);
           }
           else {
             console.error('invalid response: ', data);
           }
           respond(null);
         });
       })
       .then(function() {
         return setupTransport(seneca, self.config);
       })
       .then(function() {
         // Load handlers from disk and register with Rabbit
         var handlerPromises = [];

         var handlerSandbox = _.assignIn({}, baseSandbox, {
           add: function () {
             var promise = self.add.apply(self, arguments);
             handlerPromises.push(promise);
             return promise;
           },
           act: self.act
         });

         return filesUtil.cwdAndFiles(self.config.service.root, "handlers", "js").then(function(result){
           handlerSandbox.seneca = self.seneca;
           return loadFromDir(result, handlerSandbox);
         }).then(function( ) {
           return Promise.all(handlerPromises);
         });
       })
       .then(function() {
         console.log("Microservice ready.");
         ready.resolve();
       });
     })
     .catch(function (err) {
       console.error("Error during microservice initialization", err.stack);
       process.exit(1);
     });
   }

  function loadFromDir(cwdAndFiles, sandbox, options) {
    var opts = options || {};
    return cwdAndFiles.files.map(function (file) {
      console.log("file " + JSON.stringify(file, null, 2));
      return runInVm(cwdAndFiles.cwd, file, sandbox, opts);
    });
  }

  function setupResponseListener(transport, config) {
    return new Promise(function(resolve, reject) {
      try {
        var rabbitCfg = {};
        _.merge(rabbitCfg, _.omit(config.rabbit, ['pin', 'serverPin', 'clientPin']));
        rabbitCfg.pin = {role: _.get(config, 'responseRole'), cmd:'*'};

        transport.listen(rabbitCfg);
        transport.ready(function(err) {
          if(err){
            console.error("Error during transport initialization", err);
            reject(err);
          }

          resolve();
        });
      }
      catch(err) {
        reject(err);
      }
    });
  }

  function setupTransport(transport, config) {

    function setupClient() {
      var rabbitCfg = {};
      _.merge(rabbitCfg, config.rabbit);
      if(_.has(config, 'rabbit.clientPin')) {
        rabbitCfg.pin = _.get(config, 'rabbit.clientPin');
      }

      rabbitCfg = _.omit(rabbitCfg, ['serverPin', 'clientPin']);
      transport.client(rabbitCfg);
    }

    function setupListener() {
      var rabbitCfg = {};
      _.merge(rabbitCfg, config.rabbit);
      if(_.has(config, 'rabbit.serverPin')) {
        rabbitCfg.pin = _.get(config, 'rabbit.serverPin');
      }

      rabbitCfg = _.omit(rabbitCfg, ['serverPin', 'clientPin']);
      transport.listen(rabbitCfg);
    }

    return new Promise(function(resolve, reject) {
      try {
        if(_.get(config, 'rabbit.listenOnly') !== true) {
          setupClient();
        }
        if(_.get(config, 'rabbit.clientOnly') !== true) {
          setupListener();
        }
        transport.ready(function(err) {
          if(err){
            console.error("Error during transport initialization", err);
            reject(err);
          }

          resolve();
        });
      }
      catch(err) {
        reject(err);
      }
    });
  }

  function createEventConfig(config, eventName) {
    var eventConfig = _.merge({}, config, {rabbit: _.get(config, 'eventRabbit')});
    _.set(eventConfig, 'rabbit.exchange.name', _.get(eventConfig, 'rabbit.exchange.name') +  eventName);
    var randomStr = uuid.v4();
    _.set(eventConfig, 'rabbit.queues.action.prefix', _.get(eventConfig, 'rabbit.queues.action.prefix') + eventName + '-' + randomStr);
    _.set(eventConfig, 'rabbit.queues.response.prefix', _.get(eventConfig, 'rabbit.queues.response.prefix') + eventName + '-' + randomStr);
    return eventConfig;
  }

  module.exports = MicroService;
})();
