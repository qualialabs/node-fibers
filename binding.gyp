{
	'target_defaults': {
		'default_configuration': 'Release',
		'configurations': {
			'Release': {
				'cflags': [ '-O3' ],
				'xcode_settings': {
					'GCC_OPTIMIZATION_LEVEL': '3',
					'GCC_GENERATE_DEBUGGING_SYMBOLS': 'NO',
				},
				'msvs_settings': {
					'VCCLCompilerTool': {
						'Optimization': 3,
						'FavorSizeOrSpeed': 1,
					},
				},
			}
		},
	},
	'targets': [
		{
			'target_name': 'fibers',
			'sources': [
				'src/fibers.cc',
				'src/coroutine.cc',
				'src/libcoro/coro.c',
				# Rebuild on header changes
				'src/coroutine.h',
				'src/libcoro/coro.h',
			],
			'cflags!': ['-ansi'],
			'conditions': [
				['OS == "win"',
					{'defines': ['CORO_FIBER', 'WINDOWS']},
				# else
					{
						'defines': ['USE_CORO', 'CORO_GUARDPAGES=1'],
						'ldflags': ['-pthread'],
					}
				],
				['OS == "linux"',
					{
						'cflags_c': [ '-std=gnu11' ],
						'defines': ['CORO_PTHREAD'],
					},
				],
				['OS == "solaris" or OS == "sunos" or OS == "freebsd" or OS == "aix"', {'defines': ['CORO_UCONTEXT']}],
				['OS == "mac"', {'defines': ['CORO_ASM']}],
				['OS == "openbsd"', {'defines': ['CORO_ASM']}],
				['target_arch == "arm"',
					{
						# There's been problems getting real fibers working on arm
						'defines': ['CORO_PTHREAD'],
						'defines!': ['CORO_UCONTEXT', 'CORO_SJLJ', 'CORO_ASM'],
					},
				],
				['target_arch == "arm64"',
					{
						# There's been problems getting real fibers working on arm
						'defines': ['CORO_UCONTEXT', '_XOPEN_SOURCE'],
						'defines!': ['CORO_PTHREAD', 'CORO_SJLJ', 'CORO_ASM'],
					},
				],
			],
		},
	],
}
