'use strict';
const OSRM = require( 'osrm'),
  async = require( 'async'),
  intersect = require( '@turf/intersect').default,
  bbox = require('@turf/bbox').default,
  squareGrid = require( '@turf/square-grid').default,
  config = require( '../config'),
  createProcessAreaTask = require( './tasks').createProcessAreaTask

  process.env.UV_THREADPOOL_SIZE = config.cpus;

/**
 * Process to compute the time it takes for each village inside the
 * admin area to reach the closest of each poi type.
 *
 * @param  {Feature} adminArea Admin area to work with.
 * @param  {Object} poiByType  Object where each key represents a poi type and
 *                             the value is a FeatureCollection of points.
 * @param  {FeatureCollection} origins  Points representing origins
 * @param  {String} osrmFile   Location of the osrm file.
 * @param  {number} gridSize   Size of the grip in km (default to 30)
 * @param  {number} maxTime    Value in seconds.
 * @param  {number} maxSpeed   Value in km/h.
 * @param  {Number} id
 *
 * @return                     The process will emit several states:
 */
process.on('message', function (e) {
  // Capture all the errors.
  try {
    init(e);
  } catch (err) {
    process.send({type: 'error', data: err.message, stack: err.stack});
    throw err;
  }
});

function init (e) {

  process.send({type: 'status', data: 'srv_started', id: e.id});
  const {
    id,
    poi,
    origins,
    osrmFile,
    adminArea,
    gridSize,
    maxTime,
    maxSpeed
  } = e;


  const osrm = new OSRM(osrmFile);
  process.send({type: 'status', data: 'srv_loaded_files', id: id});
  // Split the input region in squares for parallelisation.
  let extent = bbox(adminArea);
  let squares = squareGrid(extent, gridSize || 500, 'kilometers').features;
  process.send({type: 'squarecount', data: squares.length, id: id});

  // Create a task for each square to be run below.
  var squareTasks = squares.map(square => {
    // Clip the square with the input geometry. In this way we work with a
    // smaller area..
    let workArea = intersect(adminArea, square);
    return createProcessAreaTask(workArea, poi, origins, osrm, maxTime, maxSpeed, id);
  });

  async.parallelLimit(squareTasks, config.cpus, (err, allSquaresRes) => {
    if (err) {
      throw err;
    }
    // allSquaresRes -> is an array of square results.
    // Flatten the array.
    let flat = allSquaresRes.reduce((acc, squareData) => acc.concat(squareData), []);
    process.send({type: 'done', data: flat, osrm: e.osrm, id: id});
  });
}
