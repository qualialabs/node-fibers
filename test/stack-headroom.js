// PSEC-2901: V8's stack limit in a fiber must leave enough room below it for the native code
// Node runs from JS. A fiber that recurses to the limit and, while unwinding, writes strings to a
// pipe and reads a file as utf8 must get a catchable RangeError, not crash or corrupt the
// fibers whose stacks sit next to it.
//
// The work runs in a child process so a crash shows up as a signal instead of killing the test
// runner.
var path = require('path');
var Fiber = require('fibers');

if (process.argv[2] !== 'child') {
	var result = require('child_process').spawnSync(process.execPath, [__filename, 'child'], {
		env: process.env,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status === 0 && result.signal === null && /ok\n$/.test(result.stdout)) {
		console.log('pass');
	} else {
		console.log('fail\nstatus: ' + result.status + ', signal: ' + result.signal +
			'\nstderr: ' + (result.stderr || '').slice(-2000));
	}
	return;
}

var fs = require('fs');
var os = require('os');
var file = path.join(os.tmpdir(), 'fibers-stack-headroom-' + process.pid);
fs.writeFileSync(file, 'x'.repeat(256));
// Write straight to stdout's pipe handle (`StreamBase::WriteString`, a ~16.5 KB native frame) so
// that only one JS frame sits between the recursion and the native call. Going through the
// Writable stream would leave it broken the first time a RangeError lands inside it.
var handle = process.stdout._handle;
var WriteWrap = process.binding('stream_wrap').WriteWrap;
function writeString(string) {
	var req = new WriteWrap();
	req.handle = handle;
	req.oncomplete = function() {};
	req.async = false;
	handle.writeUtf8String(req, string);
}

// Compile everything the deep calls use while the stack is shallow. V8 wants ~40 KB free to
// compile a function lazily, which would otherwise keep the first calls well away from the limit
// (a busy server's write path is already compiled).
function nativeCalls() {
	writeString('a'.repeat(64));
	fs.readFileSync(file, 'utf8');
}
nativeCalls();

// Allocate the recursing fiber's stack first, then its neighbours. mmap places later stacks
// below earlier ones, so the neighbours sit just under the recursing fiber's stack.
var deep = Fiber(function() {
	Fiber.yield();
	var maxDepth = 0;
	function recurse(depth) {
		if (depth > maxDepth) {
			maxDepth = depth;
		}
		try {
			recurse(depth + 1);
		} catch (err) {}
		if (maxDepth - depth < 400) {
			try {
				nativeCalls();
			} catch (err) {}
		}
	}
	recurse(0);
});
deep.run();

var neighbours = [];
for (var ii = 0; ii < 4; ++ii) {
	var neighbour = Fiber(function(id) {
		Fiber.yield();
		var value = JSON.parse(JSON.stringify({ id: id, list: [1, 2, 3] }));
		if (value.id !== id || value.list.length !== 3) {
			throw new Error('neighbour ' + id + ' state is wrong');
		}
	});
	neighbour.run(ii);
	neighbours.push(neighbour);
}

deep.run();
neighbours.forEach(function(neighbour) { neighbour.run(); });
fs.unlinkSync(file);
fs.writeSync(1, '\nok\n');
