'use strict';

let myUtils = require('../util');
let config = require('config');
const connectionWrapper = require("../connections");

module.exports = function() {
  const express = require('express');
  const router = express.Router();
  const connectionWrapper = require('../connections');

  router.get('/connections', getConnections);
  router.post('/login', postLogin);
  router.post('/login/detectDb', postLoginDetectDb);
  router.get('/config', getConfig);
  router.post('/logout/:connectionId', postLogout);


  function getConnections(req, res) {
    res.json({
      'ok': true,
      'connections': req.app.locals.redisConnections.convertConnectionsInfoForUI()
    });
  }

  function getConfig (req, res) {
    // do not return connections at all, that queried via /connections route...
    return res.send(config.get('ui'));
  }

  /** extract all connection data needed from body of request to create a new connection
   *  object suitable to create new redis client from via utility function.
   *  Function throws error if data are missing or non-parsable.
   *  This function understands redis connections via socket, single ip or sentinel.
   *
   *  @param {object} body body of request with connection data
   * @returns {{password: *, port: number, dbIndex: number, label: *}} connection object
   */
  function extractLoginDataFromBody(body) {
    let newConnection = {
      label: body.label,
      port: body.port,
      username: body.username,
      password: body.password,
      dbIndex: body.dbIndex
    };

    if (body.serverType === 'sentinel') {
      newConnection.sentinels = myUtils.parseRedisServerList('newConnection', body.sentinels);
      newConnection.sentinelName = myUtils.getRedisSentinelGroupName(body.sentinelName);
      switch (body.sentinelPWType) {
        case 'sentinel':
          newConnection.sentinelPassword = body.sentinelPassword;
          break;
        case 'redis':
          newConnection.sentinelPassword = body.password;
          break;
      }
      if (body.sentinelTLS === 'yes') {
        newConnection.sentinelTLS = true;
      }
      else if (body.sentinelTLS === 'custom') {
        newConnection.sentinelTLS = {};
        if (body.sentinelTLSCA) {
          newConnection.sentinelTLS.ca = body.sentinelTLSCA.replace(/\\n/g, '\n');
        }
        if (body.sentinelTLSPublicKey) {
          newConnection.sentinelTLS.cert = body.sentinelTLSPublicKey.replace(/\\n/g, '\n');
        }
        if (body.sentinelTLSPrivateKey) {
          newConnection.sentinelTLS.key = body.sentinelTLSPrivateKey.replace(/\\n/g, '\n');
        }
        if (body.sentinelTLSServerName) {
          newConnection.sentinelTLS.servername = body.sentinelTLSServerName;
        }
      }
    }
    else if (body.serverType === 'cluster') {
      newConnection.clusters = myUtils.parseRedisServerList('newConnection', body.clusters);
      delete newConnection.port;
    }
    else if (typeof body.hostname === 'string') {
      if (body.hostname.startsWith('/')) {
        newConnection.path = body.hostname;
      }
      else {
        newConnection.host = body.hostname;
      }
    }
    else {
      throw new Error('invalid or missing hostname or socket path');
    }

    if (body.redisTLS === 'yes') {
      newConnection.tls = true
      newConnection.clusterNoTlsValidation = (typeof body.clusterNoTlsValidation !== 'undefined');  // checkbox
    }
    else if (body.redisTLS === 'custom') {
      newConnection.tls = {};
      newConnection.clusterNoTlsValidation = (typeof body.clusterNoTlsValidation !== 'undefined');
      if (body.redisTLSCA) {
        newConnection.tls.ca = body.redisTLSCA.replace(/\\n/g, '\n');
      }
      if (body.redisTLSPublicKey) {
        newConnection.tls.cert = body.redisTLSPublicKey.replace(/\\n/g, '\n');
      }
      if (body.redisTLSPrivateKey) {
        newConnection.tls.key = body.redisTLSPrivateKey.replace(/\\n/g, '\n');
      }
      if (body.redisTLSServerName) {
        newConnection.tls.servername = body.sentinelTLSServerName;
      }
    }
    return newConnection;
  }

  function postLogin (req, res, next) {
    if (Number.isNaN(req.body.dbIndex)) {
      return res.json({
        ok: false,
        message: 'invalid database index'
      });
    }

    // first check if this connection is already known & active - do not create duplicate connections
    let newConnection = {};
    try {
      newConnection = extractLoginDataFromBody(req.body);
    }
    catch (e) {
      return res.json({
        ok: false,
        message: e.message
      });
    }

    if (req.app.locals.redisConnections.containsConnection(newConnection)) {
        return res.json({
            ok: true,
            message: 'already logged in to this server and db'
        });
    }

    // now try to log in
    if (newConnection.sentinels) {
      console.log('connecting sentinel... ', newConnection.sentinelName, JSON.stringify(newConnection.sentinels));
    }
    else if (newConnection.clusters) {
      console.log('connecting cluster... ', JSON.stringify(newConnection.clusters));
    }
    else {
      console.log('connecting... ', newConnection.host, newConnection.port);
    }
    let client = myUtils.createRedisClient(newConnection);
    req.app.locals.redisConnections.setUpConnection(client,
      // called on connection errors (ECONNRESET, AUTH failed etc.), used to inform frontend about it
      function (err) {
          console.log('Invalid Login: ' + err);
          if (!res._headerSent) {
            return res.json({
              ok: false,
              message: 'invalid login: ' + (err.message ? err.message : JSON.stringify(err))
            });
          }
          client.disconnect();
          return;
        },
      // called if connection was successful, add connection to our lists and configs and send back success to client
      function () {
        // add to in-memory connection list
        req.app.locals.redisConnections.push(client);
        // written config and current in-memory config may differ
        if (!connectionWrapper.containsConnection(config.get('connections'), newConnection)) {
          config.connections.push(newConnection);
        }
        req.app.saveConfig(config, function (errSave) {
          if (errSave) {
            return next(errSave);
          }
          if (!res._headerSent) {
            return res.json({'ok': true})
          }
        });
      });
  }

  function postLoginDetectDb (req, res, next) {
    try {
      let newConnection = extractLoginDataFromBody(req.body);
      // set db to zero as this one must exist, all higher numbers are optional...
      newConnection.dbIndex = 0;

      // now try to log in and get server info to check number of keys per db
      if (newConnection.sentinels) {
        console.log('checking for dbs at sentinel... ', newConnection.sentinelName, JSON.stringify(newConnection.sentinels));
      }
      else if (newConnection.clusters) {
        console.log('checking for dbs at cluster... ', JSON.stringify(newConnection.clusters));
      }
      else {
        console.log('checking for dbs... ', newConnection.host, newConnection.port);
      }

      let client = myUtils.createRedisClient(newConnection);
      client.on('error', function (err) {
        disconnectClient(client);
        console.log('Cannot connect to redis db: ' + err.message);
        return res.json({
          ok: false,
          message: `Error connecting to Redis to get all databases used: ${err.message}`
        });
      });
      client.on('ready', function () {
        Promise.allSettled([
          client.call('info', 'keyspace'),
          client.call('config', 'get', 'databases')
        ]).then((promises) => {
          let dbMax = 16;
          let host = '';
          let dbLines = []
          // check which key-spaces aka dbs are holding keys right now
          if (promises[0].status === 'rejected') {
            console.log('Error calling "info" command to get all databases used.', (promises[0].reason ? promises[0].reason.message : 'unknown error'));
            return res.json({
              ok: false,
              message: (promises[0].reason ? promises[0].reason.message : 'Error calling "info" command to get all databases used.')
            });
          }
          else {
            dbLines = promises[0].value.split('\n').filter(function(line) {
              return line.trim().match(/^db\d+:/);
            }).map(function(line) {
              let parts = line.trim().split(':');
              return {
                dbIndex: parts[0].substr(2),
                keys: parts[1]
              };
            });
          }
          // check number of max dbs allowed (config get databases), defaults to 16
          if (promises[1].status === 'rejected') {
            // ignore errors, often command not allowed for security n stuff
            console.info('Cannot query max number of databases allowed, use default 16 instead: ',
              promises[1].reason.message);
          }
          else {
            dbMax = Array.isArray(promises[1].value) ? parseInt(promises[1].value[1]) : 16;
          }
          switch (client.options.type) {
            case 'socket':
              host = client.options.path;
              break;
            case 'sentinel':
              host = client.options.sentinels[0].host;
              break;
            case 'cluster':
              host = client.options.clusters[0].host;
              break;
            default:  // standalone
              host = client.options.host;
          }

          res.json({
            ok: true,
            server: `${client.options.type} ${host}`,
            dbs: {
              used: dbLines,
              max: dbMax
            }
          });
        }).finally(() => {
          disconnectClient(client);
        });
      });
    }
    catch (e) {
      return res.json({
        ok: false,
        message: e.message
      });
    }

    function disconnectClient(client) {
      client.quit();
      client.disconnect();
    }
  }

  function postLogout (req, res, next) {
    var connectionId = req.params.connectionId;
    req.app.logout(connectionId, function (err) {
      if (err) {
        return next(err);
      }
      removeConnectionFromDefaults(config.get('connections'), connectionId, function (errRem, newDefaults) {
        if (errRem) {
          console.log('postLogout - removeConnectionFromDefaults', errRem);
          if (!res._headerSent) {
            return res.send('OK');
          }
        }
        config.connections = newDefaults;
        req.app.saveConfig(config, function (errSave) {
          if (errSave) {
            return next(errSave);
          }
          if (!res._headerSent) {
            return res.send('OK');
          }
        });
      });
    });
  }

  function removeConnectionFromDefaults (connections, connectionId, callback) {
    let notRemoved = true;
    connections.forEach(function (connection, index) {
      if (notRemoved) {
        if (connection.connectionId === connectionId) {
          notRemoved = false;
          connections.splice(index, 1);
        }
      }
    });
    if (notRemoved) {
      return callback('Could not remove ' + connectionId + ' from default connections.');
    } else {
      return callback(null, connections);
    }
  }

  return router;
};
