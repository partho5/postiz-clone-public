// Test environment for the frontend specs that need a DOM: jest-environment-jsdom, with the optional
// native `canvas` package treated as absent (jsdom requires it whenever it resolves, and it is not built here).
const Module = require('module');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'canvas') {
    const error = new Error("Cannot find module 'canvas'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return resolveFilename.call(this, request, ...rest);
};

module.exports = require('jest-environment-jsdom');
