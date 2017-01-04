(function() {
  "use strict";

  var fsp = require('fs-promise');
  var Promise = require('bluebird');
  var  _ = require('lodash');
  var path = require('path');

  var defaults = {
    log: {
      level: 'info'
    },
    db: {
      name:"routematch",
      host:"routematch-db",
      port:27017
    },
    rabbit: {
      type: 'amqp',
      serverPin: {"role":"*", "cmd":"*"},
      clientPin: {"role":"*", "cmd":"*"},
      url: "amqp://guest:guest@routematch-msgqueue:5672",
      exchange: {
        name: 'seneca-messages',
        options: {
          durable: true,
          autoDelete: false
        }
      },
      queues: {
        action: {
          prefix: 'seneca-messages',
          separator: '.',
          options: {
            durable: false,
            autoDelete: true
          }
        },
        response: {
          prefix: 'seneca-messages-response',
          separator: '.',
          options: {
            durable: false,
            autoDelete: true
          }
        }
      }
    },
    eventRabbit: {
      pin: {"role":"event", "cmd":"emit"},
      exchange: {
        type: 'fanout',
        name: 'seneca-events-',
        options: {
          durable: true,
          autoDelete: false
        }
      },
      queues: {
        action: {
          prefix: 'seneca-events-action-',
          separator: '.',
          options: {
            durable: false,
            autoDelete: true
          }
        },
        response: {
          prefix: 'seneca-event-response-',
          separator: '.',
          options: {
            durable: false,
            autoDelete: true
          }
        }
      }
    }
  };

  function fileExists(path) {
    return fsp.access(path, fsp.R_OK)
    .then(function() {
      return true;
    })
    .catch(function() {
      return false;
    });
  }

  var loadFile = function (path) {
    return fileExists(path) // check if file is accessable
    .then(function(exists) {
      if(exists) {
        return fsp.readFile(path)
        .then(function(fileContent) {
          return JSON.parse(fileContent);
        })
        .catch(function(err) {
          err.message = 'Failed to parse ' + path + ': ' +err.message;
          throw new Error(err);
        });
      }
    });
  };

  function Config(configOverride) {
    this.config = configOverride;
  }

  Config.prototype.init = function() {
    return this.loadConfig();
  };

  Config.prototype.loadConfig = function() {
    var self = this;
    var serviceInfo = { service: Config.serviceInfo() };
    var systemConfig;
    return Promise.all([loadFile(path.resolve(serviceInfo.service.root, "config.json"))])
    .then(function(fileContents) {
      self.config = _.merge({}, defaults, self.config, _.get(fileContents, '[0]'), serviceInfo);
    });
  };

  Config.serviceInfo = function() {
    var serviceRoot = process.cwd();
    var serviceFilename = path.basename(require.main.filename);

    var servicePackage, serviceName;
    try {
      servicePackage = require(path.resolve(serviceRoot, "package.json"));
      serviceName = servicePackage.name;
    } catch (e) {
      serviceName = serviceFilename.replace(/\.js$/, "");
    }
    return {
      root: serviceRoot,
      name: serviceName
    };
  };

  module.exports = Config;
})();
