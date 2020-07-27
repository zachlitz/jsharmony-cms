/*
Copyright 2020 apHarmony

This file is part of jsHarmony.

jsHarmony is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

jsHarmony is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this package.  If not, see <http://www.gnu.org/licenses/>.
*/
const urlparser = require('url');
const Helper = require('jsharmony/Helper');
const Typo = require('typo-js');
const _ = require('lodash');
const nPath = require('path');
const fs = require('fs');
const async = require('async');
const os = require('os');

/**
 * @typedef {object} DictPaths
 * @property {string} builtInAff - the built-in affinity file for a specified language
 * @property {string} builtInDict - the built-in language dictionary file for a specified language
 * @property {string} defaultAff - the affinity file defined by the current application for a specified language
 * @property {string} defaultDict - the dictionary file defined by the current application for a specified language
 * @property {string} userDict - the dictionary file for user added words for a specified language
 */


module.exports = exports = function(module, funcs) {
  var exports = {};

  exports.spellcheck_add = function(req, res, next) {
    const verb = req.method.toLowerCase();

    if (verb != 'post') return next();
    setCors(req, res);

    const params = req.body;
    const word = params.word;
    const lang = params.lang;
    if (!_.isString(word)) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
    if (!_.isString(lang)) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }


    addWordToUserDictionary(lang, word, () => {
      sendResponse(res, {});
    });
  }

  exports.spellcheck_check = function(req, res, next) {
    const verb = req.method.toLowerCase();
    if (verb != 'post') return next();
    setCors(req, res);

    const params = req.body;
    const words = params.words;
    const lang = params.lang;
    if (!_.isArray(words)) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
    if (!_.isString(lang)) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }


    loadDictionary(lang, (err, dictionary) => {
      const result = {};
      words.forEach(word => {
        if (word in result) return;
        const isCorrect = dictionary.check(word);
        if (!isCorrect) {
          result[word] = dictionary.suggest(word);
        }
      });

      sendResponse(res, result);
    });
  }

  /**
   * Add a word to the user dictionary for the given language.
   * @param {string} lang - the language which defines the dictionary being updated.
   * @param {string} word - the word to add
   * @param {Function} cb - callback for when add is complete. arg0 is error.
   */
  function addWordToUserDictionary(lang, word, cb) {
    const customDictPath = getDictionaryPaths(lang).userDict;
    fs.appendFile(customDictPath, word + os.EOL, (err) => {
      cb(err)
    });
  }

  /**
   * Get the dictionary paths for the given language
   * @param {string} lang
   * @returns {DictPaths}
   */
  function getDictionaryPaths(lang) {
    const typoPath = nPath.join(nPath.dirname(require.resolve('typo-js/package.json')), 'dictionaries', lang);
    const dataPath =  nPath.join(module.jsh.Config.datadir, 'spellcheck');

    /** @type {DictPaths} */
    const paths = {
      builtInAff: nPath.join(typoPath, `${lang}.aff`),
      builtInDict: nPath.join(typoPath, `${lang}.dic`),
      defaultAff: nPath.join(dataPath, 'default', `${lang}.aff`),
      defaultDict: nPath.join(dataPath, 'default', `${lang}.dic`),
      userDict: nPath.join(dataPath, 'custom', `${lang}.dic`),
    }
    return paths;
  }

  /**
   * Create and load the Typo dictionary object for the given language.
   * @param {lang} lang - the dictionary/aff data  to use. Maps to physical files.
   * @param {Function} cb - a callback used when the dictionaries are loaded. Arg0 is error.
   * Arg1 is a Typo instance.
   */
  function loadDictionary(lang, cb) {

    const dictPaths = getDictionaryPaths(lang);

    // 1. First load the application default dictionary
    // 2. If the app default dictionary is empty then load the built-in
    //    dictionary.
    // 3. Load the affinity file for the dictionary that was loaded.
    // 4. Load the user dictionary.
    // 5. Combine the built-in/default dictionary with the user dictionary.
    //
    // The app default dictionary always overrides the built-in dictionary.
    async.waterfall([
      callback => loadDictFileIfExists(dictPaths.defaultDict, (err, dict) => callback(err, dict)),
      (appDict, callback) => {
        if ((appDict || '').length > 0) {
          callback(null, appDict, dictPaths.defaultAff)
        } else {
          loadDictFileIfExists(dictPaths.builtInDict, (err, builtInDict) => {
            callback(err, builtInDict, dictPaths.builtInAff);
          });
        }
      },
      (dict, affFilePath, callback) => loadDictFileIfExists(affFilePath, (err, aff) => callback(err, dict, aff)),
      (dict, aff, callback) => loadDictFileIfExists(dictPaths.userDict, (err, userDict) => callback(err, dict, aff, userDict))
    ], (err, dict, aff, userDict) => {
      dict = (dict || '') + os.EOL + (userDict || '');

      // TypoJs expects the first line to be the number of words in the dictionary
      // so it throws the line away when building the map. We need to check to see if the first line
      // is a number or not and if not then prepend a line (value doesn't matter).
      const firsLineIsNum = /^\d+\r?\n/.test(dict);
      if (!firsLineIsNum) { dict = '0' + os.EOL  + dict; }

      // Neither aff data nor dict data can be empty/length 0.
      // TypoJs expects BOTH of these to be set, otherwise it will
      // load default data which doesn't make sense in this case
      // and will result in an error if the language is not exactly
      // "en_US".
      const dictionary = err ? undefined : new Typo(lang, aff || os.EOL, dict || os.EOL);
      cb(err, dictionary);
    });
  }

  /**
   * Load the file if it exists. If it does
   * not exist then loads null.
   * @param {string} file - path to the file to load
   * @param {Function} cb - arg0 is error, arg1 is string/undefined file contents
   */
  function loadDictFileIfExists(file, cb) {
    fs.readFile(file, (err, data) => {
      if (err && err.code === 'ENOENT') { cb(null, null); }
      else if (err) { cb(err, null); }
      else { cb(null, data.toString()); }
    });
  }

  /**
   * Add CORS related headers
   * to response.
   * @param {object} req
   * @param {object} res
   */
  function setCors(req, res) {
    const referer = req.get('Referer');
    if(referer){
      const urlparts = urlparser.parse(referer, true);
      const remote_domain = urlparts.protocol + '//' + (urlparts.auth?urlparts.auth+'@':'') + urlparts.hostname + (urlparts.port?':'+urlparts.port:'');
      res.setHeader('Access-Control-Allow-Origin', remote_domain);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Origin,X-Requested-With, Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Credentials', true);
    }
  }

  /**
   * Send the response and end the request
   * @param {object} res
   * @param {object} data - the response data to send
   */
  function sendResponse(res, data) {
    res.end(JSON.stringify({
      '_success': 1,
      'result': data
    }));
  }

  return exports;
}