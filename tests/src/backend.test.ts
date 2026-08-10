import test from 'ava';
import type { ExecutionContext } from 'ava';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import * as nodemailer from 'nodemailer';
import { ZeptoLogger } from '@stefanobalocco/zeptologger';
import type { Hono } from 'hono';
import type { Dispatcher } from 'undici';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { Backend } from '../../backend/dist/backend.js';
import type { Config, Nullable } from '../../backend/dist/types.js';

// Global backend tracker for cleanup
const _backends: Backend[] = [];

test.after.always( 'cleanup backends', async () => {
	for( const backend of _backends ) {
		await backend.stop();
	}
} );

const __filename: string = fileURLToPath( import.meta.url );
const __dirname: string = path.dirname( __filename );

// ---------------------------------------------------------------------------
// Local type aliases
// ---------------------------------------------------------------------------

type _FakeNow = {
	get: () => number;
	set: ( value: number ) => void;
	advance: ( delta: number ) => void;
};

type _MockScope = {
	delay: ( waitInMs: number ) => _MockScope;
	persist: () => _MockScope;
	times: ( repeatTimes: number ) => _MockScope;
};

// ---------------------------------------------------------------------------
// Private-access helpers for Backend encapsulation
// ---------------------------------------------------------------------------

type BackendWithApp = { _app: Hono };

function _backendRequest( backend: Backend, path: string, init?: RequestInit ): Promise<Response> {
	return Promise.resolve( ( backend as unknown as BackendWithApp )._app.request( path, init ) );
}

function _captureLoggerOutput( t: ExecutionContext ): PassThrough {
	const logger: ZeptoLogger = ZeptoLogger.instance;
	const stream: PassThrough = new PassThrough();
	logger.destination = stream;
	t.teardown( (): void => {
		logger.destination = process.stdout;
	} );
	return stream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectRoot(): string {
	return path.resolve( __dirname, '../..' );
}

function makeValidConfig(): Record<string, unknown> {
	return {
		host: '127.0.0.1',
		port: 0,
		spreadsheetId: 'abc123',
		smtp: {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'user',
			pass: 'pass',
			fromAddress: 'noreply@example.com',
			fromName: 'PSPS',
		},
	};
}

function writeTempConfig( data: Record<string, unknown> ): string {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-config-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	_tmpDirs.push( tmpDir );
	const configPath: string = path.join( tmpDir, 'config.json' );
	const config: Record<string, unknown> = {
		host: '127.0.0.1',
		port: 0,
		corsOrigins: [ '*' ],
		trustedProxies: [],
		spreadsheetId: 'abc123',
		sheets: {
			accounts: 'accounts',
			admins: 'admins'
		},
		smtp: {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'user',
			pass: 'pass',
			fromAddress: 'noreply@example.com',
			fromName: 'PSPS',
		},
		...data,
	};
	fs.writeFileSync( configPath, JSON.stringify( config, null, '\t' ), 'utf-8' );
	return configPath;
}

function runIndexJs( configPath: string, timeoutMs: number = 5000 ): Promise<{ stdout: string; stderr: string; code: Nullable<number>; timedOut: boolean; listened: boolean }> {
	return new Promise( ( resolve, reject ) => {
		const proc: ChildProcessByStdio<null, Readable, Readable> = spawn( 'node', [ 'backend/dist/index.js', '--config', configPath ], {
			cwd: projectRoot(),
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );

		let stdout: string = '';
		let stderr: string = '';
		let listened: boolean = false;
		let timedOut: boolean = false;

		proc.stdout.on( 'data', ( data: Buffer ) => {
			stdout += data.toString();
			if( !listened && -1 !== stdout.indexOf( 'PSPS backend listening' ) ) {
				listened = true;
			}
		} );

		proc.stderr.on( 'data', ( data: Buffer ) => {
			stderr += data.toString();
		} );

		const timer: NodeJS.Timeout = setTimeout( () => {
			timedOut = true;
			proc.kill();
		}, timeoutMs );

		proc.on( 'error', ( err: Error ) => {
			clearTimeout( timer );
			reject( err );
		} );

		proc.on( 'close', ( code: Nullable<number> ) => {
			clearTimeout( timer );
			resolve( { stdout, stderr, code, timedOut, listened } );
		} );
	} );
}

// ---------------------------------------------------------------------------
// Shared helpers for child-process lifecycle
// ---------------------------------------------------------------------------

function terminateChild( proc: ChildProcess ): Promise<void> {
	return new Promise( ( resolve: ( value: void ) => void ) => {
		if( null !== proc.exitCode || null !== proc.signalCode ) {
			resolve();
		} else {
			const onClose: () => void = (): void => {
				resolve();
			};
			proc.on( 'close', onClose );
			if( !proc.kill() ) {
				proc.off( 'close', onClose );
				resolve();
			}
		}
	} );
}

interface TrackState {
	seenListening: boolean;
	childFailed: string;
	unexpectedTerminalEvent: string;
	stdout: string;
	stderr: string;
}

function trackReadiness( proc: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number = 5000 ): { ready: Promise<void>; state: TrackState } {
	const state: TrackState = {
		seenListening: false,
		childFailed: '',
		unexpectedTerminalEvent: '',
		stdout: '',
		stderr: '',
	};

	const ready: Promise<void> = new Promise( ( resolve: ( value: void ) => void ) => {
		// ponytail: ChildProcessByStdio guarantees piped stdout/stderr are non-null
		const timer: NodeJS.Timeout = setTimeout( () => {
			if( !state.seenListening && !state.childFailed ) {
				state.childFailed = 'Backend must start';
				resolve();
			}
		}, timeoutMs );

		proc.stdout.on( 'data', ( data: Buffer ) => {
			state.stdout += data.toString();
			if( !state.seenListening && -1 !== state.stdout.indexOf( 'PSPS backend listening' ) ) {
				state.seenListening = true;
				clearTimeout( timer );
				resolve();
			}
		} );

		proc.on( 'error', ( err: Error ) => {
			if( !state.seenListening ) {
				state.childFailed = `Child process error: ${ err.message }`;
				clearTimeout( timer );
				resolve();
			} else {
				state.unexpectedTerminalEvent = `Child process error: ${ err.message }`;
			}
		} );

		proc.on( 'close', ( code: Nullable<number> ) => {
			if( !state.seenListening ) {
				state.childFailed = `Child exited before readiness with code: ${ null !== code ? String( code ) : '<signal>' }`;
				clearTimeout( timer );
				resolve();
			} else {
				state.unexpectedTerminalEvent = `Child exited before expected shutdown with code: ${ null !== code ? String( code ) : '<signal>' }`;
			}
		} );

		proc.stderr.on( 'data', ( data: Buffer ) => {
			state.stderr += data.toString();
		} );
	} );

	return { ready, state };
}

// ---------------------------------------------------------------------------
// Helpers for email tests
// ---------------------------------------------------------------------------

interface SentMail {
	to: string;
	subject: string;
	text: string;
}

function createFakeTransport(): { transport: nodemailer.Transporter; sentMails: SentMail[] } {
	const sentMails: SentMail[] = [];
	const transport: nodemailer.Transporter = {
		sendMail: async ( mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			sentMails.push( {
				to: mailOptions.to as string,
				subject: mailOptions.subject as string,
				text: mailOptions.text as string,
			} );
			return Promise.resolve( { messageId: 'fake' } );
		},
	} as nodemailer.Transporter;
	return { transport, sentMails };
}

	function makeConfig( overrides: Partial<Config> = {} ): Config {
	const defaultCfg: Config = {
		host: '127.0.0.1',
		port: 0,
		corsOrigins: [ '*' ],
		trustedProxies: [],
		spreadsheetId: 'test123',
		sheets: {
			accounts: 'accounts',
			admins: 'admins'
		},
		smtp: {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: '',
			pass: '',
			fromAddress: 'test@test.com',
			fromName: 'Test',
		},
	};
	return { ...defaultCfg, ...overrides };
}

// Track tmp dirs for cleanup
const _tmpDirs: string[] = [];

test.after.always( 'cleanup tmp dirs', () => {
	for( const dir of _tmpDirs ) {
		try {
			fs.rmSync( dir, { recursive: true, force: true } );
		} catch( _err: unknown ) {
			// ignore
		}
	}
} );

// ---------------------------------------------------------------------------
// Config validation and auto-create (process execution)
// ---------------------------------------------------------------------------

test( 'valid config: process starts server and exits on signal', async ( t ) => {
	const configPath: string = writeTempConfig( makeValidConfig() );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.true( result.timedOut || ( null !== result.code && 0 === result.code ),
		'Server must start without error (timed out = started)' );
	t.true( result.listened, 'Server must have logged listening' );
	t.true( -1 !== result.stdout.indexOf( 'PSPS backend listening' ),
		'Stdout must contain listening message after shutdown' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: empty spreadsheetId exits with error', async ( t ) => {
	const configPath: string = writeTempConfig( { spreadsheetId: '' } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: stale spreadsheetURL is rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { spreadsheetURL: 'https://docs.google.com/spreadsheets/d/abc123/edit' } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: stale cacheTtlSeconds is rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { cacheTtlSeconds: 30 } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: stale pinTtlSeconds is rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { pinTtlSeconds: 300 } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: stale pinMaxAttempts is rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { pinMaxAttempts: 3 } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'invalid config: stale old PascalCase keys are rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { SpreadsheetURL: 'https://example.com', ServiceKEY: 'key.json', MaxRecipients: 50, sessionTtlSeconds: 3600 } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'config file creation: missing file creates and exits 0', ( t ) => {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-create-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	const configPath: string = path.join( tmpDir, 'config.json' );

	t.false( fs.existsSync( configPath ) );

	const result: Buffer = execFileSync( 'node', [
		'backend/dist/index.js',
		'--config', configPath,
	], { cwd: projectRoot() } );

	t.true( result.toString().includes( 'Config file created' ) );
	t.true( fs.existsSync( configPath ) );

	const created: Record<string, unknown> = JSON.parse( fs.readFileSync( configPath, 'utf-8' ) );
	t.true( 'string' === typeof created.spreadsheetId );

	fs.rmSync( tmpDir, { recursive: true, force: true } );
} );

test( 'config file creation: parent missing fails', ( t ) => {
	const nonexistentDir: string = path.resolve( projectRoot(), 'tests', `.runtime-nonexistent-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	const configPath: string = path.join( nonexistentDir, 'config.json' );

	t.throws( () => {
		execFileSync( 'node', [
			'backend/dist/index.js',
			'--config', configPath,
		], {
			cwd: projectRoot(),
			encoding: 'utf-8',
		} );
	}, { message: /non-zero|exit|failed/i } );
} );

test( 'CLI: --config without path argument exits with error', ( t ) => {
	t.throws( () => {
		execFileSync( 'node', [
			'backend/dist/index.js',
			'--config',
		], {
			cwd: projectRoot(),
			encoding: 'utf-8',
		} );
	}, { message: /non-zero|exit|failed/i } );
} );

test( 'CLI: unknown flag exits with error', ( t ) => {
	t.throws( () => {
		execFileSync( 'node', [
			'backend/dist/index.js',
			'--unknown-flag',
		], {
			cwd: projectRoot(),
			encoding: 'utf-8',
		} );
	}, { message: /non-zero|exit|failed/i } );
} );

test( 'CLI: config path is a directory exits with error', ( t ) => {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-dirs-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	t.throws( () => {
		execFileSync( 'node', [
			'backend/dist/index.js',
			'--config', tmpDir,
		], {
			cwd: projectRoot(),
			encoding: 'utf-8',
		} );
	}, { message: /non-zero|exit|failed/i } );
	fs.rmSync( tmpDir, { recursive: true, force: true } );
} );

test( 'CLI: config parent is a file (not a directory) exits with error', ( t ) => {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-parent-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	const filePath: string = path.join( tmpDir, 'afile' );
	fs.writeFileSync( filePath, 'not a directory', 'utf-8' );
	const configPath: string = path.join( filePath, 'config.json' );
	t.throws( () => {
		execFileSync( 'node', [
			'backend/dist/index.js',
			'--config', configPath,
		], {
			cwd: projectRoot(),
			encoding: 'utf-8',
		} );
	}, { message: /non-zero|exit|failed/i } );
	fs.rmSync( tmpDir, { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Backend logger integration
// ---------------------------------------------------------------------------

test.serial( 'login with logger logs masked email events', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );

	t.true( -1 !== output.indexOf( 'Login request received: a***@***.com' ),
		'Log output must contain masked email in login request received message' );
	t.false( -1 !== output.indexOf( 'admin@test.com' ),
		'Log output must NOT contain unmasked email' );
} );

test.serial( 'login logger does not leak full email, pin, or raw errors', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// First request triggers PIN generation
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.false( -1 !== output.indexOf( 'user@test.com' ),
		'Log output must not contain the full email' );
	t.false( ( /\b\d{6}\b/ ).test( output ),
		'Log output must not contain a 6-digit PIN' );
} );

// ---------------------------------------------------------------------------
// MockAgent helpers
// ---------------------------------------------------------------------------

function csvFromRows( rows: string[][] ): string {
	const escapedRows: string[] = rows.map( ( row: string[] ): string => row.map( ( cell: string ): string => {
		let returnValue: string = cell;
		if( /[",\n\r]/.test( cell ) ) {
			returnValue = `"${ cell.replace( /"/g, '""' ) }"`;
		}
		return returnValue;
	} ).join( ',' ) );
	return escapedRows.join( '\n' );
}

function installMockSheets( t: ExecutionContext, accountsData: string[][], adminData: string[][], persist: boolean = true ): MockAgent {
	const originalDispatcher: Dispatcher = getGlobalDispatcher();
	const mockAgent: MockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	const pool: ReturnType<MockAgent['get']> = mockAgent.get( 'https://docs.google.com' );
	const accountsScope: _MockScope = pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=accounts/ } ).reply( 200, csvFromRows( accountsData ), { headers: { 'Content-Type': 'text/csv' } } );
	const adminsScope: _MockScope = pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=admins/ } ).reply( 200, csvFromRows( adminData ), { headers: { 'Content-Type': 'text/csv' } } );
	if( persist ) {
		accountsScope.persist();
		adminsScope.persist();
	}
	setGlobalDispatcher( mockAgent );
	t.teardown( async(): Promise<void> => {
		setGlobalDispatcher( originalDispatcher );
		await mockAgent.close();
	} );
	return mockAgent;
}

function createTestBackend( transport: nodemailer.Transporter ): Backend {
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );
	return backend;
}

function withFakeNow( t: ExecutionContext, initialNow: number ): { get: () => number; set: ( value: number ) => void; advance: ( delta: number ) => void } {
	const originalNow: () => number = Date.now;
	let currentNow: number = initialNow;
	Date.now = (): number => currentNow;
	t.teardown( (): void => {
		Date.now = originalNow;
	} );
	return {
		get: (): number => currentNow,
		set: ( value: number ): void => { currentNow = value; },
		advance: ( delta: number ): void => { currentNow += delta; }
	};
}

// ---------------------------------------------------------------------------
// POST /api/login - request (email only) tests
// ---------------------------------------------------------------------------

test.serial( 'POST /api/login: authorized email sends one email and returns generic OK', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'Service1', 'u1', 'p1', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;

	t.is( res.status, 200 );
	t.true( ( body.message as string ).includes( 'authorized' ) );
	t.is( sentMails.length, 1 );
	t.is( sentMails[ 0 ].to, 'admin@test.com' );
} );

test.serial( 'POST /api/login: unauthorized email returns generic OK and sends no email', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'unknown@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;

	t.is( res.status, 200 );
	t.true( ( body.message as string ).includes( 'authorized' ) );
	t.is( sentMails.length, 0 );
} );

test.serial( 'POST /api/login: authorized email-only includes numeric next', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'authorized@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'authorized@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;

	t.is( res.status, 200 );
	t.true( 'number' === typeof body.next && isFinite( body.next as number ),
		'Authorized email-only must return numeric next' );
	const expectedNext: number = 1_700_000_000_000 + 60_000;
	t.is( body.next as number, expectedNext,
		'Authorized initial email-only must return now + pinResendCooldown as next' );
} );

test.serial( 'POST /api/login: unauthorized email-only includes numeric next (anti-enumeration)', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'unauthorized@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;

	t.is( res.status, 200 );
	t.true( ( body.message as string ).includes( 'authorized' ) );
	t.true( 'number' === typeof body.next && isFinite( body.next as number ),
		'Unauthorized email-only must return numeric next (same shape as authorized)' );
	const expectedNext: number = 1_700_000_000_000 + 60_000;
	t.is( body.next as number, expectedNext,
		'Unauthorized initial email-only must return now + pinResendCooldown as next' );
	t.is( sentMails.length, 0, 'Unauthorized must not send any email' );
} );

test.serial( 'POST /api/login: unauthorized second email-only returns generic cooldown next', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// First request
	const res1: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'unauth@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body1: Record<string, unknown> = await res1.json() as Record<string, unknown>;
	t.is( res1.status, 200 );
	t.true( 'number' === typeof body1.next, 'First unauthorized must have numeric next' );
	t.is( sentMails.length, 0, 'First unauthorized must not send email' );

	// Second request — not advancing time, so within generic cooldown
	const res2: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'unauth@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body2: Record<string, unknown> = await res2.json() as Record<string, unknown>;
	t.is( res2.status, 200 );
	t.true( 'number' === typeof body2.next, 'Second unauthorized must have numeric next' );
	t.is( sentMails.length, 0, 'Second unauthorized must not send email' );
} );

test.serial( 'POST /api/login: authorized rate-limited retains cache-TTL next', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// Make 3+ requests to trigger rate limiting (3 per cacheTTL window)
	for( let iL1: number = 0; iL1 < 6; iL1++ ) {
		await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email: 'ratelimited@test.com' } ),
			headers: { 'Content-Type': 'application/json' },
		} );
		now.advance( 100 );
	}

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'ratelimited@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	t.is( res.status, 200 );
	t.true( 'number' === typeof body.next, 'Rate-limited response must have numeric next' );
	const expectedNext: number = 1_700_000_000_600 + 5 * 60 * 1000; // last access + cacheTTL
	t.is( body.next as number, expectedNext,
		'Rate-limited must return now + cacheTTL as next' );
} );

test.serial( 'POST /api/login: missing email returns 400', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( {} ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 400 );
} );

test.serial( 'POST /api/login: malformed JSON body returns 400 with generic error and safe log', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Send truly malformed JSON (not valid JSON) with correct Content-Type
	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: '{ invalid json here }',
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 400 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	t.is( body.error as string, 'Email required.' );

	// Log must contain only the safe fixed message
	t.true( -1 !== output.indexOf( 'Invalid login body.' ),
		'Malformed JSON must log Invalid login body.' );
	t.false( ( /SyntaxError|Unexpected token|parse error/i ).test( output ),
		'Log must NOT contain parser details' );
} );

// ---------------------------------------------------------------------------
// POST /api/login - verify (email + PIN) tests
// ---------------------------------------------------------------------------

test.serial( 'POST /api/login: correct PIN returns accounts and consumes the PIN', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'Service1', 'u1', 'p1', 'https://s1.example.com', 'user@test.com; admin@test.com' ],
		  [ 'Service2', 'u2', 'p2', '', 'other@test.com; admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const verifyRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( verifyRes.status, 200 );
	const verifyBody: Record<string, unknown> = await verifyRes.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = verifyBody.accounts as Record<string, unknown>[];
	t.is( accounts.length, 2 );
	t.is( accounts[ 0 ].service as string, 'Service1' );
	t.is( accounts[ 1 ].service as string, 'Service2' );
	// No role, no spreadsheetUrl
	t.false( Object.hasOwn( verifyBody, 'role' ) );
	t.false( Object.hasOwn( verifyBody, 'spreadsheetUrl' ) );
} );

test.serial( 'POST /api/login: verifying the same PIN a second time returns 401', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	// First verify succeeds
	const res1: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res1.status, 200 );

	// Second verify with same PIN fails
	const res2: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res2.status, 401 );
} );

test.serial( 'POST /api/login: wrong PIN returns 401 and increments attempts', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const requestRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( requestRes.status, 200 );
	t.is( sentMails.length, 1 );
	const sentPin: string = sentMails[ 0 ].text.match( /\b(\d{6})\b/ )![ 1 ];
	const wrongPin: string = ( '000000' === sentPin ) ? '000001' : '000000';

	// Wrong PIN
	const res1: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res1.status, 401 );
	const body1: Record<string, unknown> = await res1.json() as Record<string, unknown>;
	t.true( -1 !== ( body1.error as string ).indexOf( 'Invalid' ) );

	// Correct PIN still works (1 attempt used, max is 3)
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];
	const res2: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res2.status, 200 );
} );

test.serial( 'POST /api/login: three wrong attempts deletes PIN and returns reset: true', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// First request generates a PIN (user is authorized)
	const requestRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( requestRes.status, 200 );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const correctPin: string = match![ 1 ];

	// Send wrong PIN 3 times — assert response shapes explicitly
	const wrongPin: string = ( '000000' === correctPin ) ? '000001' : '000000';

	const res1: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res1.status, 401 );
	const body1: Record<string, unknown> = await res1.json() as Record<string, unknown>;
	t.falsy( body1.reset, 'First wrong attempt must NOT return reset: true' );

	const res2: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res2.status, 401 );
	const body2: Record<string, unknown> = await res2.json() as Record<string, unknown>;
	t.falsy( body2.reset, 'Second wrong attempt must NOT return reset: true' );

	const res3: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res3.status, 401 );
	const body3: Record<string, unknown> = await res3.json() as Record<string, unknown>;
	t.true( body3.reset as boolean, 'Third wrong attempt must return reset: true' );

	// Correct PIN should no longer work (PIN is exhausted)
	const resCorrect: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: correctPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( resCorrect.status, 401 );
} );

test.serial( 'POST /api/login: exhausted PIN is invalidated so resend generates fresh code', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Generate first PIN
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	t.true( -1 !== output.indexOf( 'PIN generated: a***@***.com' ),
		'First request must log PIN generated' );
	const sentMailPin: string = sentMails[ 0 ].text.match( /\b(\d{6})\b/ )![ 1 ];
	const wrongPin: string = ( '000000' === sentMailPin ) ? '000001' : '000000';

	// Exhaust PIN with 3 wrong attempts — assert first two no reset, third reset: true
	for( let iL1: number = 0; iL1 < 3; iL1++ ) {
		const res: Response = await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
			headers: { 'Content-Type': 'application/json' },
		} );
		t.is( res.status, 401 );
		const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
		if( 2 > iL1 ) {
			t.falsy( body.reset, `Attempt ${ iL1 + 1 } must NOT return reset: true` );
		} else {
			t.true( body.reset as boolean, 'Third wrong must return reset: true' );
		}
	}

	// Advance past cooldown so resend proceeds immediately
	now.advance( 61_000 );

	// Assert the exhausted PIN remains invalid before fresh code request
	const staleAttempt: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( staleAttempt.status, 401, 'Exhausted PIN must remain invalid before new request' );
	const staleBody: Record<string, unknown> = await staleAttempt.json() as Record<string, unknown>;
	t.true( staleBody.reset as boolean, 'Exhausted PIN attempt must return reset: true' );

	// Email-only request after exhaustion — must generate a fresh PIN
	const prevOutputLen: number = output.length;
	const resendRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( resendRes.status, 200 );
	t.is( sentMails.length, 2, 'A new email must be sent after exhaustion' );

	// Audit log must show PIN generated (not PIN reused) for the second request
	const afterResend: string = output.substring( prevOutputLen );
	t.true( -1 !== afterResend.indexOf( 'PIN generated: a***@***.com' ),
		'Second request after exhaustion must log PIN generated, not PIN reused' );
	t.false( -1 !== afterResend.indexOf( 'PIN reused' ),
		'Second request after exhaustion must NOT log PIN reused' );

	// Verify the fresh PIN works
	const secondPinText: string = sentMails[ 1 ].text;
	const secondMatch: Nullable<RegExpMatchArray> = secondPinText.match( /\b(\d{6})\b/ );
	t.truthy( secondMatch );
	const secondPin: string = secondMatch![ 1 ];
	const verifyRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: secondPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( verifyRes.status, 200, 'Fresh PIN must be usable for verification' );
} );

test.serial( 'POST /api/login: expired PIN returns 401 with reset: true', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const sentPin: string = sentMails[ 0 ].text.match( /\b(\d{6})\b/ )![ 1 ];
	const wrongPin: string = ( '000000' === sentPin ) ? '000001' : '000000';

	// Advance time past PIN expiry (5 min + 1s)
	now.advance( 301_000 );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 401 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	t.true( body.reset as boolean, 'Expired PIN must return reset: true' );
} );

test.serial( 'POST /api/login: PIN emailed as 6 digits with leading zeros', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match, 'PIN must be 6 digits' );
	t.is( match![ 1 ].length, 6, 'PIN must be exactly 6 digits' );
} );

test.serial( 'POST /api/login: PIN map key is normalized email (case-insensitive)', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'Admin@Test.Com' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// Request with mixed case
	const res1: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: '  Admin@Test.Com  ' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res1.status, 200 );
	t.is( sentMails.length, 1 );

	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	// Verify with lowercase
	const res2: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res2.status, 200, 'Lowercase verify must succeed after mixed-case request' );
} );

test.serial( 'POST /api/login: resend after cooldown returns same PIN and does not extend expiration', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// First request
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinAText: string = sentMails[ 0 ].text;
	const matchA: Nullable<RegExpMatchArray> = pinAText.match( /\b(\d{6})\b/ );
	t.truthy( matchA );
	const pinA: string = matchA![ 1 ];

	// Advance past cooldown (1 min)
	now.advance( 61_000 );

	// Second request after cooldown — should send same PIN again
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 2 );
	const pinBText: string = sentMails[ 1 ].text;
	const matchB: Nullable<RegExpMatchArray> = pinBText.match( /\b(\d{6})\b/ );
	t.truthy( matchB );
	const pinB: string = matchB![ 1 ];
	t.is( pinA, pinB, 'Resend must send the same PIN' );

	// Advance past original PIN expiry to verify it was not extended
	now.advance( 250_000 );

	const resA: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: pinA } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( resA.status, 401, 'PIN must expire at original expiry time, not be extended by resend' );
} );

test.serial( 'POST /api/login: within cooldown returns generic, does not send email, old PIN still valid', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// First request
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pinA: string = match![ 1 ];

	// Advance 30 seconds (still within cooldown)
	now.advance( 30_000 );

	// Second request returns generic, no new email
	const resPre: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1, 'No new email should be sent within cooldown' );
	t.is( resPre.status, 200 );

	// Old PIN should still work
	const resA: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: pinA } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( resA.status, 200 );
} );

// ---------------------------------------------------------------------------
// Old endpoints return 404
// ---------------------------------------------------------------------------

test.serial( 'old endpoints return 404', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const endpoints: { method: string; path: string; body?: unknown }[] = [
		{ method: 'GET', path: '/api/status' },
		{ method: 'POST', path: '/api/auth/request', body: { email: 'admin@test.com' } },
		{ method: 'POST', path: '/api/auth/verify', body: { email: 'admin@test.com', pin: '123456' } },
		{ method: 'POST', path: '/api/auth/logout' },
		{ method: 'GET', path: '/api/accounts' },
		{ method: 'GET', path: '/api/sharing' },
	];

	for( const ep of endpoints ) {
		const init: RequestInit = { method: ep.method as RequestInit[ 'method' ] };
		if( undefined !== ep.body ) {
			init.body = JSON.stringify( ep.body );
			init.headers = { 'Content-Type': 'application/json' };
		}
		const res: Response = await _backendRequest( backend, ep.path, init );
		t.is( res.status, 404, `${ ep.method } ${ ep.path } should return 404` );
	}
} );

// ---------------------------------------------------------------------------
// No Set-Cookie or spreadsheetId exposure
// ---------------------------------------------------------------------------

test.serial( 'no response contains Set-Cookie', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.falsy( res.headers.get( 'set-cookie' ), 'No Set-Cookie header' );
} );

test.serial( 'no response body contains spreadsheetId, spreadsheetURL, or spreadsheetUrl', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: string = await res.text();
	t.false( -1 !== body.indexOf( 'spreadsheetId' ), 'Body must not contain spreadsheetId' );
	t.false( -1 !== body.indexOf( 'spreadsheetURL' ), 'Body must not contain spreadsheetURL' );
	t.false( -1 !== body.indexOf( 'spreadsheetUrl' ), 'Body must not contain spreadsheetUrl' );
} );

// ---------------------------------------------------------------------------
// Account filtering tests
// ---------------------------------------------------------------------------

test.serial( 'non-admin receives only matching account rows', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ],
		  [ 'SrvB', 'uB', 'pB', '', 'other@test.com' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = body.accounts as Record<string, unknown>[];
	t.is( accounts.length, 1 );
	t.is( accounts[ 0 ].service as string, 'SrvA' );
} );

test.serial( 'admin email receives all account rows', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'SrvA', 'uA', 'pA', '', 'other@test.com' ],
		  [ 'SrvB', 'uB', 'pB', '', 'other@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = body.accounts as Record<string, unknown>[];
	t.is( accounts.length, 2 );
} );

// ---------------------------------------------------------------------------
// Recipient parsing tests
// ---------------------------------------------------------------------------

test.serial( 'recipient cells split on semicolons, commas, and spaces', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'SrvA', 'uA', 'pA', '', 'foo@bar.it;foo1@bar.it,foo3@bar.it foo4@bar.it' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// Each of the 4 email tokens should be authorized
	const emails: string[] = [ 'foo@bar.it', 'foo1@bar.it', 'foo3@bar.it', 'foo4@bar.it' ];

	for( const email of emails ) {
		await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email } ),
			headers: { 'Content-Type': 'application/json' },
		} );
	}

	// All 4 should have received emails (since they're authorized)
	t.is( sentMails.length, 4 );
	for( let iL1: number = 0; iL1 < 4; iL1++ ) {
		t.is( sentMails[ iL1 ].to, emails[ iL1 ] );
	}
} );

test.serial( 'recipient tokens are deduplicated', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'SrvA', 'uA', 'pA', '', 'test@test.com; test@test.com, test@test.com' ] ],
		[ [ 'email' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'test@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'test@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
} );

// ---------------------------------------------------------------------------
// Constructor error tests
// ---------------------------------------------------------------------------

test.serial( 'response never contains shared, gviz URL, or spreadsheet ID', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'username', 'password', 'link' ],
		  [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const body: string = await res.text();
	t.false( -1 !== body.indexOf( 'shared' ), 'Response must not contain "shared" field' );
	t.false( -1 !== body.indexOf( 'gviz' ), 'Response must not contain gviz' );
	t.false( -1 !== body.indexOf( 'test123' ), 'Response must not contain spreadsheet ID' );
} );

// ---------------------------------------------------------------------------
// Cache tests
// ---------------------------------------------------------------------------

test.serial( 'services cache is reused on verify so sheets are not fetched again', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	// Non-persistent intercepts — second request would fail if cache not used
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
		false,
	);
	const backend: Backend = createTestBackend( transport );

	// First request triggers sheet fetches (consumes non-persistent interceptors)
	const requestRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( requestRes.status, 200 );
	t.is( sentMails.length, 1 );

	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	// Verify — should use cached services, no more HTTP requests
	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
} );

test.serial( 'expired cache is transparently rebuilt', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	// First request creates cache
	const requestRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( requestRes.status, 200 );
	t.is( sentMails.length, 1 );

	// Advance past cache TTL (5 min)
	now.advance( 301_000 );

	// New email-only request — cache expired and PIN expired, creates fresh state
	const resendRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( resendRes.status, 200 );
	t.is( sentMails.length, 2, 'New email must be sent after cache+pin expiry' );

	// Verify with fresh PIN
	const pinText: string = sentMails[ 1 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const freshPin: string = match![ 1 ];

	const verifyRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin: freshPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( verifyRes.status, 200 );
} );

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test.serial( 'POST /api/login: rate limiting returns generic response after many requests', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	for( let iL1: number = 0; iL1 < 6; iL1++ ) {
		await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email: 'admin@test.com' } ),
			headers: { 'Content-Type': 'application/json' },
		} );
		now.advance( 100 );
	}

	// Request should still return generic response
	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
} );

test.serial( 'GET /api/login (wrong method) returns 404', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login' );
	t.is( res.status, 404 );
} );

test.serial( 'GET / serves the frontend index.html', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/' );
	t.is( res.status, 200 );
	const text: string = await res.text();
	t.true( -1 !== text.indexOf( '<title>PSPS</title>' ), 'Must serve index.html with PSPS title' );
} );

test.serial( 'POST /api/not-found returns 404', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/not-found', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 404 );
} );

test.serial( 'GET /login returns 404 (no SPA fallback)', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/login' );
	t.is( res.status, 404 );
	const text: string = await res.text();
	t.false( -1 !== text.indexOf( '<title>PSPS</title>' ), 'Must not serve index.html for unknown paths' );
} );

test.serial( 'GET /foo returns 404 (no SPA fallback)', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/foo' );
	t.is( res.status, 404 );
	const text: string = await res.text();
	t.false( -1 !== text.indexOf( '<title>PSPS</title>' ), 'Must not serve index.html for unknown paths' );
} );

// ---------------------------------------------------------------------------
// SMTP transport from config (constructor tests)
// ---------------------------------------------------------------------------

test( 'Backend constructor: creates SMTP transport from config when host and from are set', ( t ) => {
	const config: Config = makeConfig();
	// Should not throw — transport is created internally
	t.notThrows( () => {
		new Backend( config );
	} );
} );

test( 'Backend constructor: creates SMTP transport without auth when user is empty', ( t ) => {
	const config: Config = makeConfig( {
		smtp: {
			host: 'smtp.example.com',
			port: 25,
			secure: false,
			user: '',
			pass: '',
			fromAddress: 'noreply@example.com',
			fromName: 'Test',
		},
	} );
	t.notThrows( () => {
		new Backend( config );
	} );
} );

// ---------------------------------------------------------------------------
// Config validation: stale sharing property is rejected by strict zod
// ---------------------------------------------------------------------------

test( 'invalid config: stale sheets.sharing is rejected by strict zod', async ( t ) => {
	const configPath: string = writeTempConfig( { sheets: { accounts: 'a', sharing: 's', admins: 'b' } } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code when sheets.sharing is present' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// SMTP sanitization integration tests
// ---------------------------------------------------------------------------

test.serial( 'SMTP error unknown code returns SMTP delivery error, code not leaked', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string } = new Error( 'some error' );
			err.code = 'EUNKNOWN';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	// Delivery log: assert exact suffix (SMTP delivery error) and every sentinel absent
	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (SMTP delivery error)' ),
		'Delivery log must contain full masked message with SMTP delivery error suffix' );
	t.false( -1 !== output.indexOf( 'EUNKNOWN' ),
		'Must NOT contain unknown code sentinel' );
	t.false( -1 !== output.indexOf( 'some error' ),
		'Must NOT contain raw error message sentinel' );
	t.false( -1 !== output.indexOf( 'SMTP delivery error with' ),
		'Must NOT have extra content after SMTP delivery error' );
} );

test.serial( 'SMTP error with sentinels in all fields and unknown code leaks nothing', async ( t ) => {
	const codeSentinel: string = 'SENTINEL_CODE_X';
	const nameSentinel: string = 'SENTINEL_NAME_X';
	const messageSentinel: string = 'SENTINEL_MSG_X';
	const addressSentinel: string = 'SENTINEL_ADDR_X';
	const hostSentinel: string = 'SENTINEL_HOST_X';
	const portSentinel: number = 99999;
	const configSentinel: string = 'SENTINEL_CFG_X';
	const responseSentinel: string = 'SENTINEL_RESP_X';

	// Delivery log: throwing transport with all sentinel fields
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & Record<string, unknown> = new Error( messageSentinel ) as Error & Record<string, unknown>;
			Object.defineProperty( err, 'name', { value: nameSentinel } );
			err.code = codeSentinel;
			err.address = addressSentinel;
			err.host = hostSentinel;
			err.port = portSentinel;
			err.config = { sentinel: configSentinel };
			err.response = responseSentinel;
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend2: Backend = new Backend( config, throwingTransport );
	_backends.push( backend2 );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend2, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (SMTP delivery error)' ),
		'Delivery log must contain SMTP delivery error' );
	t.false( -1 !== output.indexOf( codeSentinel ), 'Log must not contain code sentinel' );
	t.false( -1 !== output.indexOf( nameSentinel ), 'Log must not contain name sentinel' );
	t.false( -1 !== output.indexOf( messageSentinel ), 'Log must not contain message sentinel' );
	t.false( -1 !== output.indexOf( addressSentinel ), 'Log must not contain address sentinel' );
	t.false( -1 !== output.indexOf( hostSentinel ), 'Log must not contain host sentinel' );
	t.false( -1 !== output.indexOf( String( portSentinel ) ), 'Log must not contain port sentinel' );
	t.false( -1 !== output.indexOf( configSentinel ), 'Log must not contain config sentinel' );
	t.false( -1 !== output.indexOf( responseSentinel ), 'Log must not contain response sentinel' );
	t.false( -1 !== output.indexOf( 'SMTP delivery error with' ),
		'Must NOT have extra content after SMTP delivery error' );
} );

test.serial( 'SMTP error with name but no code returns SMTP delivery error', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error = new Error( 'some error' );
			Object.defineProperty( err, 'name', { value: 'SENTINEL_ErrorName' } );
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	// Delivery log: assert exact suffix and every sentinel absent
	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (SMTP delivery error)' ),
		'Error name only must return SMTP delivery error' );
	t.false( -1 !== output.indexOf( 'SENTINEL_ErrorName' ),
		'Must NOT contain error name sentinel' );
	t.false( -1 !== output.indexOf( 'some error' ),
		'Must NOT contain raw error message sentinel' );
	t.false( -1 !== output.indexOf( 'SMTP delivery error with' ),
		'Must NOT have extra content after SMTP delivery error' );
} );

test.serial( 'SMTP non-Error thrown returns SMTP delivery error', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			throw 'SENTINEL_NON_ERROR_STRING' as unknown;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	// Delivery log: assert exact suffix and every sentinel absent
	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (SMTP delivery error)' ),
		'Non-Error thrown must return SMTP delivery error' );
	t.false( -1 !== output.indexOf( 'SENTINEL_NON_ERROR_STRING' ),
		'Must NOT contain thrown value sentinel' );
	t.false( -1 !== output.indexOf( 'SMTP delivery error with' ),
		'Must NOT have extra content after SMTP delivery error' );
} );

test.serial( 'SMTP error unsafe command (not in allowlist) is not emitted', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string; responseCode?: number; command?: string } = new Error( 'auth fail' );
			err.code = 'EAUTH';
			err.responseCode = 535;
			err.command = 'AUTH CUSTOM';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'EAUTH: SMTP authentication failed; responseCode=535' ),
		'Known code and responseCode must still appear' );
	t.false( -1 !== output.indexOf( 'command=AUTH CUSTOM' ),
		'Unsafe command must NOT be emitted' );
	t.false( -1 !== output.indexOf( 'AUTH CUSTOM' ),
		'Must NOT contain unsafe command string at all' );
} );

test.serial( 'SMTP error safe command AUTH LOGIN remains emitted', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string; responseCode?: number; command?: string } = new Error( 'auth fail' );
			err.code = 'EAUTH';
			err.responseCode = 535;
			err.command = 'AUTH LOGIN';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'command=AUTH LOGIN' ),
		'Safe command AUTH LOGIN must be emitted' );
} );

test.serial( 'SMTP error ESOCKET raw message content is not emitted', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string } = new Error( 'connect ECONNREFUSED 192.168.1.1:25 some sensitive data here' );
			err.code = 'ESOCKET';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'cause=connection-refused' ),
		'Approved cause token must still be emitted' );
	t.false( -1 !== output.indexOf( '192.168.1.1' ),
		'Must NOT contain IP address from message' );
	t.false( -1 !== output.indexOf( 'sensitive data' ),
		'Must NOT contain raw message content' );
} );

// ---------------------------------------------------------------------------
// Config log field handling
// ---------------------------------------------------------------------------

test( 'config log: omitted/empty uses stdout, no crash', async ( t ) => {
	const configPath: string = writeTempConfig( { log: '' } );
	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );
	t.true( result.timedOut || ( null !== result.code && 0 === result.code ),
		'Empty log config must start without error' );
	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'config log: nonempty path starts server', async ( t ) => {
	const logDir: string = path.resolve( projectRoot(), 'tests', `.runtime-logpath-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( logDir, { recursive: true } );
	const logPath: string = path.join( logDir, 'test.log' );
	const configPath: string = writeTempConfig( { log: logPath } );
	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );
	t.true( result.timedOut || ( null !== result.code && 0 === result.code ),
		'Nonempty log path config must start without error' );
	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
	fs.rmSync( logDir, { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Startup logging tests
// ---------------------------------------------------------------------------

test( 'startup log: file config writes startup message to log file', async ( t ) => {
	const logDir: string = path.resolve( projectRoot(), 'tests', `.runtime-startup-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( logDir, { recursive: true } );
	_tmpDirs.push( logDir );
	const logPath: string = path.join( logDir, 'startup.log' );
	const configPath: string = writeTempConfig( { log: logPath } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );
	t.true( result.timedOut || ( null !== result.code && 0 === result.code ),
		'File log config must start without error' );

	t.true( fs.existsSync( logPath ), 'Log file must exist' );
	const logContent: string = fs.readFileSync( logPath, 'utf-8' );
	t.true( -1 !== logContent.indexOf( 'Logging started for 127.0.0.1:0.' ),
		'Log file must contain startup message with host:port' );
	t.false( -1 !== logContent.indexOf( 'Logging started on stdout.' ),
		'Log file must NOT contain stdout startup message' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'startup log: empty log config writes stdout startup message', async ( t ) => {
	const configPath: string = writeTempConfig( { log: '' } );
	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );
	t.true( result.timedOut || ( null !== result.code && 0 === result.code ),
		'Empty log config must start without error' );

	t.true( -1 !== result.stdout.indexOf( 'Logging started on stdout.' ),
		'Stdout must contain startup message' );
	t.false( -1 !== result.stdout.indexOf( 'Logging started for' ),
		'Stdout must NOT contain file startup message' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

test( 'startup log: failed initial file open prints safe error and stdout startup message', async ( t ) => {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-initlog-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	_tmpDirs.push( tmpDir );
	const logPath: string = path.join( tmpDir, 'nonexistent-subdir', 'server.log' );
	const configPath: string = writeTempConfig( { log: logPath } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.is( result.stderr.trim(), 'Error: Could not open log file.' );
	t.true( -1 !== result.stdout.indexOf( 'Logging started on stdout.' ),
		'Stdout must contain startup message after failed log open' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Audit logging tests
// ---------------------------------------------------------------------------

test.serial( 'malformed email route logs raw string at WARNING', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Non-string email (number in body)
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 123 } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.true( -1 !== output.indexOf( 'malformed email: ' ),
		'Non-string email must log malformed email: with empty raw string' );

	// String with whitespace-only (validates to empty after trim)
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: '   ' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.true( -1 !== output.indexOf( 'malformed email:    ' ),
		'Whitespace-only email must log malformed email: with original whitespace' );

	// Missing email field
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( {} ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.true( -1 !== output.indexOf( 'malformed email: ' ),
		'Missing email must log malformed email: with empty raw string' );
} );

test.serial( 'authorized path logs request, auth granted, code generated, delivery success, masks email, no PIN', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'Login request received: a***@***.com' ),
		'Must log login request received with masked email' );
	t.true( -1 !== output.indexOf( 'Login authorization decision for a***@***.com: true' ),
		'Must log authorization granted with masked email' );
	t.true( -1 !== output.indexOf( 'PIN generated: a***@***.com' ),
		'Must log PIN generated with masked email' );
	t.true( -1 !== output.indexOf( 'PIN delivery queued: a***@***.com' ),
		'Must log PIN delivery queued with masked email' );
	t.true( -1 === output.indexOf( 'admin@test.com' ),
		'Must NOT contain unmasked email' );
	t.false( ( /\b\d{6}\b/ ).test( output ),
		'Must NOT contain a 6-digit PIN' );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	// Now verify — should log success
	const verifyRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( verifyRes.status, 200 );

	t.true( -1 !== output.indexOf( 'PIN verify attempt: a***@***.com' ),
		'Must log PIN verify attempt' );
	t.true( -1 !== output.indexOf( 'PIN verified: a***@***.com' ),
		'Must log PIN verified' );
} );

test.serial( 'unauthorized logs authorization denied and no delivery queued', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ] ],
		[ [ 'email' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'unknown@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'Login authorization decision for u***@***.com: false' ),
		'Must log authorization denied' );
	t.true( -1 === output.indexOf( 'PIN delivery queued' ),
		'Must NOT log delivery queued for unauthorized' );
} );

test.serial( 'throwing SMTP transport logs delivery failure with safe classification', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string; errno?: number } = new Error( 'Connection refused' );
			err.code = 'ECONNREFUSED';
			err.errno = -111;
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (ECONNREFUSED: SMTP connection refused; errno=-111)' ),
		'Must log delivery failure with SMTP-safe error description' );
	t.true( -1 === output.indexOf( 'Connection refused' ),
		'Must NOT contain raw error message' );
	t.true( -1 === output.indexOf( 'admin@test.com' ),
		'Must NOT contain unmasked email' );
	t.true( -1 === output.indexOf( 'pass' ),
		'Must NOT contain SMTP credentials' );
} );

test.serial( 'SMTP error ESOCKET with connection-refused cause logs safe formatted output', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string; errno?: number } = new Error( 'connect ECONNREFUSED 203.0.113.1:587' );
			err.code = 'ESOCKET';
			err.errno = -111;
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (ESOCKET: SMTP socket error; errno=-111; cause=connection-refused)' ),
		'ESOCKET with connection-refused cause must produce safe formatted output' );
	t.false( ( /203\.0\.113\.1/ ).test( output ),
		'Must NOT contain IP address from message' );
	t.true( -1 === output.indexOf( 'admin@test.com' ),
		'Must NOT contain unmasked email' );
} );

test.serial( 'SMTP error EAUTH with responseCode and command', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string; responseCode?: number; command?: string; response?: string } = new Error( '535 Authentication failed' );
			err.code = 'EAUTH';
			err.responseCode = 535;
			err.command = 'AUTH LOGIN';
			err.response = '535 5.7.0 Authentication failed';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (EAUTH: SMTP authentication failed; responseCode=535; command=AUTH LOGIN)' ),
		'EAUTH must include description, responseCode, and command' );
	t.false( ( /Authentication failed/ ).test( output.replace( /SMTP authentication failed/, '' ) ),
		'Must NOT contain raw authentication failed message' );
	t.true( -1 === output.indexOf( '535 5.7.0' ),
		'Must NOT contain raw response' );
} );

test.serial( 'SMTP error ESOCKET with TLS message logs cause=tls', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const throwingTransport: nodemailer.Transporter = {
		sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
			const err: Error & { code?: string } = new Error( 'Hostname/IP doesn\'t match certificate\'s altnames: "smtp.example.com"' );
			err.code = 'ESOCKET';
			throw err;
		},
	} as unknown as nodemailer.Transporter;
	const backend: Backend = new Backend( config, throwingTransport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'PIN delivery failed: a***@***.com (ESOCKET: SMTP socket error; cause=tls)' ),
		'TLS-like ESOCKET must produce cause=tls' );
	t.false( ( /certificate/ ).test( output ),
		'Must NOT contain raw certificate-related message' );
} );

test.serial( 'no SMTP transport logs delivery unavailable', async ( t ) => {
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig( {
		smtp: {
			host: '',
			port: 587,
			secure: false,
			user: '',
			pass: '',
			fromAddress: '',
			fromName: 'Test',
		},
	} );
	const backend: Backend = new Backend( config );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );

	t.true( -1 !== output.indexOf( 'No SMTP transport, PIN not sent: a***@***.com' ),
		'Must log no SMTP transport with masked email' );
} );

test.serial( 'PIN events: verify success, failure with attempts, exhausted reset, expired reset', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Generate PIN
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const actualPin: string = match![ 1 ];
	const prevOutputLen: number = output.length;

	// — Wrong PIN, 2 attempts remaining —
	const wrongPin: string = ( '111111' === actualPin ) ? '111112' : '111111';
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterFirstWrong: string = output.substring( prevOutputLen );
	t.true( -1 !== afterFirstWrong.indexOf( 'PIN wrong: u***@***.com, attempts remaining: 2' ),
		'First wrong PIN must log remaining attempts' );

	// — Wrong PIN, 1 attempt remaining —
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterSecondWrong: string = output.substring( prevOutputLen );
	t.true( -1 !== afterSecondWrong.indexOf( 'PIN wrong: u***@***.com, attempts remaining: 1' ),
		'Second wrong PIN must log remaining attempts' );

	// — Wrong PIN, exhausted —
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: wrongPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterThirdWrong: string = output.substring( prevOutputLen );
	t.true( -1 !== afterThirdWrong.indexOf( 'PIN exhausted: u***@***.com' ),
		'Third wrong PIN must log exhausted' );

	// — Expired PIN event —
	// After exhaustion the PIN was cleared, so email-only request generates fresh PIN
	now.advance( 120_000 );
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 2, 'Resend must send second email' );
	const pinAfterExhaustLen: number = output.length;

	// The fresh PIN has expire = now(1_700_120_000) + 300_000 = 1_700_420_000.
	// Advance past it to trigger expiry.
	now.advance( 310_000 );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: sentMails[ 1 ].text.match( /\b(\d{6})\b/ )![ 1 ] } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterExpired: string = output.substring( pinAfterExhaustLen );
	t.true( -1 !== afterExpired.indexOf( 'PIN expired: u***@***.com' ),
		'Expired PIN must log expired event' );
} );

test.serial( 'non-numeric PIN audit: attempts remaining, final exhaustion, no PIN leak', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Generate PIN
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const prevOutputLen: number = output.length;

	// Non-numeric PIN with 2 attempts remaining (first bad PIN)
	const nonNumericPin: string = 'abc123';
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: nonNumericPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterFirstBad: string = output.substring( prevOutputLen );
	t.true( -1 !== afterFirstBad.indexOf( 'PIN wrong: u***@***.com, attempts remaining: 2' ),
		'Non-numeric PIN with attempts remaining must log PIN wrong with attempts remaining' );
	t.false( ( /\b\d{6}\b/ ).test( afterFirstBad ),
		'Log must not contain numeric PIN' );
	t.false( -1 !== afterFirstBad.indexOf( nonNumericPin ),
		'Log must not contain the submitted non-numeric value' );

	// Non-numeric PIN exhausted (third bad PIN)
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: nonNumericPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin: nonNumericPin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterThirdBad: string = output.substring( prevOutputLen );
	t.true( -1 !== afterThirdBad.indexOf( 'PIN exhausted: u***@***.com' ),
		'Third non-numeric PIN must log exhausted' );
	t.false( ( /\b\d{6}\b/ ).test( afterThirdBad ),
		'Log must not contain numeric PIN after exhaustion' );
} );

test.serial( 'log events: resend, cooldown, rate-limit with masked email', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const stream: PassThrough = _captureLoggerOutput( t );
	const now: _FakeNow = withFakeNow( t, 1_700_000_000_000 );
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ] ],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const config: Config = makeConfig();
	const backend: Backend = new Backend( config, transport );
	_backends.push( backend );

	let output: string = '';
	stream.on( 'data', ( chunk: Buffer ): void => {
		output += chunk.toString();
	} );

	// Generate first PIN
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const prevOutputLen: number = output.length;

	// — Cooldown (within 60s) —
	now.advance( 30_000 );
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterCooldown: string = output.substring( prevOutputLen );
	t.true( -1 !== afterCooldown.indexOf( 'PIN cooldown: u***@***.com' ),
		'Cooldown must log with masked email' );

	// — Resend (after cooldown) —
	now.advance( 60_000 );
	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	const afterResend: string = output.substring( prevOutputLen );
	t.is( sentMails.length, 2 );
	t.true( -1 !== afterResend.indexOf( 'PIN reused: u***@***.com' ),
		'Resend must log with masked email' );

	// — Rate limit (many requests) —
	for( let iL1: number = 0; iL1 < 6; iL1++ ) {
		await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email: 'user@test.com' } ),
			headers: { 'Content-Type': 'application/json' },
		} );
		now.advance( 100 );
	}
	const afterRateLimit: string = output.substring( prevOutputLen );
	t.true( -1 !== afterRateLimit.indexOf( 'Rate limited: u***@***.com' ),
		'Rate limit must log with masked email' );
} );

// ---------------------------------------------------------------------------
// SIGHUP log reopening
// ---------------------------------------------------------------------------

( 'win32' === process.platform ? test.serial.skip : test.serial )( 'SIGHUP reopens log file when config.log is set', async ( t ) => {
	// Use a repo-local temp directory under tests/
	const testTmpDir: string = path.resolve( projectRoot(), 'tests', '.runtime-sighup-rotate' );
	fs.mkdirSync( testTmpDir, { recursive: true } );
	_tmpDirs.push( testTmpDir );
	const logPath: string = path.join( testTmpDir, 'psps.log' );
	const configPath: string = writeTempConfig( { log: logPath } );

	// Start process
	const proc: ChildProcessByStdio<null, Readable, Readable> = spawn( 'node', [ 'backend/dist/index.js', '--config', configPath ], {
		cwd: projectRoot(),
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
	t.teardown( async (): Promise<void> => {
		await terminateChild( proc );
	} );

	const { ready, state }: ReturnType<typeof trackReadiness> = trackReadiness( proc );
	await ready;

	if( state.childFailed ) {
		t.fail( `${ state.childFailed }. stderr: ${ state.stderr }` );
	}

	t.true( state.seenListening, 'Backend must start successfully' );

	// Rename log file to simulate external rotation
	const rotatedPath: string = path.join( testTmpDir, 'psps.log.1' );
	fs.renameSync( logPath, rotatedPath );

	// Send SIGHUP
	proc.kill( 'SIGHUP' );

	// Give it time to reopen
	await new Promise( ( resolve: ( value: void ) => void ): void => {
		setTimeout( resolve, 1500 );
	} );

	// Read the new log file
	t.true( fs.existsSync( logPath ), 'New log file must exist after SIGHUP' );
	const logContent: string = fs.readFileSync( logPath, 'utf-8' );

	t.true( -1 !== logContent.indexOf( 'Log file reopened.' ),
		'Log file must contain reopened entry' );
	// Verify "Log file reopened." is exact — no host:port suffix appended
	t.false( -1 !== logContent.indexOf( 'Log file reopened. for' ),
		'Log file reopened must not have host:port suffix appended' );

	t.is( state.unexpectedTerminalEvent, '',
		'No unexpected terminal event before intentional shutdown' );
	await terminateChild( proc );
	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

( 'win32' === process.platform ? test.serial.skip : test.serial )( 'SIGHUP with empty log: process stays alive, no crash', async ( t ) => {
	const testTmpDir2: string = path.resolve( projectRoot(), 'tests', '.runtime-sighup-empty' );
	fs.mkdirSync( testTmpDir2, { recursive: true } );
	_tmpDirs.push( testTmpDir2 );
	const configPath: string = writeTempConfig( { log: '' } );

	const proc: ChildProcessByStdio<null, Readable, Readable> = spawn( 'node', [ 'backend/dist/index.js', '--config', configPath ], {
		cwd: projectRoot(),
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
	t.teardown( async (): Promise<void> => {
		await terminateChild( proc );
	} );

	const { ready, state }: ReturnType<typeof trackReadiness> = trackReadiness( proc );
	await ready;

	if( state.childFailed ) {
		t.fail( `${ state.childFailed }. stderr: ${ state.stderr }` );
	}

	t.true( state.seenListening, 'Backend must start successfully with empty log' );

	// Send SIGHUP — must not crash
	proc.kill( 'SIGHUP' );

	await new Promise( ( resolve: ( value: void ) => void ): void => {
		setTimeout( resolve, 1000 );
	} );

	t.true( null === proc.exitCode, 'Process must remain alive after SIGHUP with empty log' );

	t.is( state.unexpectedTerminalEvent, '',
		'No unexpected terminal event before intentional shutdown' );
	await terminateChild( proc );
	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Log file open/reopen failure tests
// ---------------------------------------------------------------------------

test( 'failed initial log open prints safe error without path leak', async ( t ) => {
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-initlog-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	_tmpDirs.push( tmpDir );
	const logPath: string = path.join( tmpDir, 'nonexistent-subdir', 'server.log' );
	const configPath: string = writeTempConfig( { log: logPath } );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.is( result.stderr.trim(), 'Error: Could not open log file.' );
	const combined: string = result.stdout + result.stderr;
	t.false( -1 !== combined.indexOf( logPath ), 'Must NOT leak the log path in combined output' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

( 'win32' === process.platform ? test.serial.skip : test.serial )( 'SIGHUP reopen failure prints safe error without path leak', async ( t ) => {
	const testTmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-sighup-fail-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( testTmpDir, { recursive: true } );
	_tmpDirs.push( testTmpDir );
	const logDir: string = path.join( testTmpDir, 'logs' );
	fs.mkdirSync( logDir, { recursive: true } );
	const logPath: string = path.join( logDir, 'psps.log' );
	const configPath: string = writeTempConfig( { log: logPath } );

	const proc: ChildProcessByStdio<null, Readable, Readable> = spawn( 'node', [ 'backend/dist/index.js', '--config', configPath ], {
		cwd: projectRoot(),
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
	t.teardown( async (): Promise<void> => {
		await terminateChild( proc );
	} );

	const { ready, state }: ReturnType<typeof trackReadiness> = trackReadiness( proc );
	await ready;

	if( state.childFailed ) {
		t.fail( `${ state.childFailed }. stderr: ${ state.stderr }` );
	}

	t.true( state.seenListening, 'Backend must start successfully' );

	// Break the log path: remove the log dir and replace with a file so reopen fails with ENOTDIR
	fs.rmSync( logDir, { recursive: true, force: true } );
	fs.writeFileSync( logDir, 'blocker', 'utf-8' );

	// Send SIGHUP to trigger reopen
	proc.kill( 'SIGHUP' );

	// Give it time to process the reopen attempt
	await new Promise( ( resolve: ( value: void ) => void ): void => {
		setTimeout( resolve, 1500 );
	} );

	t.is( state.unexpectedTerminalEvent, '',
		'No unexpected terminal event before intentional shutdown' );
	await terminateChild( proc );

	t.is( state.stderr.trim(), 'Error: Failed to reopen log file.' );
	const combined2: string = state.stdout + state.stderr;
	t.false( -1 !== combined2.indexOf( logPath ), 'Must NOT leak the log path in combined output' );

	fs.rmSync( path.dirname( configPath ), { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Config error: malformed JSON with SMTP secrets does not leak secrets
// ---------------------------------------------------------------------------

test( 'config error: malformed JSON with SMTP secrets does not leak secrets', async ( t ) => {
	const sentinelSecret: string = 'SENTINEL_SMTP_SECRET_xyz789';
	const tmpDir: string = path.resolve( projectRoot(), 'tests', `.runtime-malformed-${ Date.now() }-${ Math.floor( Math.random() * 10000 ) }` );
	fs.mkdirSync( tmpDir, { recursive: true } );
	const configPath: string = path.join( tmpDir, 'config.json' );

	// Write intentionally malformed JSON that contains SMTP-looking secret text
	const malformedJSON: string = `{ "smtp": { "pass": "${ sentinelSecret }", "host": "smtp.example.com" `;
	fs.writeFileSync( configPath, malformedJSON, 'utf-8' );

	const result: Awaited<ReturnType<typeof runIndexJs>> = await runIndexJs( configPath, 3000 );

	t.not( 0, result.code, 'Must exit with non-zero code' );

	const output: string = result.stdout + result.stderr;
	t.true( -1 !== output.indexOf( 'Config error.' ),
		'Output must contain safe Config error.' );
	t.false( -1 !== output.indexOf( sentinelSecret ),
		'Output must NOT contain the SMTP secret sentinel' );
	t.false( -1 !== output.indexOf( 'SENTINEL_SMTP_SECRET' ),
		'Output must NOT contain any part of the sentinel secret' );

	fs.rmSync( tmpDir, { recursive: true, force: true } );
} );

// ---------------------------------------------------------------------------
// Services fetch failure error handling
// ---------------------------------------------------------------------------

test.serial( 'POST /api/login: services failure during email-only returns generic success, no error leak', async ( t ) => {
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const originalDispatcher: Dispatcher = getGlobalDispatcher();
	const mockAgent: MockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	setGlobalDispatcher( mockAgent );
	t.teardown( async(): Promise<void> => {
		setGlobalDispatcher( originalDispatcher );
		await mockAgent.close();
	} );

	const backend: Backend = createTestBackend( transport );

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'anyone@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200, 'Must return 200 even when sheets fail' );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	t.is( body.message, 'If your email is authorized, you have received a code.', 'Must return exact generic message, not upstream error' );
	t.true( 'number' === typeof body.next && isFinite( body.next as number ), 'Must include numeric next' );
	t.is( Object.keys( body ).length, 2, 'Response must have exactly 2 keys (message and next) — no error or accounts' );
	t.falsy( body.error, 'Must not leak error details' );
	t.falsy( body.accounts, 'Must not return accounts' );
} );

test.serial( 'POST /api/login: cooldown blocks resend and returns generic response', async ( t ) => {
	// This path tests that a second email-only request within the 60-second
	// pinResendCooldown receives a generic response (no new PIN, no leak).
	// The services-failure-on-cache-miss path during verify is unreachable
	// through Hono requests alone (PIN expiry = t0 + cacheTTL, cache expiry
	// = t1 + cacheTTL with t1 >= t0, so valid PIN implies cache not expired).
	const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ] ],
		[ [ 'email' ] ],
	);

	const backend: Backend = createTestBackend( transport );

	// First request — generates PIN, starts cooldown
	const firstRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( firstRes.status, 200 );

	// Second request — within cooldown window, returns generic, no new PIN
	const secondRes: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( secondRes.status, 200 );
	const secondBody: Record<string, unknown> = await secondRes.json() as Record<string, unknown>;
	t.is( secondBody.message, 'If your email is authorized, you have received a code.', 'Cooldown must return exact generic message' );
	t.true( 'number' === typeof secondBody.next && isFinite( secondBody.next as number ), 'Cooldown must include numeric next' );
	t.is( Object.keys( secondBody ).length, 2, 'Cooldown response must have exactly 2 keys (message and next)' );
	t.falsy( secondBody.error, 'Must not leak error details' );
} );

test.serial( 'admins sheet header-only does not grant admin accounts', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ],
		  [ 'SrvB', 'uB', 'pB', '', 'other@test.com' ] ],
		[ [ 'email' ] ], // header only, no admin rows
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'admin@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 0, 'admin@test.com must not be authorized with only header' );
} );

test.serial( 'empty account row is ignored', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'SrvA', 'uA', 'pA', '', 'user@test.com' ],
		  [ '', '', '', '', '' ], // completely empty row
		],
		[ [ 'email' ], [ 'user@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = body.accounts as Record<string, unknown>[];
	t.is( 1, accounts.length, 'Empty row must not add an account' );
	t.is( accounts[ 0 ].service as string, 'SrvA' );
} );

test.serial( 'service name containing comma is returned intact', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	installMockSheets( t,
		[ [ 'Service name', 'u', 'p', 'l' ],
		  [ 'Email, Test', 'user@test.com', 'secret', '', 'user@test.com' ],
		],
		[ [ 'email' ], [ 'admin@test.com' ] ],
	);
	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = body.accounts as Record<string, unknown>[];
	t.is( 1, accounts.length );
	t.is( accounts[ 0 ].service as string, 'Email, Test', 'Comma in service name must be preserved' );
} );

	// ---------------------------------------------------------------------------
	// HTTP 500 Sheets error handling
	// ---------------------------------------------------------------------------

	test.serial( 'POST /api/login: account-sheet HTTP 500 returns generic 200 and logs safe error', async ( t ) => {
		const { transport }: ReturnType<typeof createFakeTransport> = createFakeTransport();
		const originalDispatcher: Dispatcher = getGlobalDispatcher();
		const mockAgent: MockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		const pool: ReturnType<MockAgent['get']> = mockAgent.get( 'https://docs.google.com' );
		// Accounts sheet returns 500
		pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=accounts/ } ).reply( 500, 'Internal Server Error', { headers: { 'Content-Type': 'text/plain' } } );
		// Admins sheet returns normal data
		pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=admins/ } ).reply( 200, 'email\nadmin@test.com', { headers: { 'Content-Type': 'text/csv' } } );
		setGlobalDispatcher( mockAgent );
		t.teardown( async(): Promise<void> => {
			setGlobalDispatcher( originalDispatcher );
			await mockAgent.close();
		} );

		const stream: PassThrough = _captureLoggerOutput( t );
		const config: Config = makeConfig();
		const backend: Backend = new Backend( config, transport );
		_backends.push( backend );

		let output: string = '';
		stream.on( 'data', ( chunk: Buffer ): void => {
			output += chunk.toString();
		} );

		const res: Response = await _backendRequest( backend, '/api/login', {
			method: 'POST',
			body: JSON.stringify( { email: 'admin@test.com' } ),
			headers: { 'Content-Type': 'application/json' },
		} );
		t.is( res.status, 200 );
		const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
		t.is( body.message, 'If your email is authorized, you have received a code.', 'Must return exact generic message' );
		t.true( 'number' === typeof body.next && isFinite( body.next as number ), 'Must include numeric next' );
		t.falsy( body.error, 'Must not have error field' );
		t.falsy( body.accounts, 'Must not have accounts field' );

		// Logger must contain safe error via _safeError (Error name)
		t.true( -1 !== output.indexOf( 'Login request failed: a***@***.com (Error)' ),
			'Log must contain safe error with masked email and Error name' );
		t.false( -1 !== output.indexOf( 'Failed to read sheet' ),
			'Log must NOT contain raw sheet error text' );
		t.false( -1 !== output.indexOf( 'HTTP 500' ),
			'Log must NOT contain HTTP 500' );
	} );

	// ---------------------------------------------------------------------------
	// ESOCKET cause label mapping
	// ---------------------------------------------------------------------------

	const _socketCauses: { token: string; label: string }[] = [
		{ token: 'ETIMEDOUT', label: 'timeout' },
		{ token: 'ENOTFOUND', label: 'dns-not-found' },
		{ token: 'ECONNRESET', label: 'connection-reset' },
		{ token: 'EPIPE', label: 'broken-pipe' },
		{ token: 'EHOSTUNREACH', label: 'host-unreachable' },
		{ token: 'ENETUNREACH', label: 'network-unreachable' },
	];

	for( const cause of _socketCauses ) {
		const token: string = cause.token;
		const label: string = cause.label;
		test.serial( `SMTP error ESOCKET with ${ token } logs cause=${ label }`, async ( t ) => {
			const stream: PassThrough = _captureLoggerOutput( t );
			installMockSheets( t,
				[ [ 'Service name', 'u', 'p', 'l' ], [ 'SrvA', 'uA', 'pA', '', 'admin@test.com' ] ],
				[ [ 'email' ], [ 'admin@test.com' ] ],
			);
			const config: Config = makeConfig();
			const throwingTransport: nodemailer.Transporter = {
				sendMail: async( _mailOptions: nodemailer.SendMailOptions ): Promise<unknown> => {
					const err: Error & { code?: string } = new Error( `connect ${ token } 203.0.113.1:587` );
					err.code = 'ESOCKET';
					throw err;
				},
			} as unknown as nodemailer.Transporter;
			const backend: Backend = new Backend( config, throwingTransport );
			_backends.push( backend );

			let output: string = '';
			stream.on( 'data', ( chunk: Buffer ): void => {
				output += chunk.toString();
			} );

			await _backendRequest( backend, '/api/login', {
				method: 'POST',
				body: JSON.stringify( { email: 'admin@test.com' } ),
				headers: { 'Content-Type': 'application/json' },
			} );

			t.true( -1 !== output.indexOf( `cause=${ label }` ),
				`ESOCKET with ${ token } must produce cause=${ label }` );
			t.false( -1 !== output.indexOf( token ),
				`Must NOT contain raw ${ token } sentinel in log` );
			t.false( -1 !== output.indexOf( '203.0.113.1' ),
				'Must NOT contain IP address from message' );
			t.false( -1 !== output.indexOf( 'admin@test.com' ),
				'Must NOT contain unmasked email' );
		} );
	}


	test.serial( 'CRLF-delimited CSV produces correct accounts without phantom rows', async ( t ) => {
	const { transport, sentMails }: ReturnType<typeof createFakeTransport> = createFakeTransport();
	const originalDispatcher: Dispatcher = getGlobalDispatcher();
	const mockAgent: MockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	const pool: ReturnType<MockAgent['get']> = mockAgent.get( 'https://docs.google.com' );
	// Raw CRLF CSV data (not using csvFromRows which uses \n)
	const crlfAccountsCsv: string = 'Service name,username,password,link\r\nSrvA,uA,pA,,user@test.com\r\nSrvB,uB,pB,,user@test.com\r\n';
	const crlfAdminsCsv: string = 'email\r\nadmin@test.com\r\n';
	pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=accounts/ } ).reply( 200, crlfAccountsCsv, { headers: { 'Content-Type': 'text/csv' } } );
	pool.intercept( { path: /\/spreadsheets\/d\/test123\/gviz\/tq\?.*sheet=admins/ } ).reply( 200, crlfAdminsCsv, { headers: { 'Content-Type': 'text/csv' } } );
	setGlobalDispatcher( mockAgent );
	t.teardown( async(): Promise<void> => {
		setGlobalDispatcher( originalDispatcher );
		await mockAgent.close();
	} );

	const backend: Backend = createTestBackend( transport );

	await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com' } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( sentMails.length, 1 );
	const pinText: string = sentMails[ 0 ].text;
	const match: Nullable<RegExpMatchArray> = pinText.match( /\b(\d{6})\b/ );
	t.truthy( match );
	const pin: string = match![ 1 ];

	const res: Response = await _backendRequest( backend, '/api/login', {
		method: 'POST',
		body: JSON.stringify( { email: 'user@test.com', pin } ),
		headers: { 'Content-Type': 'application/json' },
	} );
	t.is( res.status, 200 );
	const body: Record<string, unknown> = await res.json() as Record<string, unknown>;
	const accounts: Record<string, unknown>[] = body.accounts as Record<string, unknown>[];
	t.is( 2, accounts.length, 'CRLF CSV must produce 2 accounts, not 3 with phantom row' );
	t.is( accounts[ 0 ].service as string, 'SrvA' );
	t.is( accounts[ 1 ].service as string, 'SrvB' );
} );
