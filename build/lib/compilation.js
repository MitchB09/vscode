/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var gulp = require("gulp");
var tsb = require("gulp-tsb");
var es = require("event-stream");
var watch = require('./watch');
var nls = require("./nls");
var util = require("./util");
var reporter_1 = require("./reporter");
var path = require("path");
var bom = require("gulp-bom");
var sourcemaps = require("gulp-sourcemaps");
var _ = require("underscore");
var monacodts = require("../monaco/api");
var fs = require("fs");
var reporter = reporter_1.createReporter();
function getTypeScriptCompilerOptions(src) {
    var rootDir = path.join(__dirname, "../../" + src);
    var options = require("../../" + src + "/tsconfig.json").compilerOptions;
    options.verbose = false;
    options.sourceMap = true;
    if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
        options.sourceMap = false;
    }
    options.rootDir = rootDir;
    options.baseUrl = rootDir;
    options.sourceRoot = util.toFileUri(rootDir);
    options.newLine = /\r\n/.test(fs.readFileSync(__filename, 'utf8')) ? 'CRLF' : 'LF';
    return options;
}
function createCompile(src, build, emitError) {
    var opts = _.clone(getTypeScriptCompilerOptions(src));
    opts.inlineSources = !!build;
    opts.noFilesystemLookup = true;
    var ts = tsb.create(opts, true, null, function (err) { return reporter(err.toString()); });
    return function (token) {
        var utf8Filter = util.filter(function (data) { return /(\/|\\)test(\/|\\).*utf8/.test(data.path); });
        var tsFilter = util.filter(function (data) { return /\.ts$/.test(data.path); });
        var noDeclarationsFilter = util.filter(function (data) { return !(/\.d\.ts$/.test(data.path)); });
        var input = es.through();
        var output = input
            .pipe(utf8Filter)
            .pipe(bom())
            .pipe(utf8Filter.restore)
            .pipe(tsFilter)
            .pipe(util.loadSourcemaps())
            .pipe(ts(token))
            .pipe(noDeclarationsFilter)
            .pipe(build ? nls() : es.through())
            .pipe(noDeclarationsFilter.restore)
            .pipe(sourcemaps.write('.', {
            addComment: false,
            includeContent: !!build,
            sourceRoot: opts.sourceRoot
        }))
            .pipe(tsFilter.restore)
            .pipe(reporter.end(emitError));
        return es.duplex(input, output);
    };
}
var libDtsGlob = 'node_modules/typescript/lib/*.d.ts';
var atTypesDts = 'node_modules/@types/**/*.d.ts';
var excludedTypesFilter = util.filter(function (data) { return !/node_modules(\/|\\)@types(\/|\\)(node|webpack|uglify-js)(\/|\\)/.test(data.path); });
function compileTask(src, out, build) {
    return function () {
        var compile = createCompile(src, build, true);
        var srcPipe = es.merge(gulp.src(src + "/**", { base: "" + src }), gulp.src(libDtsGlob), gulp.src(atTypesDts).pipe(excludedTypesFilter));
        // Do not write .d.ts files to disk, as they are not needed there.
        var dtsFilter = util.filter(function (data) { return !/\.d\.ts$/.test(data.path); });
        return srcPipe
            .pipe(compile())
            .pipe(dtsFilter)
            .pipe(gulp.dest(out))
            .pipe(dtsFilter.restore)
            .pipe(src !== 'src' ? es.through() : monacodtsTask(out, false));
    };
}
exports.compileTask = compileTask;
function watchTask(out, build) {
    return function () {
        var compile = createCompile('src', build);
        var src = es.merge(gulp.src('src/**', { base: 'src' }), gulp.src(libDtsGlob), gulp.src(atTypesDts).pipe(excludedTypesFilter));
        var watchSrc = watch('src/**', { base: 'src' });
        // Do not write .d.ts files to disk, as they are not needed there.
        var dtsFilter = util.filter(function (data) { return !/\.d\.ts$/.test(data.path); });
        return watchSrc
            .pipe(util.incremental(compile, src, true))
            .pipe(dtsFilter)
            .pipe(gulp.dest(out))
            .pipe(dtsFilter.restore)
            .pipe(monacodtsTask(out, true));
    };
}
exports.watchTask = watchTask;
function monacodtsTask(out, isWatch) {
    var basePath = path.resolve(process.cwd(), out);
    var neededFiles = {};
    monacodts.getFilesToWatch(out).forEach(function (filePath) {
        filePath = path.normalize(filePath);
        neededFiles[filePath] = true;
    });
    var inputFiles = {};
    for (var filePath in neededFiles) {
        if (/\bsrc(\/|\\)vs\b/.test(filePath)) {
            // This file is needed from source => simply read it now
            inputFiles[filePath] = fs.readFileSync(filePath).toString();
        }
    }
    var setInputFile = function (filePath, contents) {
        if (inputFiles[filePath] === contents) {
            // no change
            return;
        }
        inputFiles[filePath] = contents;
        var neededInputFilesCount = Object.keys(neededFiles).length;
        var availableInputFilesCount = Object.keys(inputFiles).length;
        if (neededInputFilesCount === availableInputFilesCount) {
            run();
        }
    };
    var run = function () {
        var result = monacodts.run(out, inputFiles);
        if (!result.isTheSame) {
            if (isWatch) {
                fs.writeFileSync(result.filePath, result.content);
            }
            else {
                fs.writeFileSync(result.filePath, result.content);
                resultStream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
            }
        }
    };
    var resultStream;
    if (isWatch) {
        watch('build/monaco/*').pipe(es.through(function () {
            run();
        }));
    }
    resultStream = es.through(function (data) {
        var filePath = path.normalize(path.resolve(basePath, data.relative));
        if (neededFiles[filePath]) {
            setInputFile(filePath, data.contents.toString());
        }
        this.emit('data', data);
    });
    return resultStream;
}
