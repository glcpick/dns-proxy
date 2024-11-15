const fs = require('fs').promises;  // Using the promises API
const rc = require('rc');
const dgram = require('dgram');
const packet = require('native-dns-packet');
const wildcard = require('wildcard2');
const axios = require('axios');

const util = require('./util.js');

// Declare defaults variable
let defaults;

// Asynchronous function to fetch defaults from a URL
async function fetchDefaults() {
  try {
    const response = await axios.get('http://example.com/config-url'); // Replace with your URL
    defaults = response.data;
  } catch (error) {
    console.error('Error fetching defaults:', error);
    process.exit(1);
  }
}

fetchDefaults().then(() => {
  const config = rc('dnsproxy', defaults);

  process.env.DEBUG_FD = process.env.DEBUG_FD || 1;
  process.env.DEBUG = process.env.DEBUG || config.logging;
  const d = process.env.DEBUG.split(',');
  d.push('dnsproxy:error');
  process.env.DEBUG = d.join(',');

  const loginfo = require('debug')('dnsproxy:info');
  const logdebug = require('debug')('dnsproxy:debug');
  const logquery = require('debug')('dnsproxy:query');
  const logerror = require('debug')('dnsproxy:error');

  if (config.reload_config === true && config.config !== undefined) {
    const configFile = config.config;
    fs.watchFile(configFile, (curr, prev) => {
      loginfo('Config file changed, reloading config options');
      try {
        config = rc('dnsproxy', defaults);
      } catch (e) {
        logerror('Error reloading configuration', e);
      }
    });
  }

  logdebug('Options: %j', config);

  const server = dgram.createSocket('udp4');

  server.on('listening', () => {
    loginfo(`We are up and listening at ${config.host} on ${config.port}`);
  });

  server.on('error', (err) => {
    logerror('UDP socket error', err);
  });

  server.on('message', (message, rinfo) => {
    handleDNSMessage(message, rinfo);
  });

  server.bind(config.port, config.host);
}

// Function to handle DNS messages
function handleDNSMessage(message, rinfo) {
  let returner = false;
  let nameserver = config.nameservers[0];

  const query = packet.parse(message);
  const domain = query.question[0].name;
  const type = query.question[0].type;

  logdebug('Query: %j', query);

  Object.keys(config.hosts).forEach((h) => {
    if (domain === h) {
      let answer = config.hosts[h];
      if (config.hosts[answer] !== undefined) {
        answer = config.hosts[answer];
      }

      logquery(`Type: host, Domain: ${domain}, Answer: ${config.hosts[h]}, Source: ${rinfo.address}:${rinfo.port}, Size: ${rinfo.size}`);

      const res = util.createAnswer(query, answer);
      server.send(res, 0, res.length, rinfo.port, rinfo.address);

      returner = true;
    }
  });

  if (returner) return;

  Object.keys(config.domains).forEach((s) => {
    const sLen = s.length;
    const dLen = domain.length;

    if ((domain.indexOf(s) >= 0 && domain.indexOf(s) === (dLen - sLen)) || wildcard(domain, s)) {
      let answer = config.domains[s];
      if (config.domains[answer] !== undefined) {
        answer = config.domains[answer];
      }

      logquery(`Type: server, Domain: ${domain}, Answer: ${config.domains[s]}, Source: ${rinfo.address}:${rinfo.port}, Size: ${rinfo.size}`);

      const res = util.createAnswer(query, answer);
      server.send(res, 0, res.length, rinfo.port, rinfo.address);

      returner = true;
    }
  });

  if (returner) return;

  Object.keys(config.servers).forEach((s) => {
    if (domain.indexOf(s) !== -1) {
      nameserver = config.servers[s];
    }
  });
  
  queryNameserver(message, nameserver, rinfo, domain, type);
}

// Function to query the nameserver
function queryNameserver(message, nameserver, rinfo, domain, type) {
  const nameParts = nameserver.split(':');
  nameserver = nameParts[0];
  const port = nameParts[1] || 53;
  let fallback;
  (function queryns(msg, ns) {
    const sock = dgram.createSocket('udp4');
    sock.send(msg, 0, msg.length, port, ns, () => {
      fallback = setTimeout(() => {
        queryns(msg, config.nameservers[0]);
      }, config.fallback_timeout);
    });
    sock.on('error', (err) => {
      logerror('Socket Error:', err);
      process.exit(5);
    });
    sock.on('message', (response) => {
      clearTimeout(fallback);
      logquery(`Type: primary, Nameserver: ${nameserver}, Query: ${domain}, Type: ${util.records[type] || 'unknown'}, Answer: ${util.listAnswer(response)}, Source: ${rinfo.address}:${rinfo.port}, Size: ${rinfo.size}`);
      server.send(response, 0, response.length, rinfo.port, rinfo.address);
      sock.close();
    });
  }(message, nameserver));
}

// Execute the main function
main();
