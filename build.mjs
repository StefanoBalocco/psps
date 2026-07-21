import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import terserCompanion from '@stefanobalocco/tersercompanion';
import ts from 'typescript';
import jTDAL from '@stefanobalocco/jtdal';

// ── Tuple manifest ────────────────────────────────────────────────────────────
// [ name, tsconfigFileName, filesToMinify[], prefix?, htmlDefinition?, copyDefinitions? ]

const buildTargets = [
	[ 'backend', 'tsconfig.json', [], 'backend' ],
	[
		'frontend',
		'tsconfig.json',
		[ 'app.js' ],
		'frontend',
		[
			'www/',
			'index.html',
			[
				[ 'style-css', 'style.css' ],
				[ 'app-min-js', 'app.min.js' ]
			]
		],
		[
			[ 'www/', [ 'style.css', 'app.min.js' ] ]
		]
	],
	[ 'tests', 'tsconfig.json', [], 'tests' ]
];

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );

function log( step, message ) {
	const stamp = new Date().toISOString().substring( 11, 19 );
	console.log( `[${ stamp }] [${ step }] ${ message }` );
}

function compileTsc( configPath ) {
	const absConfig = path.resolve( __dirname, configPath );
	const configFile = ts.readConfigFile( absConfig, ts.sys.readFile );
	if( configFile.error ) {
		throw new Error( ts.formatDiagnosticsWithColorAndContext( [ configFile.error ], {
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			getCanonicalFileName: f => f,
			getNewLine: () => '\n'
		} ) );
	}
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname( absConfig )
	);
	const program = ts.createProgram( parsed.fileNames, parsed.options );
	const emitResult = program.emit();
	const diagnostics = ts.getPreEmitDiagnostics( program ).concat( emitResult.diagnostics );
	if( 0 < diagnostics.length ) {
		const message = ts.formatDiagnosticsWithColorAndContext( diagnostics, {
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			getCanonicalFileName: f => f,
			getNewLine: () => '\n'
		} );
		throw new Error( message );
	}
}

function validateBuildTargets( targets ) {
	const cL1 = targets.length;
	for( let iL1 = 0; iL1 < cL1; iL1++ ) {
		const tuple = targets[ iL1 ];
		const errorPrefix = `Build target ${ iL1 }:`;
		if( !Array.isArray( tuple ) || 3 > tuple.length || 6 < tuple.length ) {
			throw new Error( `${ errorPrefix } must be a tuple of length 3–6` );
		}
		const [ name, configFile, filesToMinify, prefix, htmlDef, copyDef ] = tuple;
		if( 'string' !== typeof name || '' === name ) {
			throw new Error( `${ errorPrefix } name must be a non-empty string` );
		}
		if( 'string' !== typeof configFile || '' === configFile ) {
			throw new Error( `${ errorPrefix } tsconfig file must be a non-empty string` );
		}
		if( !Array.isArray( filesToMinify ) ) {
			throw new Error( `${ errorPrefix } filesToMinify must be an array` );
		}
		if( prefix && 'string' !== typeof prefix ) {
			throw new Error( `${ errorPrefix } prefix must be a string when provided` );
		}
		const cL2 = filesToMinify.length;
		for( let iL2 = 0; iL2 < cL2; iL2++ ) {
			if( 'string' !== typeof filesToMinify[ iL2 ] || !filesToMinify[ iL2 ].endsWith( '.js' ) ) {
				throw new Error( `${ errorPrefix } file '${ filesToMinify[ iL2 ] }' must end in '.js'` );
			}
		}
		if( htmlDef ) {
			if( !Array.isArray( htmlDef ) || 3 !== htmlDef.length ) {
				throw new Error( `${ errorPrefix } htmlDefinition must be a tuple of length 3` );
			}
			const [ destDir, inputHtml, mappings ] = htmlDef;
			if( 'string' !== typeof destDir || '' === destDir ) {
				throw new Error( `${ errorPrefix } htmlDefinition destination must be a non-empty string` );
			}
			if( 'string' !== typeof inputHtml || '' === inputHtml ) {
				throw new Error( `${ errorPrefix } htmlDefinition input file must be a non-empty string` );
			}
			if( !Array.isArray( mappings ) ) {
				throw new Error( `${ errorPrefix } htmlDefinition mappings must be an array` );
			}
			const cL3 = mappings.length;
			for( let iL3 = 0; iL3 < cL3; iL3++ ) {
				const mapping = mappings[ iL3 ];
				if( !Array.isArray( mapping ) || 2 !== mapping.length ) {
					throw new Error( `${ errorPrefix } htmlDefinition mapping ${ iL3 } must be a tuple of length 2` );
				}
				if( 'string' !== typeof mapping[ 0 ] || '' === mapping[ 0 ] ) {
					throw new Error( `${ errorPrefix } htmlDefinition mapping ${ iL3 } key must be a non-empty string` );
				}
				if( 'string' !== typeof mapping[ 1 ] || '' === mapping[ 1 ] ) {
					throw new Error( `${ errorPrefix } htmlDefinition mapping ${ iL3 } file must be a non-empty string` );
				}
			}
		}
		if( copyDef ) {
			if( !Array.isArray( copyDef ) ) {
				throw new Error( `${ errorPrefix } copyDefinitions must be an array` );
			}
			const cL3 = copyDef.length;
			for( let iL3 = 0; iL3 < cL3; iL3++ ) {
				const entry = copyDef[ iL3 ];
				if( !Array.isArray( entry ) || 2 !== entry.length ) {
					throw new Error( `${ errorPrefix } copyDefinition ${ iL3 } must be a tuple of length 2` );
				}
				const [ destDir, sources ] = entry;
				if( 'string' !== typeof destDir || '' === destDir ) {
					throw new Error( `${ errorPrefix } copyDefinition ${ iL3 } destination must be a non-empty string` );
				}
				if( !Array.isArray( sources ) || 0 === sources.length ) {
					throw new Error( `${ errorPrefix } copyDefinition ${ iL3 } sources must be a non-empty array` );
				}
				const cL4 = sources.length;
				for( let iL4 = 0; iL4 < cL4; iL4++ ) {
					if( 'string' !== typeof sources[ iL4 ] || '' === sources[ iL4 ] ) {
						throw new Error( `${ errorPrefix } copyDefinition ${ iL3 } source ${ iL4 } must be a non-empty string` );
					}
				}
			}
		}
	}
}

async function minifyFile( absPath ) {
	const source = await fs.readFile( absPath, 'utf8' );
	const outPath = absPath.replace( /\.js$/, '.min.js' );

	const baselineResult = await minify( source, {
		module: true,
		toplevel: true,
		compress: { defaults: true, passes: 2 },
		mangle: { properties: { regex: /^_/ } }
	} );
	const baselineCode = baselineResult.code;

	const transformed = terserCompanion( baselineCode );
	let outputCode = transformed;
	const size = [
		Buffer.byteLength( baselineCode, 'utf8' ),
		Buffer.byteLength( transformed, 'utf8' )
	];

	log( 'MINIFY', `Baseline    output size: ${size[0]}` );
	log( 'MINIFY', `Transformed output size: ${size[1]}` );

	if( size[ 1 ] < size[ 0 ] ) {
		log( 'MINIFY', `Transformed output written — ${ outPath }` );
	} else {
		outputCode = baselineCode;
		log( 'MINIFY', `Baseline output written — ${ outPath }` );
	}

	await fs.writeFile( outPath, outputCode );
}

async function runTarget( target ) {
	const [ name, configFile, filesToMinify, prefix, htmlDef, copyDef ] = target;
	const dir = path.resolve( __dirname, prefix ?? '.' );
	const absConfig = path.resolve( dir, configFile );

	log( name.toUpperCase(), 'Compiling TypeScript...' );
	compileTsc( absConfig );

	const cL1 = filesToMinify.length;
	for( let iL1 = 0; iL1 < cL1; iL1++ ) {
		const absFile = path.resolve( dir, filesToMinify[ iL1 ] );
		log( name.toUpperCase(), `Minifying ${ path.relative( __dirname, absFile ) }...` );
		await minifyFile( absFile );
	}

	if( copyDef ) {
		const cL2 = copyDef.length;
		for( let iL2 = 0; iL2 < cL2; iL2++ ) {
			const [ destDir, sources ] = copyDef[ iL2 ];
			const absDestDir = path.resolve( __dirname, destDir );
			await fs.rm( absDestDir, { recursive: true, force: true } );
			await fs.mkdir( absDestDir, { recursive: true } );
			const cL3 = sources.length;
			for( let iL3 = 0; iL3 < cL3; iL3++ ) {
				const sourceFile = sources[ iL3 ];
				const absSource = path.resolve( dir, sourceFile );
				const absDest = path.resolve( absDestDir, path.basename( sourceFile ) );
				await fs.copyFile( absSource, absDest );
			}
		}
	}

	if( htmlDef ) {
		const [ destDir, inputHtml, mappings ] = htmlDef;
		const absInputHtml = path.resolve( dir, inputHtml );
		const template = await fs.readFile( absInputHtml, 'utf-8' );
		const engine = new jTDAL();
		const render = engine.CompileToFunction( template );
		const data = {};
		const cL2 = mappings.length;
		for( let iL2 = 0; iL2 < cL2; iL2++ ) {
			const [ key, file ] = mappings[ iL2 ];
			const absFile = path.resolve( dir, file );
			data[ key ] = `${ file }?${ Math.floor( statSync( absFile ).mtimeMs ) }`;
		}
		const outputHtml = render( data );
		const absDestDir = path.resolve( __dirname, destDir );
		await fs.mkdir( absDestDir, { recursive: true } );
		await fs.writeFile( path.resolve( absDestDir, path.basename( inputHtml ) ), outputHtml, 'utf-8' );
	}

	log( name.toUpperCase(), '✓ Built.' );
}

validateBuildTargets( buildTargets );

const targetNamesAllowed = new Set(
	buildTargets.flatMap( ( [ targetName ] ) => [ targetName ] )
);
let targetNamesArgs = new Set( process.argv.slice( 2 ) );

if( targetNamesArgs.has( 'all' ) ) {
	targetNamesArgs.delete( 'all' );
	for( const targetName of targetNamesAllowed ) {
		targetNamesArgs.add( targetName );
	}
}

const targetNamesSelected = targetNamesAllowed.intersection( targetNamesArgs );
const targetNamesInvalid = targetNamesArgs.difference( targetNamesAllowed );

if( 0 < targetNamesSelected.size && 0 === targetNamesInvalid.size ) {
	async function main() {
		for( const target of buildTargets ) {
			if( targetNamesSelected.has( target[ 0 ] ) ) {
				await runTarget( target );
			}
		}
	}

	main().catch( err => {
		console.error( err );
		process.exit( 1 );
	} );
} else {
	if( 0 < targetNamesInvalid.size ) {
		console.error( 'Unknown target(s): ' + [ ...targetNamesInvalid ].join( ', ' ) );
	}
	console.log( 'Usage: node build.mjs <target> [<target> ...]' );
	console.log( 'Available targets: ' + [ ...targetNamesAllowed ].join( ', ' ) + ', all' );
	process.exitCode = 1;
}
