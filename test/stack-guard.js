// PSEC-2901: every fiber stack must sit directly above an inaccessible (---p) region that is
// larger than the largest unprobed native frame Node can push at the limit (16,504 bytes for
// `StreamBase::WriteString`). Otherwise a native frame can run past the end of the stack into
// the neighbouring mapping without faulting.
//
// Linux only: it reads /proc/self/maps, and finds each fiber's stack through the stack pointer
// its (blocked) thread reports in /proc/self/task/<tid>/syscall. With CORO_PTHREAD every fiber
// is its own thread.
var fs = require('fs');
var Fiber = require('fibers');

var LARGEST_UNPROBED_FRAME = 16504;

if (process.platform !== 'linux') {
	console.log('pass');
	return;
}

function tids() {
	return fs.readdirSync('/proc/self/task');
}

function maps() {
	return fs.readFileSync('/proc/self/maps', 'utf8').trim().split('\n').map(function(line) {
		var parts = line.split(/\s+/);
		var range = parts[0].split('-');
		return { start: BigInt('0x' + range[0]), end: BigInt('0x' + range[1]), perms: parts[1] };
	});
}

// Stack pointer of a thread blocked in a syscall: the second-to-last field.
function stackPointer(tid) {
	var fields = fs.readFileSync('/proc/self/task/' + tid + '/syscall', 'utf8').trim().split(' ');
	if (fields.length < 3) {
		return null;
	}
	return BigInt(fields[fields.length - 2]);
}

var before = new Set(tids());
var fibers = [];
for (var ii = 0; ii < 4; ++ii) {
	var fiber = Fiber(function() { Fiber.yield(); });
	fiber.run();
	fibers.push(fiber);
}
var fiberTids = tids().filter(function(tid) { return !before.has(tid); });

var problems = [];
if (fiberTids.length < fibers.length) {
	problems.push('expected ' + fibers.length + ' new fiber threads, found ' + fiberTids.length);
}
var regions = maps();
fiberTids.forEach(function(tid) {
	var sp = stackPointer(tid);
	if (sp === null) {
		problems.push('thread ' + tid + ': not blocked, no stack pointer');
		return;
	}
	var index = regions.findIndex(function(region) { return region.start <= sp && sp < region.end; });
	if (index <= 0) {
		problems.push('thread ' + tid + ': stack pointer not in a mapping');
		return;
	}
	var stack = regions[index];
	var below = regions[index - 1];
	var where = 'stack mapping ' + stack.start.toString(16) + '-' + stack.end.toString(16) +
		' (' + ((stack.end - stack.start) / 1024n) + ' KiB)';
	if (below.end !== stack.start) {
		problems.push('thread ' + tid + ': ' + where + ' has an unmapped gap below it, not a guard');
	} else if (below.perms !== '---p') {
		problems.push('thread ' + tid + ': ' + where + ' sits directly on a ' + below.perms + ' mapping');
	} else if (below.end - below.start <= BigInt(LARGEST_UNPROBED_FRAME)) {
		problems.push('thread ' + tid + ': guard is only ' + (below.end - below.start) + ' bytes');
	}
});

fibers.forEach(function(fiber) { fiber.run(); });

if (problems.length) {
	console.log('fail\n' + problems.join('\n'));
} else {
	console.log('pass');
}
