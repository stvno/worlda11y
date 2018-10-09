'use strict';
import path from 'path';
import { exec, fork } from 'child_process';
import fs from 'fs';
import async from 'async';
import json2csv from 'json2csv';

import config from './config';
import Operation from './utils/operation';
import AppLogger from './utils/app-logger';
import * as opCodes from './utils/operation-codes';

const { PROJECT_ID: projId, SCENARIO_ID: scId, CONVERSION_DIR: conversionDir } = process.env;
const operationId = parseInt(process.env.OPERATION_ID);
const WORK_DIR = path.resolve(conversionDir, `p${projId}s${scId}`);

const DEBUG = config.debug;
const logger = AppLogger({ output: DEBUG });
const operation = new Operation(db);

// Needs to be global, so it can be decreased.
var totalAdminAreasToProcess = 0;

try {
  fs.mkdirSync(WORK_DIR);
} catch (e) {
  if (e.code !== 'EEXIST') {
    throw e;
  }
}

logger.log('Max running processes set at', config.cpus);

// Allow loading an operation through a given id.
// This is useful when the app starts an operation that this worker has to use.
// It's good to show the user feedback because there's some delay between the
// time the worker is triggered to the moment it actually starts.
//
// If the id is given load the operation and handle it from there,
// otherwise create a new one.
let operationExecutor;
if (isNaN(operationId)) {
  operationExecutor = operation.start('generate-analysis', projId, scId);
} else {
  operationExecutor = operation.loadById(operationId);
}

operationExecutor
// Start by loading the info on all the project and scenario files needed
// for the results processing.
.then(() => fetchFilesInfo(projId, scId))
.then(files => {
  // Write files used by osm2osrm to disk.
  return Promise.all([
    writeFile(files.profile.path, `${WORK_DIR}/profile.lua`),
    writeFile(files['road-network'].path, `${WORK_DIR}/road-network.osm`)
  ])
  .then(() => operation.log(opCodes.OP_OSRM, {message: 'osm2osrm processing started'}))
  // Create orsm files and cleanup.
  .then(() => osm2osrm(WORK_DIR))
  .then(() => osm2osrmCleanup(WORK_DIR))
  .then(() => operation.log(opCodes.OP_OSRM, {message: 'osm2osrm processing finished'}));
})
// Fetch the remaining needed data.
.then(() => Promise.all([
  fetchOrigins(projId),
  fetchPoi(projId, scId),
  fetchAdminAreas(projId, scId)
]))
.then(res => {
  logger.log('Data fetched');
  let [origins, pois, adminAreasFC] = res;
  totalAdminAreasToProcess = adminAreasFC.features.length;

  var timeMatrixTasks = adminAreasFC.features.map(area => {
    const data = {
      adminArea: area,
      origins: origins,
      pois,
      maxSpeed: 120,
      maxTime: 3600 / 2
    };
    return createTimeMatrixTask(data, `${WORK_DIR}/road-network.osrm`);
  });
  logger.log('Tasks created');
  // createTimeMatrixTask need to be executed in parallel with a limit because
  // they spawn new processes. Use async but Promisify to continue chain.
  let timeMatrixRunner = new Promise((resolve, reject) => {
    let time = Date.now();
    async.parallelLimit(timeMatrixTasks, config.cpus, (err, adminAreasData) => {
      if (err) return reject(err);
      logger.log('Processed', timeMatrixTasks.length, 'admin areas in', (Date.now() - time) / 1000, 'seconds');
      return resolve(adminAreasData);
    });
  });

  return operation.log(opCodes.OP_ROUTING, {message: 'Routing started', count: timeMatrixTasks.length})
    .then(() => timeMatrixRunner)
    .then(adminAreasData => operation.log(opCodes.OP_ROUTING, {message: 'Routing complete'}).then(() => adminAreasData));
})
// DB storage.
.then(adminAreasData => {
  let results = [];
  let resultsPois = [];
  adminAreasData.forEach(aa => {
    aa.json.forEach(o => {
      results.push({
        scenario_id: scId,
        project_id: projId,
        origin_id: o.id,
        project_aa_id: aa.adminArea.id
      });

      let pois = Object.keys(o.poi).map(k => ({
        type: k,
        time: o.poi[k] === null ? null : Math.round(o.poi[k])
      }));
      // Will be flattened later.
      // The array is constructed in this way so we can match the index of the
      // results array and attribute the correct id.
      resultsPois.push(pois);
    });
  });

  return db.transaction(function (trx) {
    return trx.batchInsert('results', results)
      .returning('id')
      .then(ids => {
        // Add ids to the resultsPoi and flatten the array in the process.
        let flat = [];
        resultsPois.forEach((resPoi, rexIdx) => {
          resPoi.forEach(poi => {
            poi.result_id = ids[rexIdx];
            flat.push(poi);
          });
        });
        return flat;
      })
      .then(data => trx.batchInsert('results_poi', data));
  })
  .then(() => adminAreasData);
})
// S3 storage.
.then(adminAreasData => {
  logger.group('s3').log('Storing files');

  return operation.log(opCodes.OP_RESULTS, {message: 'Storing results'})
    .then(() => Promise.all([
      // Generate a csv with all the results.
      saveScenarioFile('results-csv', 'all-csv', generateCSV(adminAreasData), projId, scId),
      // Generate a JSON file with all results.
      saveScenarioFile('results-json', 'all-json', generateJSON(adminAreasData), projId, scId),
      // For all admin areas combined, results are stored in GeoJSON format.
      saveScenarioFile('results-geojson', 'all-geojson', generateGeoJSON(adminAreasData), projId, scId)
    ]))
    .then(() => operation.log(opCodes.OP_RESULTS, {message: 'Storing results complete'}))
    .then(() => {
      logger.group('s3').log('Storing files complete');
    });
})
// Update generation time.
.then(() => db('scenarios_settings')
  .update({value: (new Date())})
  .where('scenario_id', scId)
  .where('key', 'res_gen_at')
)
.then(() => operation.log(opCodes.OP_RESULTS_FILES, {message: 'Files written'}))
.then(() => operation.log(opCodes.OP_SUCCESS, {message: 'Operation complete'}))
.then(() => operation.finish())
.then(() => logger.toFile(`${WORK_DIR}/process.log`))
.then(() => process.exit(0))
.catch(err => {
  console.log('err', err);
  let eGroup = logger.group('fatal-error');
  if (err.message) {
    eGroup.log(err.message);
    eGroup.log(err.stack);
  } else {
    eGroup.log(err);
  }
  logger.toFile(`${WORK_DIR}/process.log`);
  operation.log(opCodes.OP_ERROR, {error: err.message || err})
    .then(() => operation.finish())
    .then(() => process.exit(1))
    // If it errors again exit.
    // This is especially important in the case of DB errors.
    .catch(() => process.exit(1));
});

//
// Execution code ends here. From here on there are the helper functions
// used in the script.
// -------------------------------------
// This is just a little separation.
//

function fetchFilesInfo (projId, scId) {
  return Promise.all([
    db('projects_files')
      .select('*')
      .whereIn('type', ['profile'])
      .where('project_id', projId)
      .first(),
    db('scenarios_files')
      .select('*')
      .whereIn('type', ['road-network'])
      .where('project_id', projId)
      .where('scenario_id', scId)
      .first()
  ])
  .then(files => ({
    'profile': files[0],
    'road-network': files[1]
  }));
}

function fetchOrigins (projId) {
  return db('projects_origins')
    .select(
      'projects_origins.id',
      'projects_origins.name',
      'projects_origins.coordinates',
      'projects_origins_indicators.key',
      'projects_origins_indicators.value'
    )
    .innerJoin('projects_origins_indicators', 'projects_origins.id', 'projects_origins_indicators.origin_id')
    .where('project_id', projId)
    .then(origins => {
      // Group by indicators.
      let indGroup = {};
      origins.forEach(o => {
        let hold = indGroup[o.id];
        if (!hold) {
          hold = {
            id: o.id,
            name: o.name,
            coordinates: o.coordinates
          };
        }
        hold[o.key] = o.value;
        indGroup[o.id] = hold;
      });

      return {
        type: 'FeatureCollection',
        features: Object.keys(indGroup).map(k => {
          let props = Object.assign({}, indGroup[k]);
          delete props.coordinates;
          return {
            type: 'Feature',
            properties: props,
            geometry: {
              type: 'Point',
              coordinates: indGroup[k].coordinates
            }
          };
        })
      };

      // Convert origins to featureCollection.
      // TODO: Use this once the results are returned from the db.
      // return {
      //   type: 'FeatureCollection',
      //   features: origins.map(o => ({
      //     type: 'Feature',
      //     properties: {
      //       id: o.id,
      //       name: o.name
      //     },
      //     geometry: {
      //       type: 'Point',
      //       coordinates: o.coordinates
      //     }
      //   }))
      // };
    });
}

function fetchPoi (projId, scId) {
  return db('scenarios_files')
    .select('*')
    .where('type', 'poi')
    .where('project_id', projId)
    .where('scenario_id', scId)
    .then(files => Promise.all(files.map(f => getJSONFileContents(f.path)))
      .then(fileData => {
        // Index pois by subtype.
        let loaded = {};
        files.forEach((file, idx) => {
          loaded[file.subtype] = fileData[idx];
        });

        return loaded;
      })
    );
}

const arrayDepth = (arr) => Array.isArray(arr) ? arrayDepth(arr[0]) + 1 : 0;
const getGeometryType = (geometry) => {
  switch (arrayDepth(geometry)) {
    case 3:
      return 'Polygon';
    case 4:
      return 'MultiPolygon';
    default:
      throw new Error('Malformed coordinates array. Expected Polygon or MultiPolygon.');
  }
};

function fetchAdminAreas (projId, scId) {
  return db('scenarios_settings')
    .select('value')
    .where('key', 'admin_areas')
    .where('scenario_id', scId)
    .first()
    .then(aa => JSON.parse(aa.value))
    .then(selectedAA => {
      // Get selected adminAreas.
      return db('projects_aa')
        .select('*')
        .where('project_id', projId)
        .whereIn('id', selectedAA)
        .then(aa => {
          // Convert admin areas to featureCollection.
          return {
            type: 'FeatureCollection',
            features: aa.map(o => ({
              type: 'Feature',
              properties: {
                id: o.id,
                name: o.name,
                type: o.type,
                project_id: o.project_id
              },
              geometry: {
                type: getGeometryType(o.geometry),
                coordinates: o.geometry
              }
            }))
          };
        });
    });
}


// Store all the created processes.
let runningProcesses = [];

function createTimeMatrixTask (data, osrmFile) {
  return (callback) => {
    const taskLogger = logger.group(data.adminArea.properties.name);
    const beginTime = Date.now();
    let processData = {
      id: 2,
      poi: data.pois,
      gridSize: 30,
      origins: data.origins,
      osrmFile: osrmFile,
      maxTime: data.maxTime,
      maxSpeed: data.maxSpeed,
      adminArea: data.adminArea
    };
    let remainingSquares = null;
    let processError = null;

    const cETA = fork(path.resolve(__dirname, 'calculateETA.js'));
    runningProcesses.push(cETA);

    cETA.send(processData);
    cETA.on('message', function (msg) {
      switch (msg.type) {
        case 'error':
          processError = msg;
          break;
        case 'debug':
          taskLogger.log('debug', msg.data);
          break;
        case 'status':
          taskLogger.log('status', msg.data);
          break;
        case 'squarecount':
          remainingSquares = msg.data;
          taskLogger.log('total squares', msg.data);
          break;
        case 'square':
          remainingSquares--;
          taskLogger.log('square processed', msg.data, 'Remaining', remainingSquares);
          // Emit status?
          break;
        case 'done':
          let calculationTime = (Date.now() - beginTime) / 1000;
          taskLogger.log('Total routing time', calculationTime);
          let result = msg.data;
          let json = null;

          if (!result.length) {
            // Result may be empty if in the work area there are no origins.
            taskLogger.log('No results returned');
            json = [];
          } else {
            taskLogger.log(`Results returned for ${result.length} origins`);
            json = result;
          }

          const finish = () => {
            cETA.disconnect();
            return callback(null, {
              adminArea: data.adminArea.properties,
              json
            });
          };

          // Error or not, we finish the process.
          operation.log(opCodes.OP_ROUTING_AREA, {
            message: 'Routing complete',
            adminArea: data.adminArea.properties.name,
            remaining: --totalAdminAreasToProcess
          })
          .then(() => finish(), () => finish());

          // break;
      }
    });

    cETA.on('exit', (code) => {
      if (code !== 0) {
        // Stop everything if one of the processes errors.
        runningProcesses.forEach(p => p.kill());
        let error;
        if (processError) {
          error = new Error(`calculateETA exited with error - ${processError.data}`);
          error.stack = processError.stack;
        } else {
          error = new Error(`calculateETA exited with error - unknown`);
        }
        error.code = code;
        return callback(error);
      }
    });
  };
}

/**
 * Stores a scenario file to the storage engine and updates the database.
 * @param  {object} data   Object with data to store and admin area properties.
 * @param  {number} projId Project id.
 * @param  {number} scId   Scenario id.
 * @return {Promise}
 */
function saveScenarioFile (type, name, data, projId, scId) {
  const fileName = `results_${name}_${Date.now()}`;
  const filePath = `scenario-${scId}/${fileName}`;
  const fileData = {
    name: fileName,
    type: type,
    path: filePath,
    project_id: projId,
    scenario_id: scId,
    created_at: (new Date()),
    updated_at: (new Date())
  };

  logger.group('s3').log('Saving file', filePath);
  let contents = typeof data === 'string' ? data : JSON.stringify(data);
  return putFile(filePath, contents)
    .then(() => db('scenarios_files')
      .returning('*')
      .insert(fileData)
      .then(() => db('projects')
        .update({
          updated_at: (new Date())
        })
        .where('id', projId)
      )
    );
}

/**
 * Generates a GeoJSON FeatureCollection from the results
 * @param   {object} data   Object with data to store
 * @return  {FeatureCollection}
 */
function generateGeoJSON (data) {
  // Flatten the results array
  let jsonResults = [].concat.apply([], data.map(o => o.json));
  return {
    type: 'FeatureCollection',
    features: jsonResults.map(r => {
      let ft = {
        type: 'Feature',
        properties: {
          id: r.id,
          name: r.name,
          pop: r.population
        },
        geometry: {
          type: 'Point',
          coordinates: [r.lon, r.lat]
        }
      };
      for (let poiType in r.poi) {
        ft.properties[`eta-${poiType}`] = r.poi[poiType];
      }
      return ft;
    })
  };
}

/**
 * Generates a JSON file from the results
 * @param   {object} data   Object with data to store
 * @return  {object}
 */
function generateJSON (data) {
  return data.map(o => {
    return {
      id: o.adminArea.id,
      name: o.adminArea.name,
      results: o.json
    };
  });
}

/**
 * Generates a CSV file from the results
 * @param   {object} data   Object with data to store
 * @return  {string}
 */
function generateCSV (data) {
  // Merge all the results together.
  let results = data.reduce((acc, o) => {
    if (o.json.length) {
      let items = o.json.map(item => {
        item['admin_area'] = o.adminArea.name;
        return item;
      });
      return acc.concat(items);
    }
    return acc;
  }, []);

  if (!results.length) {
    return 'The analysis didn\'t produce any results';
  }

  // Prepare the csv.
  // To form the fields array for json2csv convert from:
  // {
  //  prop1: 'prop1',
  //  prop2: 'prop2',
  //  poi: {
  //    poiName: 'poi-name'
  //  },
  //  prop3: 'prop3'
  // }
  // to
  // [prop1, prop2, prop3, poi.poiName]
  //
  // Poi fields as paths for nested objects.
  let poiFields = Object.keys(results[0].poi).map(o => `poi.${o}`);

  // Get other fields, exclude poi and include new poi.
  let fields = Object.keys(results[0])
    .filter(o => o !== 'poi')
    .concat(poiFields);

  return json2csv({ data: results, fields: fields });
}
