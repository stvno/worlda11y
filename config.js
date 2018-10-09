'use strict';
const os = require( 'os'),
   cpus = os.cpus().length;

module.exports = {
  cpus: Math.floor(cpus * 1.5),
  debug: true
};
