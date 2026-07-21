type Nullable<T> = T | null;
type Undefinedable<T> = T | undefined;

import jTDAL from '@stefanobalocco/jtdal';
import Myopie from '@stefanobalocco/myopie.js';
import router from '@stefanobalocco/jfsmrouter';

// ---------------------------------------------------------------------------
// App class
// ---------------------------------------------------------------------------

export class App {
	private static _renderEngine: jTDAL = new jTDAL();
	private static _templates: Record<string, ( data: Record<string, unknown> ) => string> = {
		'login': App._renderEngine.CompileToFunction( `
<div class="login-shell">
	<div class="login-panel">
		<div data-tdal-condition="isEmailStep" data-tdal-omittag="">
			<div class="step-label">PSPS <span class="step-progress">Step 1 of 2</span></div>
			<hr class="step-rule">
			<h2>Access your passwords.</h2>
			<p>Enter the email address approved for this vault.</p>
			<div data-tdal-condition="error" data-tdal-omittag="">
				<div class="error-banner" role="alert" aria-live="assertive" data-tdal-content="error"></div>
			</div>
			<form data-myopie="emailForm">
				<label for="login-email">Email address</label>
				<input type="email" id="login-email" name="email" autocomplete="email" spellcheck="false" required data-tdal-attributes="value email">
				<div data-tdal-condition="loading" data-tdal-omittag="">
					<button type="submit" class="button-primary" disabled>Sending…</button>
				</div>
				<div data-tdal-condition="notLoading" data-tdal-omittag="">
					<button type="submit" class="button-primary">Send access code</button>
				</div>
			</form>
		</div>
		<div data-tdal-condition="isPinStep" data-tdal-omittag="">
			<div class="step-label">PSPS <span class="step-progress">Step 2 of 2</span></div>
			<hr class="step-rule">
			<h2>Check your email.</h2>
			<p>Enter the 6-digit code sent to <strong data-tdal-content="maskedEmail"></strong>.</p>
			<button type="button" class="link-button" data-myopie="changeEmail">Change email</button>
			<div data-tdal-condition="error" data-tdal-omittag="">
				<div class="error-banner" role="alert" aria-live="assertive" data-tdal-content="error"></div>
			</div>
			<span data-tdal-condition="verifying" data-tdal-omittag="">
				<span role="status" aria-live="polite">Verifying&#8230;</span>
			</span>
			<form data-myopie="pinForm">
				<div class="otp-group" role="group" aria-label="6-digit verification code">
					<input type="text" id="login-pin-0" class="otp-input" name="otp-0" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" autocomplete="one-time-code" aria-label="Digit 1 of 6" data-myopie="pinDigit" data-index="0">
					<input type="text" id="login-pin-1" class="otp-input" name="otp-1" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" aria-label="Digit 2 of 6" data-myopie="pinDigit" data-index="1">
					<input type="text" id="login-pin-2" class="otp-input" name="otp-2" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" aria-label="Digit 3 of 6" data-myopie="pinDigit" data-index="2">
					<input type="text" id="login-pin-3" class="otp-input" name="otp-3" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" aria-label="Digit 4 of 6" data-myopie="pinDigit" data-index="3">
					<input type="text" id="login-pin-4" class="otp-input" name="otp-4" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" aria-label="Digit 5 of 6" data-myopie="pinDigit" data-index="4">
					<input type="text" id="login-pin-5" class="otp-input" name="otp-5" inputmode="numeric" pattern="[0-9]*" maxlength="1" spellcheck="false" autocapitalize="off" aria-label="Digit 6 of 6" data-myopie="pinDigit" data-index="5">
				</div>
				<button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Verify code</button>
			</form>
			<div class="resend-block">
				<div data-tdal-condition="resendDisabled" data-tdal-omittag="">
					<span class="resend-timer" id="resend-timer">Resend code in <span data-tdal-content="resendLabel"></span></span>
				</div>
				<div data-tdal-condition="resendEnabled" data-tdal-omittag="">
					<button type="button" class="link-button" data-myopie="resendPin">Resend code</button>
				</div>
			</div>
		</div>
	</div>
</div>` ),
		'accounts': App._renderEngine.CompileToFunction( `
<div class="accounts-list">
	<div data-tdal-repeat="account accounts" data-tdal-omittag="">
		<div class="card account-card">
			<div class="field-row">
				<span class="field-label">Service</span>
				<span class="field-value" data-tdal-content="account/service"></span>
			</div>
			<div class="field-row">
				<span class="field-label">Username</span>
				<span class="field-value" data-tdal-content="account/username"></span>
			</div>
			<div class="field-row">
				<span class="field-label">Password</span>
				<span class="field-value">
					<span class="password-masked" data-tdal-attributes="data-password account/password">********</span>
				</span>
				<span class="action-group">
					<button type="button" class="icon-button" data-myopie="togglePassword" aria-label="Show password">
						<svg class="icon-show" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
						<svg class="icon-hide" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>
					</button>
					<button type="button" class="icon-button" data-myopie="copyPassword" aria-label="Copy password">
						<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
					</button>
				</span>
			</div>
			<div class="field-row">
				<span class="field-label">Link</span>
				<div data-tdal-condition="account/isExternalLink" data-tdal-omittag="">
					<span class="field-value link-external">
						<span data-tdal-content="account/linkDisplay"></span>
					</span>
					<span class="action-group">
						<a data-tdal-attributes="href account/link" target="_blank" rel="noopener" aria-label="Open link in new tab" class="icon-button">
							<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
							<span class="sr-only">opens in a new tab</span>
						</a>
					</span>
				</div>
				<div data-tdal-condition="account/isInlineLink" data-tdal-omittag="">
					<span class="field-value">
						<span data-tdal-content="account/linkDisplay"></span>
					</span>
				</div>
			</div>
		</div>
	</div>
	<div data-tdal-condition="empty" data-tdal-omittag="">
		<p class="text-center">No accounts found.</p>
	</div>
</div>` )
	};

	private _myopie: Myopie;
	private _resendInterval: Undefinedable<number>;
	private _isVerifying: boolean = false;
	private _resendNext: number = 0;

	public constructor() {
		const initialData: Record<string, unknown> = {
			page: 'login',
			step: 'email',
			email: '',
			pin: '',
			loading: false,
			error: '',
			accounts: [],
			resendDisabled: true,
			resendLabel: '1:00'
		};

		this._myopie = new Myopie( '#app', App._renderView, initialData, [], 0 );

		this._myopie.handlersPermanentAdd( '[data-myopie="emailForm"]', 'submit', this._handleEmailSubmit.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="pinForm"]', 'submit', this._handlePinSubmit.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="changeEmail"]', 'click', this._handleChangeEmail.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="pinDigit"]', 'input', this._handlePinDigitInput.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="pinDigit"]', 'keydown', this._handlePinDigitKeyDown.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="pinDigit"]', 'paste', this._handlePinDigitPaste.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="pinDigit"]', 'focus', this._handlePinDigitFocus.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="resendPin"]', 'click', this._handleResendPin.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="togglePassword"]', 'click', this._handleTogglePassword.bind( this ) );
		this._myopie.handlersPermanentAdd( '[data-myopie="copyPassword"]', 'click', this._handleCopyPassword.bind( this ) );

		router.stateAdd( 'app' );

		router.routeAdd(
			'app',
			'/login',
			(): void => {
				this._myopie.set( 'page', 'login', false );
				this._myopie.render();
			},
			(): boolean => {
				return true;
			},
			(): void => {
				// no redirect from login
			}
		);

		router.routeAdd(
			'app',
			'/accounts',
			(): void => {
				this._myopie.set( 'page', 'accounts', false );
				this._myopie.render();
			},
			(): boolean => {
				return 0 < ( this._myopie.get( 'accounts' ) as Record<string, unknown>[] ).length;
			},
			(): void => {
				router.trigger( '/login' );
			}
		);

		router.routeSpecialAdd( 404, (): void => {
			router.trigger( '/login' );
		} );
	}

	public async start(): Promise<void> {
		const routePath: string = ( window.location.hash.startsWith( '#' ) && 1 < window.location.hash.length )
			? window.location.hash.substring( 1 )
			: '/login';
		await router.route( routePath );
	}

	private static _maskEmail( email: string ): string {
		let returnValue: string;
		const atIndex: number = email.indexOf( '@' );
		if( '' !== email && -1 !== atIndex ) {
			const localPart: string = email.substring( 0, atIndex );
			const domainPart: string = email.substring( atIndex + 1 );
			const dotIndex: number = domainPart.lastIndexOf( '.' );
			if( -1 !== dotIndex && dotIndex + 1 < domainPart.length ) {
				const tld: string = domainPart.substring( dotIndex );
				const firstChar: string = 0 < localPart.length ? localPart[ 0 ] : '';
				returnValue = `${ firstChar }***@***${ tld }`;
			} else {
				returnValue = email;
			}
		} else {
			returnValue = email;
		}
		return returnValue;
	}

	private static _renderView( state: Record<string, unknown> ): string {
		const page: string = state.page as string;
		let content: string = '<p>Loading...</p>';
		switch( page ) {
			case 'login': {
				const step: string = state.step as string;
				const pin: string = state.pin as string;
				const isEmailStep: boolean = ( 'email' === step );
				const isPinStep: boolean = ( 'pin' === step );
				const resendDisabled: boolean = state.resendDisabled as boolean;
				const loading: boolean = state.loading as boolean;
				const email: string = state.email as string;
				const maskedEmail: string = App._maskEmail( email );

				const data: Record<string, unknown> = {
					email: email,
					maskedEmail: maskedEmail,
					error: state.error as string,
					loading: loading,
					notLoading: !loading,
					isEmailStep: isEmailStep,
					isPinStep: isPinStep,
					resendDisabled: resendDisabled,
					resendEnabled: !resendDisabled,
					resendLabel: state.resendLabel as string,
					verifying: ( 'pin' === step && loading ),
					pin: pin
				};

				content = App._templates[ 'login' ]( data );
				break;
			}
			case 'accounts': {
				const accountsArr: Record<string, unknown>[] = state.accounts as Record<string, unknown>[];
				const accounts: Record<string, unknown>[] = accountsArr.map(
					( account: Record<string, unknown> ): Record<string, unknown> => {
						const link: string = 'string' === typeof account.link ? String( account.link ) : '';
						const linkStr: string = String( link );
						const isExternalLink: boolean = ( linkStr.startsWith( 'http://' ) || linkStr.startsWith( 'https://' ) );
						const isInlineLink: boolean = !isExternalLink;
						const linkDisplay: string = '' !== linkStr ? linkStr : 'No link provided';
						return {
							...account,
							link: linkStr,
							isExternalLink: isExternalLink,
							isInlineLink: isInlineLink,
							linkDisplay: linkDisplay
						};
					}
				);

				const data: Record<string, unknown> = {
					accounts: accounts,
					empty: 0 === accounts.length
				};

				content = App._templates[ 'accounts' ]( data );
				break;
			}
		}

		return content;
	}

	private _startResendTimer(): void {
		this._stopResendTimer();
		const now: number = Date.now();
		const remaining: number = Math.max( 0, Math.floor( ( this._resendNext - now ) / 1000 ) );
		this._myopie.set( 'resendDisabled', true, false );
		this._myopie.set( 'resendLabel', this._formatTimer( remaining ), true );

		this._resendInterval = window.setInterval( (): void => {
			this._updateResendRemaining();
		}, 1000 );
	}

	private _stopResendTimer(): void {
		if( undefined !== this._resendInterval ) {
			clearInterval( this._resendInterval );
			this._resendInterval = undefined;
		}
	}

	private _updateResendRemaining(): void {
		const now: number = Date.now();
		const remaining: number = Math.max( 0, Math.floor( ( this._resendNext - now ) / 1000 ) );
		const timerEl: Nullable<HTMLElement> = document.getElementById( 'resend-timer' ) as Nullable<HTMLElement>;

		if( 0 >= remaining ) {
			this._stopResendTimer();
			this._myopie.set( 'resendDisabled', false, false );
			this._myopie.set( 'resendLabel', '', true );
			if( 'pin' === ( this._myopie.get( 'step' ) as string ) ) {
				this._restorePinFocus();
			}
		} else {
			if( null !== timerEl ) {
				timerEl.textContent = `Resend code in ${ this._formatTimer( remaining ) }`;
			}
		}
	}

	private _formatTimer( seconds: number ): string {
		const min: number = Math.floor( seconds / 60 );
		const sec: number = seconds % 60;
		return `${ min }:${ 10 > sec ? '0' : '' }${ sec }`;
	}

	private _getPinInputs(): HTMLInputElement[] {
		const returnValue: HTMLInputElement[] = [];
		const cL1: number = 6;
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			const input: Nullable<HTMLInputElement> = document.getElementById( `login-pin-${ iL1 }` ) as Nullable<HTMLInputElement>;
			if( null !== input ) {
				returnValue.push( input );
			}
		}
		return returnValue;
	}

	private _syncPinFromInputs(): string {
		const inputs: HTMLInputElement[] = this._getPinInputs();
		const cL1: number = inputs.length;
		const digits: string[] = [];
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			const raw: string = inputs[ iL1 ].value;
			const digit: string = raw.replace( /\D/g, '' ).slice( 0, 1 );
			inputs[ iL1 ].value = digit;
			digits.push( digit );
		}
		const combined: string = digits.join( '' );
		this._myopie.set( 'pin', combined, false );
		return combined;
	}

	private _replacePinDigits( digits: string ): void {
		const clean: string = digits.replace( /\D/g, '' ).slice( 0, 6 );
		const inputs: HTMLInputElement[] = this._getPinInputs();
		const cL1: number = Math.min( inputs.length, clean.length );
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			inputs[ iL1 ].value = clean[ iL1 ];
		}
		const cL2: number = inputs.length;
		for( let iL1: number = cL1; iL1 < cL2; iL1++ ) {
			inputs[ iL1 ].value = '';
		}
		this._syncPinFromInputs();
	}

	private _clearPinInputs(): void {
		const inputs: HTMLInputElement[] = this._getPinInputs();
		const cL1: number = inputs.length;
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			inputs[ iL1 ].value = '';
		}
		this._myopie.set( 'pin', '', false );
	}

	private _focusPinInput( index: number ): void {
		if( 0 <= index && 5 >= index ) {
			const input: Nullable<HTMLInputElement> = document.getElementById( `login-pin-${ index }` ) as Nullable<HTMLInputElement>;
			if( null !== input ) {
				input.focus();
				input.select();
			}
		}
	}

	private _restorePinFocus(): void {
		const inputs: HTMLInputElement[] = this._getPinInputs();
		const cL1: number = inputs.length;
		let candidate: number = cL1 - 1;
		let foundEmpty: boolean = false;
		for( let iL1: number = 0; iL1 < cL1; iL1++ ) {
			if( !foundEmpty && '' === inputs[ iL1 ].value ) {
				candidate = iL1;
				foundEmpty = true;
			}
		}
		if( 0 < cL1 ) {
			this._focusPinInput( candidate );
		}
	}

	private async _verifyPin(): Promise<void> {
		const pin: string = this._myopie.get( 'pin' ) as string;
		if( 6 <= pin.length && !this._isVerifying ) {
			this._isVerifying = true;
			this._myopie.set( 'loading', true, true );

			try {
				const email: string = this._myopie.get( 'email' ) as string;
				const response: Response = await fetch( '/api/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( { email, pin } )
				} );
				const body: { accounts?: Record<string, unknown>[]; error?: string; reset?: boolean; next?: unknown } = await response.json();

				if( response.ok && body.accounts ) {
					this._stopResendTimer();
					this._clearPinInputs();
					this._myopie.set( 'accounts', body.accounts, false );
					this._myopie.set( 'error', '', false );
					this._myopie.set( 'loading', false, false );
					this._isVerifying = false;
					this._myopie.render();
					router.trigger( '/accounts' );
				} else if( body.reset ) {
					this._stopResendTimer();
					this._clearPinInputs();
					this._myopie.set( 'step', 'email', false );
					this._myopie.set( 'accounts', [], false );
					this._myopie.set( 'error', body.error || 'Invalid or expired PIN.', false );
					this._myopie.set( 'loading', false, false );
					this._isVerifying = false;
					this._myopie.render();
					const emailInput: Nullable<HTMLInputElement> = document.getElementById( 'login-email' ) as Nullable<HTMLInputElement>;
					if( null !== emailInput ) {
						emailInput.focus();
					}
				} else {
					this._clearPinInputs();
					this._myopie.set( 'error', body.error || 'Invalid or expired PIN.', false );
					this._myopie.set( 'loading', false, true );
					this._isVerifying = false;
					this._focusPinInput( 0 );
				}
			} catch( _err: unknown ) {
				this._clearPinInputs();
				this._myopie.set( 'error', 'Connection error. Try again.', false );
				this._myopie.set( 'loading', false, true );
				this._isVerifying = false;
				this._focusPinInput( 0 );
			}
		}
	}

	private _handleEmailSubmit( event: Event ): void {
		event.preventDefault();
		const loading: boolean = this._myopie.get( 'loading' ) as boolean;
		if( !loading ) {
			const emailInput: Nullable<HTMLInputElement> = document.getElementById( 'login-email' ) as Nullable<HTMLInputElement>;

			if( null !== emailInput && '' !== emailInput.value.trim() ) {
				void this._doEmailRequest( emailInput.value.trim() );
			} else {
				this._myopie.set( 'error', 'Enter a valid email address.', false );
			}
		}
	}

	private async _doEmailRequest( rawEmail: string ): Promise<void> {
		this._myopie.set( 'loading', true, false );
		this._myopie.set( 'error', '', false );
		let nextValue: unknown = undefined;
		let success: boolean = false;

		try {
			const response: Response = await fetch( '/api/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { email: rawEmail } )
			} );
			if( response.ok ) {
				const body: { error?: string; next?: unknown } = await response.json();
				nextValue = body.next;
				this._myopie.set( 'email', rawEmail.trim().toLowerCase(), false );
				this._myopie.set( 'step', 'pin', false );
				success = true;
			} else {
				this._myopie.set( 'error', 'Error requesting code.', false );
			}
		} catch( _err: unknown ) {
			this._myopie.set( 'error', 'Connection error. Try again.', false );
		}

		this._myopie.set( 'loading', false, true );

		if( success ) {
			const next: unknown = nextValue;
			if( 'number' === typeof next && isFinite( next ) && next > Date.now() ) {
				this._resendNext = next;
			} else {
				this._resendNext = Date.now() + 60_000;
			}
			this._startResendTimer();
			this._focusPinInput( 0 );
		}
	}

	private _handlePinSubmit( event: Event ): void {
		event.preventDefault();
		void this._verifyPin();
	}

	private _handlePinDigitInput( event: Event ): void {
		const target: Nullable<HTMLInputElement> = event.currentTarget as Nullable<HTMLInputElement>;
		if( null !== target ) {
			const indexStr: Nullable<string> = target.getAttribute( 'data-index' );
			if( null !== indexStr ) {
				const index: number = parseInt( indexStr, 10 );
				const rawValue: string = target.value;
				const sanitized: string = rawValue.replace( /\D/g, '' );

				// Normal digit input
				if( 1 >= sanitized.length ) {
					target.value = sanitized.slice( 0, 1 );
					const digits: string = this._syncPinFromInputs();
					if( '' !== sanitized && 5 > index ) {
						this._focusPinInput( index + 1 );
					}
					if( 6 === digits.length ) {
						void this._verifyPin();
					}
				} else {
					// Browser autofill / multi-digit paste-in-place
					this._replacePinDigits( sanitized );
					const digits: string = this._myopie.get( 'pin' ) as string;
					if( 6 === digits.length ) {
						void this._verifyPin();
					}
				}
			}
		}
	}

	private _handlePinDigitKeyDown( event: Event ): void {
		const keyboardEvent: KeyboardEvent = event as KeyboardEvent;
		const target: Nullable<HTMLInputElement> = event.currentTarget as Nullable<HTMLInputElement>;
		if( null !== target ) {
			const indexStr: Nullable<string> = target.getAttribute( 'data-index' );
			if( null !== indexStr ) {
				const index: number = parseInt( indexStr, 10 );
				const key: string = keyboardEvent.key;

				if( 'ArrowLeft' === key ) {
					keyboardEvent.preventDefault();
					if( 0 < index ) {
						this._focusPinInput( index - 1 );
					}
				} else if( 'ArrowRight' === key ) {
					keyboardEvent.preventDefault();
					if( 5 > index ) {
						this._focusPinInput( index + 1 );
					}
				} else if( 'Backspace' === key && '' === target.value && 0 < index ) {
					keyboardEvent.preventDefault();
					this._focusPinInput( index - 1 );
					( document.getElementById( `login-pin-${ index - 1 }` ) as Nullable<HTMLInputElement> )!.value = '';
					this._syncPinFromInputs();
				}
			}
		}
	}

	private _handlePinDigitPaste( event: Event ): void {
		const clipboardEvent: ClipboardEvent = event as ClipboardEvent;
		clipboardEvent.preventDefault();
		const pasted: string = ( clipboardEvent.clipboardData?.getData( 'text' ) ) || '';
		const digits: string = pasted.replace( /\D/g, '' ).slice( 0, 6 );

		if( '' !== digits ) {
			this._replacePinDigits( digits );
			const combined: string = this._myopie.get( 'pin' ) as string;
			if( 6 === combined.length ) {
				void this._verifyPin();
			} else {
				this._restorePinFocus();
			}
		}
	}

	private _handlePinDigitFocus( event: Event ): void {
		// Select existing content on focus for easy overwrite
		const target: Nullable<HTMLInputElement> = event.currentTarget as Nullable<HTMLInputElement>;
		if( null !== target ) {
			target.select();
		}
	}

	private _handleChangeEmail( _event: Event ): void {
		this._stopResendTimer();
		this._clearPinInputs();
		this._myopie.set( 'step', 'email', false );
		this._myopie.set( 'error', '', false );
		this._myopie.set( 'loading', false, true );
		const emailInput: Nullable<HTMLInputElement> = document.getElementById( 'login-email' ) as Nullable<HTMLInputElement>;
		if( null !== emailInput ) {
			emailInput.focus();
		}
	}

	private async _handleResendPin( _event: Event ): Promise<void> {
		const disabled: boolean = this._myopie.get( 'resendDisabled' ) as boolean;
		const email: string = this._myopie.get( 'email' ) as string;

		if( !disabled && '' !== email ) {
			try {
				this._stopResendTimer();
				const response: Response = await fetch( '/api/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( { email } )
				} );
				if( response.ok ) {
					const body: { next?: unknown } = await response.json();
					const next: unknown = body.next;
					if( 'number' === typeof next && isFinite( next ) && next > Date.now() ) {
						this._resendNext = next;
					} else {
						this._resendNext = Date.now() + 60_000;
					}
					this._clearPinInputs();
					this._myopie.set( 'error', '', false );
					this._isVerifying = false;
					this._startResendTimer();
				} else {
					this._myopie.set( 'error', 'Error requesting code.', false );
				}
			} catch( _err: unknown ) {
				this._myopie.set( 'error', 'Connection error. Try again.', false );
			}
		}
	}

	private _handleTogglePassword( event: Event ): void {
		const button: Nullable<EventTarget & HTMLElement> = event.currentTarget as Nullable<EventTarget & HTMLElement>;
		if( null !== button ) {
			const card: Nullable<HTMLElement> = button.closest( '.account-card' ) as Nullable<HTMLElement>;
			if( null !== card ) {
				const passwordSpan: Nullable<HTMLSpanElement> = card.querySelector( '[data-password]' ) as Nullable<HTMLSpanElement>;
				if( null !== passwordSpan ) {
					const rawPassword: string = passwordSpan.getAttribute( 'data-password' ) || '';
					const isRevealed: boolean = button.classList.contains( 'is-revealed' );
					if( isRevealed ) {
						passwordSpan.textContent = '********';
						passwordSpan.className = 'password-masked';
						button.classList.remove( 'is-revealed' );
						button.setAttribute( 'aria-label', 'Show password' );
					} else {
						passwordSpan.textContent = rawPassword;
						passwordSpan.className = 'password-revealed';
						button.classList.add( 'is-revealed' );
						button.setAttribute( 'aria-label', 'Hide password' );
					}
				}
			}
		}
	}

	private async _handleCopyPassword( event: Event ): Promise<void> {
		const button: Nullable<EventTarget & HTMLElement> = event.currentTarget as Nullable<EventTarget & HTMLElement>;
		if( null !== button ) {
			const card: Nullable<HTMLElement> = button.closest( '.account-card' ) as Nullable<HTMLElement>;
			if( null !== card ) {
				const passwordSpan: Nullable<HTMLSpanElement> = card.querySelector( '[data-password]' ) as Nullable<HTMLSpanElement>;
				if( null !== passwordSpan ) {
					const rawPassword: string = passwordSpan.getAttribute( 'data-password' ) || '';
					try {
						await navigator.clipboard.writeText( rawPassword );
					} catch( _err: unknown ) {
						// Clipboard API might not be available
					}
				}
			}
		}
	}
}

export const app: App = new App();
await app.start();
