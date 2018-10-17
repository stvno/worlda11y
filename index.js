'use strict';

const path = require('path'),
 fork = require( 'child_process').fork,
 fs = require('fs'),
 async = require( 'async'),
 config = require( './config'),
 AppLogger = require( './utils/app-logger'),
 DEBUG = config.debug,
 logger = AppLogger({ output: DEBUG }),
 WORK_DIR = path.resolve(__dirname),
 json2csv = require('json2csv').parse

let region = 'central-america-latest',
    osrmFiles = 'osrm/'+region+'.osrm',
    sourceFile = 'data/'+region+'.json',
    destinationFile = 'data/towns.geojson',
    boundaryFile = 'data/'+region+'-boundary.geojson',

//if there is 1 argument, it is region
//if there are 2 arguments they are region and source
//if there are 3 arguments the are region, source and destination
 args = process.argv.length
switch(args) {
    case 3:
        region = process.argv[2]
        osrmFiles = 'osrm/'+region+'.osrm'
        sourceFile = 'data/'+region+'.json'
        boundaryFile = 'data/'+region+'-boundary.geojson'
    break
    case 4:
        region = process.argv[2]
        osrmFiles = 'osrm/'+region+'.osrm'
        sourceFile = 'data/'+process.argv[3]+'.json'
        boundaryFile = 'data/'+process.argv[3]+'-boundary.geojson'
    break
    case 5:
        region = process.argv[2]
        osrmFiles = 'osrm/'+region+'.osrm'
        sourceFile = 'data/'+process.argv[3]
        boundaryFile = 'data/'+process.argv[3]+'-boundary.geojson'
        destinationFile = 'data/'+process.argv[4]
    break
}
var totalAdminAreasToProcess = 0;


Promise.all([
  //TODO: replace with json-big streams
  JSON.parse(fs.readFileSync(sourceFile,'utf8')),
  JSON.parse(fs.readFileSync(destinationFile,'utf8')),
  JSON.parse(fs.readFileSync(boundaryFile,'utf8'))
])
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
      maxTime: 14400
    };
    return createTimeMatrixTask(data, path.resolve(__dirname, osrmFiles));
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
  return timeMatrixRunner
})
.then(adminAreasData => {
  logger.group('s3').log('Storing files');
  return generateCSV(adminAreasData,region)//,
 })
 .then((adminAreasData)=>{
 return generateGeoJSON(adminAreasData,region)
 })
.then(() => {
      logger.group('s3').log('Storing files complete');  
})
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
});


// Store all the created processes.
let runningProcesses = [];

function createTimeMatrixTask (data, osrmFile) {
  return (callback) => {
    const taskLogger = logger.group(data.adminArea.properties.name);
    const beginTime = Date.now();
    let processData = {
      id: 2,
      poi: data.pois,
      gridSize: 300,
      origins: data.origins,
      osrmFile: osrmFile,
      maxTime: data.maxTime,
      maxSpeed: data.maxSpeed,
      adminArea: data.adminArea
    };
    let remainingSquares = null;
    let processError = null;

    const cETA = fork(path.resolve(__dirname, 'calculate-eta/index.js'));
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

         finish()

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
 * Generates a GeoJSON FeatureCollection from the results
 * @param   {object} data   Object with data to store
 * @return  {FeatureCollection}
 */
function generateGeoJSON (data,file) {
  // Flatten the results array
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

  let l = results.length, i = 0;
  return new Promise(function(resolve, reject) {
    const stream = fs.createWriteStream(`./export/${file}_${Date.now()}.geojson`)
    stream.write('{ "type": "FeatureCollection","features":[\n')
    for (i; i<l-1;i++) {
      let r= results[i]
      stream.write(JSON.stringify({
        type: 'Feature',
        properties: {
          id: r.id,
          name: r.name,
          pop: r.population,
          poi_town: r.poi_town
        },
        geometry: {
          type: 'Point',
          coordinates: [r.lon, r.lat]
        }
      })+',\n')
    }
    let e = results[i++]
    stream.write(JSON.stringify({
        type: 'Feature',
        properties: {
          id: e.id,
          name: e.name,
          pop: e.population,
          poi_town: e.poi_town
        },
        geometry: {
          type: 'Point',
          coordinates: [e.lon, e.lat]
        }
      })+'\n')
    stream.write(']}')
    stream.end()
    stream.on('error', (err) => reject(err))
    stream.on('finish', () => resolve(data))
  })
}



/**
 * Generates a CSV file from the results
 * @param   {object} data   Object with data to store
 * @return  {string}
 */
function generateCSV (data,file) {
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
  let fields =  Object.keys(results[0]), l = results.length, i = 0;

  return new Promise(function(resolve, reject) {
    const stream = fs.createWriteStream(`./export/${file}_${Date.now()}.csv`)

    stream.write(json2csv(results[0],{fields})+'\n')
    i++
    for (i; i<l;i++) {
        stream.write(json2csv(results[i],{field:fields,header:false})+'\n')
    }
    stream.end('this is the end')
    stream.on('error', (err) => reject(err))
    stream.on('finish', () => resolve(data))
  })
}
