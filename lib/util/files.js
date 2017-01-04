(function() {
  "use strict";

  var log = require('./log');
  var glob = require('glob');
  var path = require('path');
  var nodefn = require('when/node');

  function cwdAndFiles(rootPath, relativePath, extension) {

    var absolutePath = path.join(rootPath, relativePath),
        globToTry = '**/*';

    if (extension) globToTry += '.' + extension;

    return nodefn.lift(glob)(globToTry, { cwd: absolutePath }).then(function (relPaths) {
      log.debug("Search results for " + path.join(absolutePath, globToTry), relPaths);
      return { cwd: absolutePath, files: relPaths };
    });
  }

  module.exports = {
    cwdAndFiles: cwdAndFiles
  };
})();
