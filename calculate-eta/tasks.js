'use strict';
const range = require('./utils').range,
originsInRegion= require('./utils').originsInRegion,
poisInBuffer= require('./utils').poisInBuffer,
async = require('async')

/**
 * Compute the time it takes for each village inside the given work area to
 * reach the closest of each poi type.
 * @param  {Feature} workArea  Area to process.
 * @param  {Object} poiByType  Object where each key represents a poi type and
 *                             the value is a FeatureCollection of points.
 * @param  {FeatureCollection} origins  Points representing origins
 * @param  {Object} osrm       The osrm object as created by new OSRM()
 * @param  {number} maxTime    Value in seconds
 * @param  {number} maxSpeed   Value in km/h
 * @param  {Number} id
 *
 * @return {Function}          Task function for async
 *   When resolved the function will return and array with the properties
 *   of each village plus the shortest time to each poi.
 *   [
 *   {
 *     [propKey]: 'prop value',
 *     [poiType]: 1000,
 *     lat: 0,
 *     long: 0
 *   },
 *   ...
 *   ]
 *   `poiType` is the time in seconds to reach it
 */
function createProcessAreaTask (workArea, poi, origins, osrm, maxTime, maxSpeed, id) {
  return (callback) => {
    process.send({type: 'debug', data: `Start square processing.`, id: id});
    if (!workArea) {
      // The square doesn't intersect with the adminArea.
      // Return an empty result.
      process.send({type: 'square', data: 'No intersection', id: id});
      return callback(null, []);
    }

    // Get the origins in the area.
    let workingSet = originsInRegion(workArea, origins);
    if (workingSet.features.length === 0) {
      // There are no origins within the square.
      // Return an empty result.
      process.send({type: 'square', data: 'No origins', id: id});
      return callback(null, []);
    }

    process.send({type: 'debug', data: `Origins in working set: ${workingSet.features.length}`, id: id});

    let poilist = [];

    // For each POI type (banks, hospitals...) get at least 4 in the area.
    // If there are none increase the search buffer until they're found.

      let poiSet;
      let time = maxTime;
      let speed = maxSpeed;
      let key = 'town';
      // We want to have at least 4 poi to work with, but we have to account
      // for the case where there are less than 4, as to avoid infinite loops.
      let totalPoi = poi.features.length;
      let minPoi = Math.min(totalPoi, 4);
      process.send({type: 'debug', data: `Total poi of type ${key}: ${totalPoi}`, id: id});
      do {
        poiSet = poisInBuffer(workArea, poi, time, speed);
        time += 900;
      } while (poiSet.features.length < minPoi);
      process.send({type: 'debug', data: `Using ${poiSet.features.length} pois. Time: ${time - 900}`, id: id});

      poilist.push({type: key, items: poiSet});


    // Add 'nearest' as a POI type to calculate the distance between village
    // and the nearest road
    poilist.push({type: 'nearest'});

    // Create a flat array of origins coordinates, to be used as source for
    // the routing calculation.
    let originsCoords = workingSet.features.map(feat => ([feat.geometry.coordinates[0], feat.geometry.coordinates[1]]));
    if (originsCoords.length === 0) throw new Error('no sources');

    // One task per POI type to calculate the distance from the POI to
    // each one of the origins.
    let poiTypeTasks = poilist.map(poiGroupType => {
      if (poiGroupType.type === 'nearest') {
        return createPoiTypeNearestTask(osrm, originsCoords);
      } else {
        return createPoiTypeTask(osrm, poiGroupType, originsCoords);
      }
    });

    // In series, because the main async will keep track of the threadpool
    // and adding parallel tasks here overloads it.
    async.series(poiTypeTasks, (err, poiTime) => {
      // poiTime -> for each poi type an array of the origins indexes and
      // the shortest distance to that poi.
      if (err) {
        throw err;
      }

      // Store the properties of the origins in this square and add
      // additional properties with the time to reach the poi.
      let squareResults = [];

      // Origins properties.
      workingSet.features.forEach((village, villageIdx) => {
        let properties = Object.assign({}, village.properties);
        // Add coordinates.
        properties.lat = village.geometry.coordinates[1];
        properties.lon = village.geometry.coordinates[0];
        properties.poi = {};

        // Compute the final time to each poi. OSRM returns the time it takes
        // from the nearest feature of the source point to the destination point.
        // There may be a distance between de actual point and what OSRM uses
        // as the actual source. This is represented by `nearest` and is in
        // meters. We need to compute the time it would take someone to do it
        // using the WALKSPEED

        // Walk speed in km/h
        const WALKSPEED = 4;

        let nearest = poiTime.find(p => p.poi === 'nearest');
        // Compute time to each poi.
        poiTime.filter(p => p.poi !== 'nearest').forEach(item => {
          // Walk speed in the unit we need. s/m (seconds per meter)
          let speed = WALKSPEED * 1000 / 3600;
          // item.list is an array of values in the same order as the
          // village, hence access by index is fine.
          properties.poi[item.poi] = item.list[villageIdx].eta + nearest.list[villageIdx].distance * speed;
        });

        squareResults.push(properties);
      });

      process.send({type: 'square', data: 'Processed', id: id});
      return callback(null, squareResults);
    });
  };
}

/**
 * Handle POIs of type nearest
 * @param  {Object} osrm           The osrm object as created by new OSRM()
 * @param  {Array} originsCoords  Array of village coordinates (Points)
 *
 * @return {Function}              Task function for async
 *   When resolved the function will return the shortest time from each village
 *   to the nearest road.
 *   {
 *    poi: 'nearest',
 *    list: [
 *      {
 *        eta: Number
 *      },
 *      ...
 *    ]
 *   }
 *   `list` is ordered the same way as the input `originsCoords`
 */
function createPoiTypeNearestTask (osrm, originsCoords) {
  return (callback) => {
    // Calculate distance from each village to the nearest road segment.
    let nearTasks = originsCoords.map((village, idx) => {
      return (cb) => {
        osrm.nearest({ coordinates: [village] }, (err, res) => {
          if (err) {
            process.send({type: 'status', data: 'error'});
            console.log('error', err);
            return cb(err);
          }

          var distance = res.waypoints[0].distance;
          // Return the distance to reach the point, using the village id
          // as identifier.
          return cb(null, {sourceIdx: idx, distance});
        });
      };
    });

    let results = [];
    // Run the nearest tasks in series, they are pretty fast and
    // otherwise will mess up the async.parallel
    async.series(nearTasks, (err, nearTasksRes) => {
      if (err) {
        process.send({type: 'status', data: 'error'});
        return callback(err);
      }
      nearTasksRes.forEach(near => { results[near.sourceIdx] = {distance: near.distance}; });
      // Return the subcallback (POI level callback)
      return callback(null, { poi: 'nearest', list: results });
    });
  };
}

/**
 * Handle all the other POI types.
 * @param  {Object} osrm           The osrm object as created by new OSRM()
 * @param  {Object} poiGroup       Poi group object
 * @param  {String} poiGroup.type  Type of the poi
 * @param  {Array} poiGroup.items  Feature collection of poi
 * @param  {Array} originsCoords  Array of village coordinates (Points)
 *
 * @return {Function}              Task function for async
 *   When resolved the function will return the shortest time from each village
 *   to the nearest poi of the given type.
 *   {
 *    poi: 'poi-type',
 *    list: [
 *      {
 *        eta: Number
 *      },
 *      ...
 *    ]
 *   }
 *   `list` is ordered the same way as the input `originsCoords`
 */
function createPoiTypeTask (osrm, poiGroup, originsCoords) {
  return (callback) => {
    // Create a flat array with the coordinates of the poi, to be used
    // as destinations.
    let poiCoords = poiGroup.items.features.map(feat => ([feat.geometry.coordinates[0], feat.geometry.coordinates[1]]));
    // This should not happen :)
    if (poiCoords.length === 0) throw new Error('no destinations');

    // OSRM v5 requires one list of coordinates and two arrays of indices.
    let allCoords = originsCoords.concat(poiCoords);
    // Indexes of {allCoords} that refer to origins
    let originsIndexes = range(0, originsCoords.length);
    // Indexes of {allCoords} that refer to poi
    let poiIndexes = range(originsCoords.length, originsCoords.length + poiCoords.length);

    let osrmOptions = {
      coordinates: allCoords,
      destinations: poiIndexes,
      sources: originsIndexes
    };

    let results = [];
    osrm.table(osrmOptions, (err, res) => {
      if (err) {
        process.send({type: 'status', data: 'error'});
        // process.send({type: 'status', data: 'error', id: id});
        console.log('error', err);
        return callback(err);
      }

      // res.duration -> Table where each row represents a source (village)
      // and each column represents a destination (poi). Each cell displays
      // the time it takes from the source to the destination.

      // Validations
      if (res.durations && res.sources && res.destinations &&
      res.durations.length === res.sources.length &&
      res.durations[0].length === res.destinations.length) {
        // When there's no connection between two places OSRM returns null, and
        // it is interpreted as 0. We have to convert all nulls to Infinity to
        // ensure correct calculations.
        results = res.durations.map(timeToPoi => ({ eta: Math.min(...timeToPoi.map(t => t !== null ? t : Infinity)) }));
      }

      return callback(null, {poi: poiGroup.type, list: results});
    });
  };
}

module.exports = {
  createPoiTypeTask: createPoiTypeTask,
  createPoiTypeNearestTask: createPoiTypeNearestTask,
   createProcessAreaTask:  createProcessAreaTask
}