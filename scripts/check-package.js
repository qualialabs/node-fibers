#!/usr/bin/env node
// Checks an npm tarball of fibers before it's published: the source files and the prebuilt binaries
// that build.js looks for are there, each binary is a linux-x64 shared object that loads on our
// oldest glibc, and only the Node 18 binary has the await dispatch (the patched node is Node 18 only).
//
// Usage: node scripts/check-package.js fibers-<version>.tgz
// Exits 1 and lists the problems if any check fails. Doesn't need the binaries to run here.
'use strict';
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

// Module versions (Node 12, 14, 16, 18, 20, 22): the same set 5.0.5 shipped.
var MODULE_VERSIONS = ['72', '83', '93', '108', '115', '127'];
var DISPATCH_MODULE_VERSION = '108';
// Debian bullseye's glibc, which prebuild.yml builds on. A binary needing a newer one won't load there.
var MAX_GLIBC_MINOR = 31;
var REQUIRED_FILES = [
	'package.json', 'build.js', 'quick-test.js', 'binding.gyp', 'fibers.js', 'fibers_async.js',
	'fibers_sync.js', 'future.js', 'src/fibers.cc', 'src/coroutine.cc',
];
var FORBIDDEN_PREFIXES = ['build/', 'node_modules/', '.github/'];
var DISPATCH_SYMBOL = 'v8_qualia_SetMicrotaskDispatchCallback';

var tarball = process.argv[2];
if (!tarball) {
	console.error('Usage: node scripts/check-package.js fibers-<version>.tgz');
	process.exit(2);
}

var problems = [];
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibers-package-'));
cp.execFileSync('tar', ['-xzf', path.resolve(tarball), '-C', dir]);
var root = path.join(dir, 'package');
var files = cp.execFileSync('tar', ['-tzf', path.resolve(tarball)], { encoding: 'utf8' })
	.split('\n').filter(Boolean).map(function(f) { return f.replace(/^package\//, ''); });

var pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(pkg.name + '@' + pkg.version + ' (' + files.length + ' files)');
if (pkg.name !== 'fibers') {
	problems.push('package name is ' + pkg.name);
}
if (path.basename(tarball) !== 'fibers-' + pkg.version + '.tgz') {
	problems.push('tarball name ' + path.basename(tarball) + " doesn't match version " + pkg.version);
}

REQUIRED_FILES.forEach(function(f) {
	if (files.indexOf(f) === -1) {
		problems.push('missing ' + f);
	}
});
files.forEach(function(f) {
	FORBIDDEN_PREFIXES.forEach(function(prefix) {
		if (f.indexOf(prefix) === 0) {
			problems.push("shouldn't be packed: " + f);
		}
	});
});

var expectedBinaries = MODULE_VERSIONS.map(function(v) { return 'bin/linux-x64-' + v + '-glibc/fibers.node'; });
files.filter(function(f) { return /^bin\/.*\.node$/.test(f) && expectedBinaries.indexOf(f) === -1; })
	.forEach(function(f) { problems.push('unexpected binary ' + f); });

MODULE_VERSIONS.forEach(function(version) {
	var rel = 'bin/linux-x64-' + version + '-glibc/fibers.node';
	if (files.indexOf(rel) === -1) {
		problems.push('missing ' + rel);
		return;
	}
	var buf = fs.readFileSync(path.join(root, rel));
	// ELF header: magic, 64-bit, little-endian, e_type ET_DYN (3), e_machine x86-64 (0x3e).
	if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1 ||
			buf.readUInt16LE(16) !== 3 || buf.readUInt16LE(18) !== 0x3e) {
		problems.push(rel + ' is not a linux-x64 shared object');
		return;
	}
	var text = buf.toString('latin1');
	var glibc = 0;
	var re = /GLIBC_2\.(\d+)/g, m;
	while ((m = re.exec(text))) {
		glibc = Math.max(glibc, Number(m[1]));
	}
	var hasDispatch = text.indexOf(DISPATCH_SYMBOL) !== -1;
	var wantDispatch = version === DISPATCH_MODULE_VERSION;
	console.log('  ' + rel + ': ' + buf.length + ' bytes, needs glibc 2.' + glibc +
		', await dispatch ' + (hasDispatch ? 'yes' : 'no'));
	if (glibc > MAX_GLIBC_MINOR) {
		problems.push(rel + ' needs glibc 2.' + glibc + ' (max 2.' + MAX_GLIBC_MINOR + ')');
	}
	if (hasDispatch !== wantDispatch) {
		problems.push(rel + (wantDispatch ? ' is missing' : ' should not have') + ' the await dispatch');
	}
});

fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : cp.execFileSync('rm', ['-rf', dir]);

if (problems.length) {
	console.error('\n' + problems.length + ' problem(s):\n  ' + problems.join('\n  '));
	process.exit(1);
}
console.log('OK');
