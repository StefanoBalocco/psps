import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transporter } from 'nodemailer';
import { createTransport } from 'nodemailer';
import { request } from 'undici';
import { LogLevel, ZeptoLogger } from '@stefanobalocco/zeptologger';
import type { Config, Service, ServiceGrant, Services, Undefinedable, User } from './types.js';

export class Backend {
	private static readonly _cacheTTL: number = 5 * 60 * 1000;
	private static readonly _pinResendCooldownMilliseconds: number = 60 * 1000;
	private static readonly _messages: {
		login: string,
		pin: string
	} = {
		'login': 'If your email is authorized, you have received a code.',
		'pin': 'Invalid or expired PIN.'
	};
	private static readonly _wwwRoot: string = path.resolve(
		path.dirname( fileURLToPath( import.meta.url ) ),
		'../../www'
	);

	private static readonly _regex: {
		email: RegExp,
		pin: RegExp
	} = {
		email: /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}(\.[0-9]{1,3}){3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
		pin: /^\d{6}$/
	};

	private static _maskEmail( email: string ): string {
		let returnValue: string;
		if( Backend._regex.email.test( email ) ) {
			const atIndex: number = email.indexOf( '@' );
			const domainPart: string = email.substring( atIndex + 1 );
			const dotIndex: number = domainPart.lastIndexOf( '.' );
			const tld: string = domainPart.substring( dotIndex );
			returnValue = `${ email[ 0 ] }***@***${ tld }`;
		} else {
			returnValue = email;
		}
		return returnValue;
	}

	private static _safeError( error: unknown ): string {
		let returnValue: string;
		const errRecord: Record<string, unknown> = ( error instanceof Error ? ( error as unknown as Record<string, unknown> ) : {} );
		if( 'string' === typeof errRecord.code && errRecord.code ) {
			returnValue = errRecord.code as string;
		} else if( error instanceof Error && error.name ) {
			returnValue = error.name;
		} else {
			returnValue = 'unknown error';
		}
		return returnValue;
	}

	// ponytail: kept as private static so direct CSV regression tests catch regressions
	private static _csvParse( csv: string ): string[][] {
		const returnValue: string[][] = [];
		const csvLength: number = csv.length;

		if( 0 < csvLength ) {
			let iL1: number = 0;
			let currentRow: string[] = [];
			let currentField: string = '';
			let inQuotes: boolean = false;
			let hadFieldContent: boolean = false;

			while( iL1 < csvLength ) {
				const ch: string = csv[ iL1 ];

				if( inQuotes ) {
					if( '"' === ch ) {
						if( ( iL1 + 1 ) < csvLength && '"' === csv[ iL1 + 1 ] ) {
							currentField += '"';
							hadFieldContent = true;
							iL1++;
						} else {
							inQuotes = false;
						}
					} else {
						currentField += ch;
						hadFieldContent = true;
					}
					iL1++;
				} else {
					switch( ch ) {
						case '"': {
							inQuotes = true;
							hadFieldContent = true;
							break;
						}
						case ',': {
							currentRow.push( currentField );
							currentField = '';
							hadFieldContent = false;
							break;
						}
						case '\n': {
							currentRow.push( currentField );
							currentField = '';
							hadFieldContent = false;
							returnValue.push( currentRow );
							currentRow = [];
							break;
						}
						case '\r': {
							break;
						}
						default: {
							currentField += ch;
							hadFieldContent = true;
							break;
						}
					}
					iL1++;
				}
			}

			if( 0 < currentRow.length || '' !== currentField || hadFieldContent ) {
				currentRow.push( currentField );
				returnValue.push( currentRow );
			}
		}

		return returnValue;
	}

	private readonly _app: Hono;

	private readonly _transport: Undefinedable<Transporter>;
	private readonly _spreadsheetId: string;
	private readonly _host: string;
	private readonly _port: number;
	private readonly _configSheets: {
		accounts: string;
		admins: string;
	};
	private readonly _smtpFrom: string;
	private readonly _smtpFromName: string;
	private readonly _users: Map<string, User> = new Map();
	private readonly _logger: ZeptoLogger;
	private _cleanup: Undefinedable<NodeJS.Timeout>;
	private _servicesCache: Undefinedable<Services>;
	private _server: Undefinedable<ServerType>;

	constructor( config: Config, transportOverride?: Transporter ) {
		this._spreadsheetId = config.spreadsheetId;

		this._host = config.host;
		this._port = config.port;
		this._configSheets = {
			accounts: config.sheets.accounts,
			admins: config.sheets.admins
		};
		this._smtpFrom = config.smtp.fromAddress;
		this._smtpFromName = config.smtp.fromName;
		if( transportOverride ) {
			this._transport = transportOverride;
		} else if( config.smtp.host && config.smtp.fromAddress ) {
			const auth: Undefinedable<Record<string, string>> = ( config.smtp.user && config.smtp.pass
				? { user: config.smtp.user, pass: config.smtp.pass }
				: undefined );
			this._transport = createTransport( {
				host: config.smtp.host,
				port: config.smtp.port,
				secure: config.smtp.secure,
				auth
			} );
		} else {
			this._transport = undefined;
		}

		this._logger = ZeptoLogger.instance;

		this._app = new Hono();

		this._app.post( '/api/login', async( c: Context ): Promise<Response> => {
			let returnValue: Response;
			let bodyRaw: unknown;
			let jsonParseFailed: boolean = false;
			try {
				bodyRaw = await c.req.json();
			} catch( _err: unknown ) {
				jsonParseFailed = true;
			}
			if( jsonParseFailed ) {
				this._logger.log( LogLevel.WARNING, 'Invalid login body.' );
				returnValue = c.json( { error: 'Email required.' }, 400 );
			} else {
				if( bodyRaw && 'object' === typeof bodyRaw && !Array.isArray( bodyRaw ) ) {
					const body: Record<string, unknown> = ( bodyRaw as Record<string, unknown> );
					const rawEmail: string = ( 'string' === typeof body.email ? body.email : '' );
					const email: string = rawEmail.trim().toLowerCase();
					if( email && Backend._regex.email.test( email ) ) {
						const masked: string = Backend._maskEmail( email );
						this._logger.log( LogLevel.INFO, `Login request received: ${ masked }` );
						const now: number = Date.now();
						let user: User;
						if( this._users.has( email ) ) {
							user = this._users.get( email )!;
						} else {
							user = {
								pin: {
									value: undefined,
									expire: undefined,
									next: undefined,
									attempts: 3
								},
								login: {
									attempts: []
								}
							};
							this._users.set( email, user );
						}
						if( 'string' === typeof body.pin ) {
							this._logger.log( LogLevel.INFO, `PIN verify attempt: ${ masked }` );
							if( user.pin.attempts && user.pin.expire && ( now < user.pin.expire ) ) {
								const pin: number = Backend._regex.pin.test( body.pin.trim() ) ? Number( body.pin.trim() ) : NaN;
								if( !isNaN( pin ) ) {
									if( pin === user.pin.value ) {
										this._logger.log( LogLevel.INFO, `PIN verified: ${ masked }` );
										user.pin.expire = now;
										try {
											const services: Service[] = ( await this._getServices() ).data.filter(
												( item: ServiceGrant ): boolean => item.grants.includes( email )
											).map(
												( item: ServiceGrant ): Service => {
													return {
														service: item.service,
														username: item.username,
														password: item.password,
														link: item.link
													};
												}
											);
											returnValue = c.json( { accounts: services } );
										} catch( error: unknown ) {
											this._logger.log( LogLevel.ERROR, `Services fetch failed for ${ masked } (${ Backend._safeError( error ) })` );
											returnValue = c.json( { error: Backend._messages.pin, reset: true }, 401 );
										}
									} else {
										returnValue = this._wrongPin( c, user, masked );
									}
								} else {
									returnValue = this._wrongPin( c, user, masked );
								}
							} else {
								this._logger.log( LogLevel.INFO, `PIN expired: ${ masked }` );
								user.pin.value = undefined;
								user.pin.expire = undefined;
								returnValue = c.json( { error: Backend._messages.pin, reset: true }, 401 );
							}
						} else {
							user.login.attempts = user.login.attempts.filter(
								( attempt: number ): boolean => now < ( attempt + Backend._cacheTTL )
							);
							if( 3 > user.login.attempts.length ) {
								user.login.attempts.push( now );
								if( ( undefined !== user.pin.value ) && user.pin.expire && ( now < user.pin.expire ) ) {
									if( user.pin.next ) {
										if( now >= user.pin.next ) {
											this._logger.log( LogLevel.INFO, `PIN reused: ${ masked }` );
											user.pin.next = now + Backend._pinResendCooldownMilliseconds;
											try {
												await this._sendPin( email, user.pin.value );
											} catch( error: unknown ) {
												this._logger.log( LogLevel.ERROR, `PIN resend failed: ${ masked } (${ Backend._safeError( error ) })` );
											}
										} else {
											this._logger.log( LogLevel.INFO, `PIN cooldown: ${ masked }` );
										}
									}
									returnValue = c.json( {
										message: Backend._messages.login,
										next: user.pin.next
									} );
								} else {
									try {
										const services: Services = await this._getServices();
										const isAuthorized: boolean = services.data.some(
											( service: ServiceGrant ): boolean => service.grants.includes( email )
										);
										this._logger.log( LogLevel.INFO, `Login authorization decision for ${ masked }: ${ String( isAuthorized ) }` );
										if( isAuthorized ) {
											this._logger.log( LogLevel.INFO, `PIN generated: ${ masked }` );
											const pin: number = crypto.randomInt( 1000000 );
											user.pin = {
												value: pin,
												next: now + Backend._pinResendCooldownMilliseconds,
												expire: now + Backend._cacheTTL,
												attempts: 3
											};
											await this._sendPin( email, pin );
										}
									} catch( error: unknown ) {
										this._logger.log( LogLevel.ERROR, `Login request failed: ${ masked } (${ Backend._safeError( error ) })` );
									}
								}
								returnValue = c.json( {
									message: Backend._messages.login,
									next: ( undefined !== user.pin.next ? user.pin.next : ( now + Backend._pinResendCooldownMilliseconds ) )
								} );
							} else {
								this._logger.log( LogLevel.INFO, `Rate limited: ${ masked }` );
								returnValue = c.json( {
									message: Backend._messages.login,
									next: now + Backend._cacheTTL
								} );
							}
						}
					} else {
						this._logger.log( LogLevel.WARNING, `malformed email: ${ rawEmail }` );
						returnValue = c.json( { error: 'Email required.' }, 400 );
					}
				} else {
					this._logger.log( LogLevel.WARNING, 'malformed email: ' );
					returnValue = c.json( { error: 'Email required.' }, 400 );
				}
			}
			return returnValue;
		} );

		this._app.get( '/*', serveStatic( {
			root: Backend._wwwRoot,
			rewriteRequestPath: ( requestPath: string ): string => {
				let returnValue: string = requestPath;
				if( '/' === requestPath ) {
					returnValue = '/index.html';
				}
				return returnValue;
			}
		} ) );
	}

	public async start(): Promise<void> {
		// Start cleanup interval
		this._cleanup = setInterval(
			(): void => {
				const now: number = Date.now();
				this._users.forEach(
					( item: User ): void => {
						if( item.pin.expire && ( now >= item.pin.expire ) ) {
							item.pin = {
								value: undefined,
								next: undefined,
								expire: undefined,
								attempts: 3
							};
						}
					}
				);
			},
			3600000
		);
		this._cleanup.unref();

		// Start server
		this._server = serve(
			{
				fetch: this._app.fetch,
				hostname: this._host,
				port: this._port
			},
			( info: { address: string; port: number; family: string } ): void => {
				console.log( `PSPS backend listening on ${ info.address }:${ info.port }` );
			}
		);
	}

	public stop(): Promise<void> {
		let returnValue: Promise<void>;
		if( this._cleanup ) {
			this._cleanup.close();
			this._cleanup = undefined;
		}
		if( this._server ) {
			returnValue = new Promise( ( resolve: ( value: void ) => void ): void => {
				this._server!.close( (): void => {
					this._server = undefined;
					resolve();
				} );
			} );
		} else {
			returnValue = Promise.resolve();
		}
		return returnValue;
	}

	private _wrongPin( c: Context, user: User, masked: string ): Response {
		let returnValue: Response;
		if( --user.pin.attempts ) {
			this._logger.log( LogLevel.INFO, `PIN wrong: ${ masked }, attempts remaining: ${ user.pin.attempts }` );
			returnValue = c.json( { error: Backend._messages.pin }, 401 );
		} else {
			this._logger.log( LogLevel.INFO, `PIN exhausted: ${ masked }` );
			user.pin.value = undefined;
			user.pin.expire = undefined;
			returnValue = c.json( { error: Backend._messages.pin, reset: true }, 401 );
		}
		return returnValue;
	}

	private async _sendPin( email: string, pin: number ): Promise<void> {
		const masked: string = Backend._maskEmail( email );
		if( this._transport ) {
			try {
				await this._transport.sendMail( {
					from: `"${ this._smtpFromName }" <${ this._smtpFrom }>`,
					to: email,
					subject: 'Your PSPS PIN',
					text: `Your PSPS PIN is ${ String( pin ).padStart( 6, '0' ) }. It will expire in 5 minutes.`
				} );
				this._logger.log( LogLevel.INFO, `PIN delivery queued: ${ masked }` );
			} catch( err: unknown ) {
				let safeSmtpError: string;
				const errRecord: Record<string, unknown> = ( err instanceof Error ? ( err as unknown as Record<string, unknown> ) : {} );
				const code: unknown = errRecord.code;
				const codeStr: string = ( 'string' === typeof code && /^[A-Z0-9_ -]{1,30}$/.test( code ) ) ? code : '';
				const knownCodes: Record<string, string> = {
					'EAUTH': 'SMTP authentication failed',
					'ESOCKET': 'SMTP socket error',
					'ECONNECTION': 'SMTP connection failed',
					'ETIMEDOUT': 'SMTP connection timed out',
					'ENOTFOUND': 'SMTP host not found',
					'EDNS': 'SMTP host not found',
					'ECONNREFUSED': 'SMTP connection refused',
					'ECONNRESET': 'SMTP connection reset',
					'EPIPE': 'SMTP connection closed',
					'EPROTOCOL': 'SMTP protocol error',
					'EENVELOPE': 'SMTP envelope rejected',
					'ESTREAM': 'SMTP stream error'
				};
				if( codeStr && Object.hasOwn( knownCodes, codeStr ) ) {
					const parts: string[] = [ `${ codeStr }: ${ knownCodes[ codeStr ] }` ];
					const responseCode: unknown = errRecord.responseCode;
					if( 'number' === typeof responseCode && isFinite( responseCode ) && 100 <= responseCode && 599 >= responseCode ) {
						parts.push( `responseCode=${ responseCode }` );
					}
					const command: unknown = errRecord.command;
					// ponytail: exact allowlist, no regex for command filtering
					const allowedCommands: Set<string> = new Set( [ 'AUTH LOGIN', 'AUTH PLAIN', 'EHLO', 'HELO', 'STARTTLS', 'MAIL FROM', 'RCPT TO', 'DATA', 'CONN' ] );
					const commandStr: string = ( 'string' === typeof command && allowedCommands.has( command ) ) ? command : '';
					if( commandStr ) {
						parts.push( `command=${ commandStr }` );
					}
					const errno: unknown = errRecord.errno;
					if( 'number' === typeof errno && isFinite( errno ) ) {
						parts.push( `errno=${ errno }` );
					}
					if( 'ESOCKET' === codeStr || 'ECONNECTION' === codeStr ) {
						const msg: unknown = errRecord.message;
						const msgStr: string = ( 'string' === typeof msg ) ? msg : '';
						let causeLabel: string = '';
						// ponytail: only already-approved tokens scanned from message, never emit content
						if( /\bECONNREFUSED\b/.test( msgStr ) ) {
							causeLabel = 'connection-refused';
						} else if( /\bETIMEDOUT\b/.test( msgStr ) ) {
							causeLabel = 'timeout';
						} else if( /\bENOTFOUND\b/.test( msgStr ) ) {
							causeLabel = 'dns-not-found';
						} else if( /\bECONNRESET\b/.test( msgStr ) ) {
							causeLabel = 'connection-reset';
						} else if( /\bEPIPE\b/.test( msgStr ) ) {
							causeLabel = 'broken-pipe';
						} else if( /\bEHOSTUNREACH\b/.test( msgStr ) ) {
							causeLabel = 'host-unreachable';
						} else if( /\bENETUNREACH\b/.test( msgStr ) ) {
							causeLabel = 'network-unreachable';
						} else if( /\b(tls|ssl|certificate|handshake|self\s+signed)\b/i.test( msgStr ) ) {
							causeLabel = 'tls';
						}
						if( causeLabel ) {
							parts.push( `cause=${ causeLabel }` );
						}
					}
					safeSmtpError = parts.join( '; ' );
				} else {
					safeSmtpError = 'SMTP delivery error';
				}
				this._logger.log( LogLevel.ERROR, `PIN delivery failed: ${ masked } (${ safeSmtpError })` );
			}
		} else {
			this._logger.log( LogLevel.WARNING, `No SMTP transport, PIN not sent: ${ masked }` );
		}
	}

	private async _fetchSheetCsv( sheetName: string ): Promise<string[][]> {
		let returnValue: string[][] = [];
		const url: string = `https://docs.google.com/spreadsheets/d/${ this._spreadsheetId }/gviz/tq?tqx=out:csv&sheet=${ encodeURIComponent( sheetName ) }`;
		const response: Awaited<ReturnType<typeof request>> = await request( url );
		const text: string = await response.body.text();
		if( 200 <= response.statusCode && 300 > response.statusCode ) {
			returnValue = Backend._csvParse( text );
		} else {
			throw new Error( `Failed to read sheet: HTTP ${ response.statusCode }` );
		}
		return returnValue;
	}

	private async _getServices(): Promise<Services> {
		if( !this._servicesCache || Date.now() > this._servicesCache.expires ) {
			const sheets: [ string[][], string[][] ] = await Promise.all( [
				this._fetchSheetCsv( this._configSheets.accounts ),
				this._fetchSheetCsv( this._configSheets.admins )
			] );

			const admins: string[] = sheets[ 1 ].slice( 1 ).map(
				( row: string[] ): string => ( row[ 0 ] || '' ).trim().toLowerCase()
			).filter(
				( item: string ): string => item
			);

			const data: ServiceGrant[] = [];
			const cL1: number = sheets[ 0 ].length;
			for( let iL1: number = 1; iL1 < cL1; iL1++ ) {
				const row: string[] = sheets[ 0 ][ iL1 ];
				const item: Service = {
					service: ( row[ 0 ] || '' ).trim(),
					username: ( row[ 1 ] || '' ).trim(),
					password: ( row[ 2 ] || '' ).trim(),
					link: ( row[ 3 ] || '' ).trim()
				};
				if( item.service || item.username || item.password || item.link ) {
					const sharing: Set<string> = new Set(
						[
							...( row[ 4 ] || '' ).split( /[\s,;]+/ ).map(
								( element: string ): string => element.trim().toLowerCase()
							),
							...admins
						].filter(
							( item: string ): string => item
						)
					);
					data.push( {
						service: item.service,
						username: item.username,
						password: item.password,
						link: item.link,
						grants: Array.from( sharing )
					} );
				}
			}

			this._servicesCache = {
				expires: Date.now() + Backend._cacheTTL,
				data: data
			};
		}
		return this._servicesCache;
	}
}
