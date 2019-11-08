/* eslint-disable no-underscore-dangle */
const WebSocket = require('ws');
const bitcoinjs = require('bitcoinjs-lib');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const zelcashServices = require('./zelcashService');
const config = require('../../../config/default');
const userconfig = require('../../../config/userconfig');

const outgoingConnections = []; // websocket list
const outgoingPeers = []; // array of objects containing ip and rtt latency

let response = {
  status: 'error',
  data: {
    message: 'Unknown error',
  },
};

async function zelnodelist(filter) {
  let zelnodeList = null;
  const request = {
    params: {
      filter,
    },
    query: {},
  };
  zelnodeList = await zelcashServices.listZelNodes(request);
  return zelnodeList.data || [];
}

async function getZelNodePrivateKey(privatekey) {
  const privKey = privatekey || zelcashServices.getConfigValue('zelnodeprivkey');
  return privKey;
}

async function getFluxMessageSignature(message, privatekey) {
  const privKey = await getZelNodePrivateKey(privatekey);
  const signature = await serviceHelper.signMessage(message, privKey);
  return signature;
}

async function getZelNodePublicKey(privatekey) {
  try {
    const privKey = await getZelNodePrivateKey(privatekey).catch((error) => { console.log(error); throw error; });
    const keyPair = bitcoinjs.ECPair.fromWIF(privKey).catch((error) => { console.log(error); throw error; });
    const pubKey = keyPair.publicKey.toString('hex');
    return pubKey;
  } catch (error) {
    return error;
  }
}

// return boolean
async function verifyFluxBroadcast(data, obtainedZelNodeList, currentTimeStamp) {
  const dataObj = serviceHelper.ensureObject(data);
  const { pubKey } = dataObj;
  const { timestamp } = dataObj; // ms
  const { signature } = dataObj;
  const message = serviceHelper.ensureString(dataObj.data);
  // is timestamp valid ?
  // eslint-disable-next-line no-param-reassign
  currentTimeStamp = currentTimeStamp || Date.now(); // ms
  if (currentTimeStamp < (timestamp - 120000)) { // message was broadcasted in the future. Allow 120 sec clock sync
    return false;
  }

  let zelnode = null;
  if (obtainedZelNodeList) { // for test purposes
    zelnode = await obtainedZelNodeList.find(key => key.pubkey === pubKey);
  }
  if (!zelnode) {
    const zl = await zelnodelist(pubKey); // this itself is sufficient.
    if (zl.length === 1) {
      if (zl[0].pubkey === pubKey) {
        [zelnode] = zl;
      }
    }
  }
  if (!zelnode) { // if filtering fails, fetch all the list and run find method
    // eslint-disable-next-line no-param-reassign
    obtainedZelNodeList = await zelnodelist(); // support for daemons that do not have filtering via public key
    zelnode = await obtainedZelNodeList.find(key => key.pubkey === pubKey);
  }
  if (!zelnode) {
    return false;
  }
  if (zelnode.status !== 'ENABLED') { // refuse messages from not enabled zelnodes
    return false;
  }
  const verified = await serviceHelper.verifyMessage(message, pubKey, signature);
  if (verified === true) {
    return true;
  }
  return false;
}

// extends verifyFluxBroadcast by not allowing request older than 5 secs.
async function verifyOriginalFluxBroadcast(data, obtainedZelNodeList, currentTimeStamp) {
  // eslint-disable-next-line no-param-reassign
  const dataObj = serviceHelper.ensureObject(data);
  const { timestamp } = dataObj; // ms
  // eslint-disable-next-line no-param-reassign
  currentTimeStamp = currentTimeStamp || Date.now(); // ms
  if (currentTimeStamp > (timestamp + 300000)) { // bigger than 5 mins
    return false;
  }
  const verified = await verifyFluxBroadcast(data, obtainedZelNodeList, currentTimeStamp);
  return verified;
}

async function verifyTimestampInFluxBroadcast(data, currentTimeStamp) {
  // eslint-disable-next-line no-param-reassign
  const dataObj = serviceHelper.ensureObject(data);
  const { timestamp } = dataObj; // ms
  // eslint-disable-next-line no-param-reassign
  currentTimeStamp = currentTimeStamp || Date.now(); // ms
  if (currentTimeStamp < (timestamp + 300000)) { // bigger than 5 secs
    return true;
  }
  return false;
}

function sendToAllPeers(data) {
  let removals = [];
  let ipremovals = [];
  // console.log(data);
  outgoingConnections.forEach((client) => {
    try {
      client.send(data);
    } catch (e) {
      log.error(e);
      removals.push(client);
      const ip = client._socket.remoteAddress;
      const foundPeer = outgoingPeers.find(peer => peer.ip === ip);
      ipremovals.push(foundPeer);
    }
  });

  for (let i = 0; i < ipremovals.length; i += 1) {
    const peerIndex = outgoingPeers.indexOf(ipremovals[i]);
    if (peerIndex > -1) {
      outgoingPeers.splice(peerIndex, 1);
    }
  }
  for (let i = 0; i < removals.length; i += 1) {
    const ocIndex = outgoingConnections.indexOf(removals[i]);
    if (ocIndex > -1) {
      outgoingConnections.splice(ocIndex, 1);
    }
  }
  removals = [];
  ipremovals = [];
}

async function serialiseAndSignZelFluxBroadcast(dataToBroadcast, privatekey) {
  const timestamp = Date.now();
  const pubKey = await getZelNodePublicKey(privatekey);
  const message = serviceHelper.ensureString(dataToBroadcast);
  const signature = await getFluxMessageSignature(message, privatekey);
  const type = 'message';
  const dataObj = {
    type,
    timestamp,
    pubKey,
    signature,
    data: dataToBroadcast,
  };
  const dataString = JSON.stringify(dataObj);
  return dataString;
}

// eslint-disable-next-line no-unused-vars
function handleIncomingConnection(ws, req, expressWS) {
  // const clientsSet = expressWS.clients;
  // const clientsValues = clientsSet.values();
  // console.log(clientsValues);
  // console.log(clientsSet .size);
  // for (let i = 0; i < clientsSet.size; i += 1) {
  //   console.log(clientsValues.next().value);
  // }
  // clientsSet.forEach((client) => {
  //   client.send('hello');
  // });
  // const { data } = req.params;
  // console.log(req);
  // console.log(ws);
  // verify data integrity, if not signed, close connection
  ws.on('message', async (msg) => {
    const currentTimeStamp = Date.now(); // ms
    console.log(msg);
    const messageOK = await verifyFluxBroadcast(msg, undefined, currentTimeStamp);
    const timestampOK = await verifyTimestampInFluxBroadcast(msg, currentTimeStamp);
    if (messageOK === true && timestampOK === true) {
      try {
        const msgObj = serviceHelper.ensureObject(msg);
        if (msgObj.data.type === 'HeartBeat' && msgObj.data.message === 'ping') { // we know that data exists
          const newMessage = msgObj.data;
          newMessage.message = 'pong';
          const pongResponse = await serialiseAndSignZelFluxBroadcast(newMessage);
          ws.send(pongResponse);
        } else {
          ws.send(`ZelFlux ${userconfig.initial.ipaddress} says message received!`);
        }
      } catch (e) {
        log.error(e);
      }
      // try rebroadcasting to all outgoing peers
      // try {
      //   sendToAllPeers(msg);
      // } catch (e) {
      //   log.error(e);
      // }
    } else if (messageOK === true) {
      try {
        ws.send(`ZelFlux ${userconfig.initial.ipaddress} says message received but your message is outdated!`);
      } catch (e) {
        log.error(e);
      }
    } else {
      // we dont like this peer as it sent wrong message. Lets close the connection
      try {
        ws.close(1008); // close as of policy violation?
      } catch (e) {
        log.error(e);
      }
    }
  });
  ws.on('open', (msg) => {
    console.log('conn open');
    console.log(msg);
  });
  ws.on('connection', (msg) => {
    console.log(msg);
  });
  ws.on('error', (msg) => {
    console.log(msg);
  });
  ws.on('close', (msg) => {
    // console.log(clientsSet);
    console.log(msg);
  });
}

async function broadcastMessage(dataToBroadcast) {
  const serialisedData = await serialiseAndSignZelFluxBroadcast(dataToBroadcast);
  sendToAllPeers(serialisedData);
}

async function broadcastMessageFromUser(req, res) {
  let { data } = req.params;
  data = data || req.query.data;
  if (data === undefined || data === null) {
    const errMessage = serviceHelper.createErrorMessage('No message to broadcast attached.');
    return res.json(errMessage);
  }
  const authorized = await serviceHelper.verifyPrivilege('zelteam', req);

  if (authorized === true) {
    broadcastMessage(data);
    const message = {
      status: 'success',
      data: {
        message: 'Message successfully broadcasted to ZelFlux network',
      },
    };
    response = message;
  } else {
    response = serviceHelper.errUnauthorizedMessage();
  }
  return res.json(response);
}

async function broadcastMessageFromUserPost(req, res) {
  console.log(req.headers);
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = JSON.parse(body);
    if (processedBody === undefined || processedBody === null || processedBody === '') {
      const errMessage = serviceHelper.createErrorMessage('No message to broadcast attached.');
      response = errMessage;
    } else {
      const authorized = await serviceHelper.verifyPrivilege('zelteam', req);
      console.log(authorized);
      if (authorized === true) {
        broadcastMessage(processedBody);
        const message = {
          status: 'success',
          data: {
            message: 'Message successfully broadcasted to ZelFlux network',
          },
        };
        response = message;
      } else {
        response = serviceHelper.errUnauthorizedMessage();
      }
    }
    return res.json(response);
  });
}

async function getRandomConnection() {
  const zelnodeList = await zelnodelist();
  const zlLength = zelnodeList.length;
  const randomNode = Math.floor((Math.random() * zlLength)); // we do not really need a 'random'
  const fullip = zelnodeList[randomNode].ipaddress;
  const ip = fullip.split(':16125').join('');

  // const zelnodeList = ['157.230.249.150', '94.177.240.7', '89.40.115.8', '94.177.241.10', '54.37.234.130', '194.182.83.182'];
  // const zlLength = zelnodeList.length;
  // const randomNode = Math.floor((Math.random() * zlLength)); // we do not really need a 'random'
  // const ip = zelnodeList[randomNode];

  // TODO checks for ipv4, ipv6, tor
  if (ip.includes('onion') || ip === userconfig.initial.ipaddress) {
    return null;
  }

  const clientExists = outgoingConnections.find(client => client._socket.remoteAddress === ip);
  if (clientExists) {
    return null;
  }

  log.info(`Adding ZelFlux peer: ${ip}`);

  return ip;
}

async function initiateAndHandleConnection(ip) {
  const wsuri = `ws://${ip}:${config.server.apiport}/ws/zelflux/`;
  const websocket = new WebSocket(wsuri);

  websocket.on('open', () => {
    outgoingConnections.push(websocket);
    const peer = {
      ip: websocket._socket.remoteAddress,
      rtt: null,
    };
    outgoingPeers.push(peer);
    broadcastMessage('Hello ZelFlux');
    console.log(`#connectionsOut: ${outgoingConnections.length}`);
  });

  websocket.onclose = (evt) => {
    const { url } = websocket;
    let conIP = url.split('/')[2];
    conIP = conIP.split(':16127').join('');
    const ocIndex = outgoingConnections.indexOf(websocket);
    if (ocIndex > -1) {
      log.info(`Connection to ${conIP} closed with code ${evt.code}`);
      outgoingConnections.splice(ocIndex, 1);
    }
    const foundPeer = outgoingPeers.find(peer => peer.ip === conIP);
    if (foundPeer) {
      const peerIndex = outgoingPeers.indexOf(foundPeer);
      if (peerIndex > -1) {
        outgoingPeers.splice(peerIndex, 1);
        log.info(`Connection ${conIP} removed from outgoingPeers`);
      }
    }
    console.log(`#connectionsOut: ${outgoingConnections.length}`);
  };

  websocket.onmessage = async (evt) => {
    // incoming messages from outgoing connections
    console.log(evt.data);
    const currentTimeStamp = Date.now(); // ms
    const messageOK = await verifyOriginalFluxBroadcast(evt.data, undefined, currentTimeStamp);
    if (messageOK === true) {
      const msgObj = serviceHelper.ensureObject(evt.data);
      if (msgObj.data.type === 'HeartBeat' && msgObj.data.message === 'pong') {
        const newerTimeStamp = Date.now(); // ms, get a bit newer time that has passed verification of broadcast
        const rtt = newerTimeStamp - msgObj.data.timestamp;
        console.log(rtt);
        console.log(newerTimeStamp);
        console.log(msgObj.data.timestamp);
        console.log(outgoingPeers);
        console.log(websocket.url);
        const { url } = websocket;
        let conIP = url.split('/')[2];
        conIP = conIP.split(':16127').join('');
        const foundPeer = outgoingPeers.find(peer => peer.ip === conIP);
        if (foundPeer) {
          console.log('here');
          const peerIndex = outgoingPeers.indexOf(foundPeer);
          if (peerIndex > -1) {
            outgoingPeers[peerIndex].rtt = rtt;
          }
        }
      }
    } // else we do not react to this message;
  };

  websocket.onerror = (evt) => {
    console.log(evt.code);
    const { url } = websocket;
    let conIP = url.split('/')[2];
    conIP = conIP.split(':16127').join('');
    const ocIndex = outgoingConnections.indexOf(websocket);
    if (ocIndex > -1) {
      log.info(`Connection to ${conIP} errord with code ${evt.code}`);
      outgoingConnections.splice(ocIndex, 1);
    }
    const foundPeer = outgoingPeers.find(peer => peer.ip === conIP);
    if (foundPeer) {
      const peerIndex = outgoingPeers.indexOf(foundPeer);
      if (peerIndex > -1) {
        outgoingPeers.splice(peerIndex, 1);
        log.info(`Connection ${conIP} removed from outgoingPeers`);
      }
    }
    console.log(`#connectionsOut: ${outgoingConnections.length}`);
  };
}

async function fluxDisovery() {
  const minPeers = 5; // todo to 10;
  const zl = await zelnodelist();
  const numberOfZelNodes = zl.length;
  const requiredNumberOfConnections = numberOfZelNodes / 50; // 2%
  const minCon = Math.min(minPeers, requiredNumberOfConnections); // TODO correctly max
  if (outgoingConnections.length < minCon) {
    const ip = await getRandomConnection();
    if (ip) {
      initiateAndHandleConnection(ip);
    }
    // connect another peer
    setTimeout(() => {
      fluxDisovery();
    }, 1000);
  } else {
    // do new connections every 30 seconds
    setTimeout(() => {
      fluxDisovery();
    }, 30000);
  }
}

function connectedPeers(req, res) {
  const connections = [];
  outgoingConnections.forEach((client) => {
    connections.push(client._socket.remoteAddress);
  });
  const message = {
    status: 'success',
    data: {
      message: connections,
    },
  };
  response = message;
  res.json(response);
}

function connectedPeersInfo(req, res) {
  const connections = outgoingPeers;
  const message = {
    status: 'success',
    data: {
      message: connections,
    },
  };
  response = message;
  res.json(response);
}

function keepConnectionsAlive() {
  setInterval(() => {
    const timestamp = Date.now();
    const type = 'HeartBeat';
    const message = 'ping';
    const data = {
      timestamp,
      type,
      message,
    };
    broadcastMessage(data);
  }, 30000);
}

async function addPeer(req, res) {
  let { ip } = req.params;
  ip = ip || req.query.ip;
  if (ip === undefined || ip === null) {
    const errMessage = serviceHelper.createErrorMessage('No IP address specified.');
    return res.json(errMessage);
  }
  const wsObj = await outgoingConnections.find(client => client._socket.remoteAddress === ip);
  if (wsObj) {
    const errMessage = serviceHelper.createErrorMessage(`Already connected to ${ip}`);
    return res.json(errMessage);
  }
  const authorized = await serviceHelper.verifyPrivilege('zelteam', req);

  if (authorized === true) {
    initiateAndHandleConnection(ip);
    const message = {
      status: 'success',
      data: {
        message: `Outgoing connection to ${ip} initiated`,
      },
    };
    response = message;
  } else {
    response = serviceHelper.errUnauthorizedMessage();
  }
  return res.json(response);
}

function incomingConnections(req, res, expressWS) {
  const clientsSet = expressWS.clients;
  const connections = [];
  clientsSet.forEach((client) => {
    connections.push(client._socket.remoteAddress);
  });
  const message = {
    status: 'success',
    data: {
      message: connections,
    },
  };
  response = message;
  res.json(response);
}

async function closeConnection(ip) {
  let message = {
    status: 'error',
    data: {
      message: `Unkown error while closing ${ip}`,
    },
  };
  const wsObj = await outgoingConnections.find(client => client._socket.remoteAddress === ip);
  if (wsObj) {
    const ocIndex = await outgoingConnections.indexOf(wsObj);
    const foundPeer = await outgoingPeers.find(peer => peer.ip === ip);
    if (ocIndex > -1) {
      wsObj.close(1000);
      log.info(`Connection to ${ip} closed`);
      outgoingConnections.splice(ocIndex, 1);
      if (foundPeer) {
        const peerIndex = outgoingPeers.indexOf(foundPeer);
        if (peerIndex > -1) {
          outgoingPeers.splice(peerIndex, 1);
        }
      }
      message = {
        status: 'success',
        data: {
          message: `Outgoing connection to ${ip} closed`,
        },
      };
    } else {
      message = {
        status: 'error',
        data: {
          message: `Unable to close connection ${ip}. Try again later.`,
        },
      };
    }
  } else {
    message = {
      status: 'success',
      data: {
        message: `Connection to ${ip} does not exists.`,
      },
    };
  }
  return message;
}

async function closeIncomingConnection(ip, expressWs) {
  const clientsSet = expressWs.clients;
  let message = {
    status: 'error',
    data: {
      message: `Unkown error while closing ${ip}`,
    },
  };
  const wsObj = await clientsSet.find(ws => ws._socket.remoteAddress === ip);
  if (wsObj) {
    wsObj.close(1000);
    log.info(`Connection from ${ip} closed`);
    message = {
      status: 'success',
      data: {
        message: `Incoming connection from ${ip} closed`,
      },
    };
  } else {
    message = {
      status: 'success',
      data: {
        message: `Connection from ${ip} does not exists.`,
      },
    };
  }
  return message;
}

async function removePeer(req, res) {
  let { ip } = req.params;
  ip = ip || req.query.ip;
  if (ip === undefined || ip === null) {
    const errMessage = serviceHelper.createErrorMessage('No IP address specified.');
    return res.json(errMessage);
  }
  const authorized = await serviceHelper.verifyPrivilege('zelteam', req);

  if (authorized === true) {
    const closeResponse = await closeConnection(ip);
    response = closeResponse;
  } else {
    response = serviceHelper.errUnauthorizedMessage();
  }
  return res.json(response);
}

async function removeIncomingPeer(req, res, expressWs) {
  let { ip } = req.params;
  ip = ip || req.query.ip;
  if (ip === undefined || ip === null) {
    const errMessage = serviceHelper.createErrorMessage('No IP address specified.');
    return res.json(errMessage);
  }
  const authorized = await serviceHelper.verifyPrivilege('zelteam', req);

  if (authorized === true) {
    const closeResponse = await closeIncomingConnection(ip, expressWs);
    response = closeResponse;
  } else {
    response = serviceHelper.errUnauthorizedMessage();
  }
  return res.json(response);
}

function startFluxFunctions() {
  fluxDisovery();
  log.info('Flux Discovery started');
  keepConnectionsAlive();
}

module.exports = {
  getFluxMessageSignature,
  verifyOriginalFluxBroadcast,
  verifyFluxBroadcast,
  handleIncomingConnection,
  fluxDisovery,
  broadcastMessage,
  broadcastMessageFromUser,
  broadcastMessageFromUserPost,
  serialiseAndSignZelFluxBroadcast,
  initiateAndHandleConnection,
  connectedPeers,
  startFluxFunctions,
  addPeer,
  incomingConnections,
  removePeer,
  removeIncomingPeer,
  connectedPeersInfo,
};