/*    Copyright 2016-2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const sysManager = require('./SysManager')
const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();
const DestIPFoundHook = require('../hook/DestIPFoundHook');
const destIPFoundHook = new DestIPFoundHook();
const country = require('../extension/country/country.js')
const HostTool = require('../net2/HostTool')
const hostTool = new HostTool()
const identityManager = require('../net2/IdentityManager.js');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const tagManager = require('../net2/TagManager.js');

const Constants = require('../net2/Constants.js');
const DEFAULT_QUERY_INTERVAL = 24 * 60 * 60; // one day
const DEFAULT_QUERY_COUNT = 100;
const MAX_QUERY_COUNT = 2000;

const Promise = require('bluebird');
const _ = require('lodash');

class LogQuery {

  // override this
  mergeLog(result, incoming) {
    throw new Error('not implemented')
  }

  shouldMerge(previous, incoming) {
    throw new Error('not implemented')
  }

  // logs should already be sorted
  mergeLogs(logs, options) {
    if (options.no_merge) return logs

    let mergedLogs = [];
    let lastLog = null;

    logs.forEach(entry => {
      if (!lastLog || !this.shouldMerge(lastLog, entry)) {
        mergedLogs.push(entry);
        lastLog = entry;
      } else {
        this.mergeLog(lastLog, entry);
      }
    });

    return mergedLogs;
  }

  stringToJSON(string) {
    try {
      return JSON.parse(string);
    } catch(err) {
      log.debug('Failed to parse log', string)
      return null;
    }
  }

  filterOptions(options) {
    // don't filter intf & tag here to keep the behavior same as before
    // it only makes sense to filter intf & tag when we query all devices
    // instead of simply expending intf and tag to mac addresses
    return _.omit(options, ['mac', 'direction', 'block', 'ts', 'ets', 'count', 'asc', 'intf', 'tag']);
  }

  isLogValid(log, options) {
    if (!log) return false

    for (const key in options) {
      if (log[key] != options[key]) return false
    }

    return true
  }

  // override this
  // convert to a simplified json format that's more readable by app
  toSimpleFormat(entry) {
    return entry
  }

  // results with ts behind feed.ts, results should have been sorted here
  validResultCount(options, results) {
    const safeIndex = results.findIndex(l => options.asc ? l.ts > options.ts : l.ts < options.ts)

    return safeIndex == -1 ? results.length : safeIndex
  }

  /**
   * @param {Object} options - common options for all feeds
   * @param {Object[]} feeds - feeds of logs
   * @param {function} feeds[].query - function that gets log
   * @param {Object} feeds[].options - unique options for the query
   */
  async logFeeder(options, feeds) {
    log.verbose(`logFeeder ${feeds.length} feeds`, JSON.stringify(_.omit(options, 'macs')))
    options = this.checkArguments(options)
    feeds.forEach(f => {
      f.options = f.options || {};
      Object.assign(f.options, options)
    })
    // log.debug( feeds.map(f => JSON.stringify(f) + '\n') )
    let results = []

    const toRemove = []
    // query every feed once concurrentyly to reduce io block
    results = _.flatten(await Promise.all(feeds.map(async feed => {
      const logs = await feed.query(feed.options)
      if (logs.length) {
        feed.options.ts = logs[logs.length - 1].ts
      } else {
        // no more elements, remove feed from feeds
        toRemove.push(feed)
      }
      return logs
    })))

    // the following code could be optimized further by using a heap
    results = _.orderBy(results, 'ts', options.asc ? 'asc' : 'desc')
    feeds = feeds.filter(f => !toRemove.includes(f))
    log.verbose(this.constructor.name, `Removed ${toRemove.length} feeds, ${feeds.length} remaining`, JSON.stringify(_.omit(options, 'macs')))

    // always query the feed moves slowest
    let feed = options.asc ? _.minBy(feeds, 'options.ts') : _.maxBy(feeds, 'options.ts')
    let prevFeed, prevTS

    while (feed && this.validResultCount(feed.options, results) < options.count) {

      prevFeed = feed
      prevTS = feed.options.ts

      const logs = await feed.query(feed.options)
      if (logs.length) {
        feed.options.ts = logs[logs.length - 1].ts

        // a more complicated and faster ordered merging without accessing elements via index.
        // result should be the same as
        // Array.prototype.push.apply(results, logs)
        // results.sort((a, b) => options.asc ? a.ts - b.ts : b.ts - a.ts )
        const merged = []
        let a = logs.shift();
        let b = results.shift();
        while (a || b) {
          if (a && (!b || options.asc ^ a.ts > b.ts)) {
            merged.push(a)
            a = logs.shift()
          } else {
            merged.push(b)
            b = results.shift()
          }
        }
        results = merged

        // leaving merging for front-end
        // results = this.mergeLogs(results, options);
      } else {
        // no more elements, remove feed from feeds
        feeds = feeds.filter(f => f != feed)
        log.debug('Removing', feed.query.name, feed.options.direction || (feed.options.block ? 'block':'accept'), feed.options.mac, feed.options.ts)
      }

      feed = options.asc ? _.minBy(feeds, 'options.ts') : _.maxBy(feeds, 'options.ts')
      if (feed == prevFeed && feed.options.ts == prevTS) {
        log.error("Looping!!", feed.query.name, feed.options)
        break
      }
    }

    return results.slice(0, options.count)
  }

  checkCount(options) {
    if (!options.count) options.count = DEFAULT_QUERY_COUNT
    if (options.count > MAX_QUERY_COUNT) options.count = MAX_QUERY_COUNT
  }

  checkArguments(options) {
    options = options || {}
    this.checkCount(options)
    if (!options.asc) options.asc = false;
    if (!options.ts) {
      options.ts = options.asc ?
        options.begin || new Date() / 1000 - DEFAULT_QUERY_INTERVAL :
        options.end || new Date() / 1000
    }
    if (!options.ets) {
      options.ets = options.asc ?
        (options.end || options.ts + DEFAULT_QUERY_INTERVAL) :
        (options.begin || options.ts - DEFAULT_QUERY_INTERVAL)
    }

    delete options.begin
    delete options.end

    return options
  }

  async expendMacs(options) {
    log.debug('Expending mac addresses from options', options)

    const HostManager = require("../net2/HostManager.js");
    const hostManager = new HostManager();
    await hostManager.getHostsAsync()

    let allMacs = [];
    if (options.mac) {
      if (!_.isString(options.mac)) throw new Error('Invalid host')

      if (hostTool.isMacAddress(options.mac)) {
        const host = hostManager.getHostFastByMAC(options.mac);
        if (!host || !host.o.mac) {
          throw new Error("Invalid Host");
        }
        allMacs.push(options.mac)
      } else if (identityManager.isGUID(options.mac)) {
        const identity = identityManager.getIdentityByGUID(options.mac);
        if (!identity) {
          throw new Error(`Identity GUID ${options.mac} not found`);
        }
        allMacs.push(identityManager.getGUID(identity))
      }
    } else if (options.intf) {
      const intf = networkProfileManager.getNetworkProfile(options.intf);
      if (!intf) {
        throw new Error('Invalid Interface')
      }
      if (intf.o && (intf.o.intf === "tun_fwvpn" || intf.o.intf.startsWith("wg"))) {
        // add additional macs into options for VPN server network
        const allIdentities = identityManager.getIdentitiesByNicName(intf.o.intf);
        for (const ns of Object.keys(allIdentities)) {
          const identities = allIdentities[ns];
          for (const uid of Object.keys(identities)) {
            if (identities[uid])
              allMacs.push(identityManager.getGUID(identities[uid]));
          }
        }
      } else {
        allMacs = hostManager.getIntfMacs(options.intf);
      }
    } else if (options.tag) {
      const tag = tagManager.getTagByUid(options.tag);
      if (!tag) {
        throw new Error('Invalid Tag')
      }
      allMacs = await hostManager.getTagMacs(options.tag);
    } else {
      allMacs = hostManager.getActiveMACs();
      allMacs.push(... identityManager.getAllIdentitiesGUID())

      if (options.audit || options.block || this.includeFirewallaInterfaces())
        allMacs.push(... sysManager.getLogicInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`))
    }

    if (!allMacs || !allMacs.length) return []

    log.debug('Expended mac addresses', allMacs)

    return allMacs
  }


  // get logs across different devices
  async getAllLogs(options) {

    options = this.checkArguments(options)

    log.verbose('----====', this.constructor.name, 'getAllLogs', JSON.stringify(_.omit(options, 'macs')))

    const allMacs = options.macs || [ options.mac ]

    if (!Array.isArray(allMacs)) throw new Error('Invalid mac set', allMacs)

    const feeds = allMacs.map(mac => { return { query: this.getDeviceLogs.bind(this), options: {mac} } })

    // query less each time to improve perf
    options = Object.assign({count: options.count}, options)

    delete options.macs // for a cleaner debug log
    delete options.mac

    const allLogs = await this.logFeeder(options, feeds)

    return allLogs
  }


  async enrichWithIntel(logs) {
    return await Promise.map(logs, async f => {
      if (f.ip) {
        // get intel from redis. if failed, create a new one
        const intel = await intelTool.getIntel(f.ip);

        if (intel) {
          if (intel.country) f.country = intel.country;
          f.host = intel.host;
          if (intel.category) {
            f.category = intel.category
          }
          if (intel.app) {
            f.app = intel.app
          }
        }

        if (!f.country) {
          const c = country.getCountry(f.ip)
          if (c) f.country = c
        }

        // failed on previous cloud request, try again
        if (intel && intel.cloudFailed || !intel) {
          // not waiting as that will be too slow for API call
          destIPFoundHook.processIP(f.ip);
        }
      }

      if (f.rl) {
        const rlIp = f.rl.split(":")[0];
        const rlIntel = await intelTool.getIntel(rlIp);
        if (rlIntel) {
          if (rlIntel.country)
            f.rlCountry = rlIntel.country;
        }
        if (!f.rlCountry) {
          const c = country.getCountry(rlIp);
          if (c)
            f.rlCountry = c;
        }
      }

      return f;
    }, {concurrency: 50}); // limit to 10
  }

  // override this
  getLogKey(target, options) {
    throw new Error('not implemented')
  }

  async getDeviceLogs(options) {
    options = this.checkArguments(options)

    const target = options.mac
    if (!target) throw new Error('Invalid device')

    const key = this.getLogKey(target, options);

    const zrange = (options.asc ? rclient.zrangebyscoreAsync : rclient.zrevrangebyscoreAsync).bind(rclient);
    const results = await zrange(key, '(' + options.ts, options.ets, "LIMIT", 0 , options.count);

    if(results === null || results.length === 0)
      return [];

    const filter = this.filterOptions(options);
    log.debug(this.constructor.name, 'getDeviceLogs', options.direction || (options.block ? 'block':'accept'), target, options.ts, JSON.stringify(filter))

    const logObjects = results
      .map(str => {
        const obj = this.stringToJSON(str)
        if (!obj) return null

        let s = this.toSimpleFormat(obj, options)
        s.device = target; // record the mac address here
        return s;
      })
      .filter(x => this.isLogValid(x, filter));

    return logObjects
  }
}

module.exports = LogQuery;
