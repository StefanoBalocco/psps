import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ZodType } from 'zod';
import * as zod from 'zod';
import { LogLevel, OutputType, ZeptoLogger } from '@stefanobalocco/zeptologger';
import type { Writable } from 'node:stream';
import { Backend } from './backend.js';
import type { Config, Undefinedable } from './types.js';

const defaultConfig: Config = {
	host: '127.0.0.1',
	port: 3000,
	corsOrigins: [ '*' ],
	trustedProxies: [],
	spreadsheetId: '',
	sheets: {
		accounts: 'accounts',
		admins: 'admins'
	},
	smtp: {
		host: 'localhost',
		port: 587,
		secure: false,
		user: '',
		pass: '',
		fromAddress: 'noreply@psps.invalid',
		fromName: 'PSPS'
	}
};

( async(): Promise<void> => {
	const logger: ZeptoLogger = ZeptoLogger.instance;
	logger.minLevel = LogLevel.INFO;
	logger.outputType = OutputType.TEXT;
	logger.destination = process.stdout;
	let proceed: boolean = true;

	const args: string[] = process.argv.slice( 2 );
	let configPath: string = path.resolve( process.cwd(), 'config.json' );

	const cL1: number = args.length;
	for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
		const arg: string = args[ iL1 ];
		switch( args[ iL1 ] ) {
			case '--config': {
				if( ++iL1 < cL1 ) {
					configPath = path.resolve( process.cwd(), args[ iL1 ] );
				} else {
					logger.log( LogLevel.ERROR, 'Error: --config requires a path argument.' );
					proceed = false;
				}
				break;
			}
			default: {
				logger.log( LogLevel.ERROR, `Error: Unknown flag "${ arg }".` );
				proceed = false;
			}
		}
	}

	async function openLogStream( filePath: string ): Promise<Undefinedable<fs.WriteStream>> {
		const candidate: fs.WriteStream = fs.createWriteStream( filePath, { flags: 'a' } );
		const returnValue: Undefinedable<fs.WriteStream> = await new Promise(
			( resolve: ( value: Undefinedable<fs.WriteStream> ) => void ): void => {
				candidate.once( 'open', (): void => {
					resolve( candidate );
				} );
				candidate.once( 'error', (): void => {
					candidate.destroy();
					resolve( undefined );
				} );
			}
		);
		return returnValue;
	}

	if( proceed ) {
		let logPath: string = '';
		let activeStreamRef: { current: Undefinedable<fs.WriteStream> } = { current: undefined };
		let reopening: boolean = false;

		try {
			proceed = false;
			const stat: fs.Stats = await fs.promises.stat( configPath );
			if( stat.isFile() || stat.isSymbolicLink() ) {
				const configParser: ZodType<Config> = zod.object( {
					log: zod.string().optional(),
					host: zod.string().optional().default( defaultConfig.host ),
					port: zod.number().optional().default( defaultConfig.port ),
					corsOrigins: zod.array( zod.string() ).optional().default( defaultConfig.corsOrigins ),
					trustedProxies: zod.array( zod.string() ).optional().default( defaultConfig.trustedProxies ),
					spreadsheetId: zod.string().min( 1 ),
					sheets: zod.object( {
						accounts: zod.string().optional().default( defaultConfig.sheets.accounts ),
						admins: zod.string().optional().default( defaultConfig.sheets.admins )
					} ).strict().optional().default( defaultConfig.sheets ),
					smtp: zod.object( {
						host: zod.string().optional().default( defaultConfig.smtp.host ),
						port: zod.number().optional().default( defaultConfig.smtp.port ),
						secure: zod.boolean().optional().default( defaultConfig.smtp.secure ),
						user: zod.string().optional(),
						pass: zod.string().optional(),
						fromAddress: zod.string().optional().default( defaultConfig.smtp.fromAddress ),
						fromName: zod.string().optional().default( defaultConfig.smtp.fromName )
					} ).strict().optional().default( defaultConfig.smtp )
				} ).strict();
				const config: Config = configParser.parse(
					JSON.parse(
						await fs.promises.readFile( configPath, 'utf-8' )
					)
				);
				logPath = config.log || '';

				if( logPath ) {
					const candidate: Undefinedable<fs.WriteStream> = await openLogStream( logPath );
					if( candidate ) {
						activeStreamRef.current = candidate;
						logger.destination = candidate;
						candidate.on( 'error', (): void => {
							if( candidate === activeStreamRef.current ) {
								logger.destination = process.stdout;
								activeStreamRef.current = undefined;
								logger.log( LogLevel.ERROR, 'Log file write failed; switched to stdout.' );
							}
						} );
					} else {
						console.error( 'Error: Could not open log file.' );
					}
				}

				if( logPath && activeStreamRef.current ) {
					logger.log( LogLevel.INFO, `Logging started for ${ config.host }:${ config.port }.` );
				} else {
					logger.log( LogLevel.INFO, 'Logging started on stdout.' );
				}

				process.on( 'SIGHUP', (): void => {
					if( logPath ) {
						if( reopening ) {
							logger.log( LogLevel.NOTICE, 'Log reopen already in progress.' );
						} else {
							reopening = true;
							void openLogStream( logPath ).then( ( candidate: Undefinedable<fs.WriteStream> ): void => {
								if( candidate ) {
									const oldStream: Undefinedable<Writable> = activeStreamRef.current;
									logger.destination = candidate;
									activeStreamRef.current = candidate;
									candidate.on( 'error', (): void => {
										if( candidate === activeStreamRef.current ) {
											logger.destination = process.stdout;
											activeStreamRef.current = undefined;
											logger.log( LogLevel.ERROR, 'Log file write failed; switched to stdout.' );
										}
									} );
									logger.log( LogLevel.INFO, 'Log file reopened.' );
									if( oldStream && ( oldStream instanceof fs.WriteStream ) ) {
										( oldStream as fs.WriteStream ).end();
									}
								} else {
									console.error( 'Error: Failed to reopen log file.' );
								}
								reopening = false;
							} ).catch( (): void => {
								reopening = false;
								logger.log( LogLevel.ERROR, 'Log reopen error.' );
							} );
						}
					}
				} );

				const backend: Backend = new Backend( config );
				await backend.start();
				proceed = true;
			} else {
				logger.log( LogLevel.ERROR, `Error: "${ configPath }" is not a file.` );
			}
		} catch( eL1: unknown ) {
			if( ( eL1 instanceof Error ) && ( 'code' in eL1 ) ) {
				switch( eL1.code ) {
					case 'ENOENT': {
						const parentDir: string = path.dirname( configPath );
						try {
							const parentStat: fs.Stats = await fs.promises.stat( parentDir );
							if( parentStat.isDirectory() ) {
								await fs.promises.writeFile( configPath, JSON.stringify( defaultConfig, null, '\t' ) + '\n', 'utf-8' );
								logger.log( LogLevel.INFO, `Config file created at "${ configPath }". Check it, then run again.` );
								proceed = true;
							} else {
								logger.log( LogLevel.ERROR, `Error: Parent of "${ configPath }" is not a directory.` );
							}
						} catch( eL2: unknown ) {
							if( eL2 instanceof Error ) {
								logger.log( LogLevel.ERROR, 'Config error.' );
							}
						}
						break;
					}
					default: {
						logger.log( LogLevel.ERROR, 'Config error.' );
					}
				}
			} else if( eL1 instanceof Error ) {
				logger.log( LogLevel.ERROR, 'Config error.' );
			}
		}
	}
	if( !proceed ) {
		process.exitCode = 1;
	}
} )();
