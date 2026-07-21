import { createRequire } from 'node:module';
import test from 'ava';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import jTDAL from '@stefanobalocco/jtdal';
// ponytail: jsdom ships no types; inline-cast via createRequire
const _require = createRequire(import.meta.url);
const { JSDOM } = _require('jsdom');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ---------------------------------------------------------------------------
// Helper: extract template string from frontend source
// ---------------------------------------------------------------------------
function extractTemplate(templateKey) {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const regex = new RegExp(`'${templateKey}':[^\`]*\`([\\s\\S]*?)\``);
    const match = regex.exec(source);
    if (null === match) {
        throw new Error(`Could not extract template "${templateKey}" from templates in frontend/src/app.ts`);
    }
    return match[1];
}
const accountsTemplate = extractTemplate('accounts');
const loginTemplate = extractTemplate('login');
// ---------------------------------------------------------------------------
// Build output verification — exact www contents
// ---------------------------------------------------------------------------
test('www/ contains exactly app.min.js, index.html, style.css (no extra files)', (t) => {
    const wwwPath = path.resolve(__dirname, '../../www');
    const entries = fs.readdirSync(wwwPath).sort();
    t.deepEqual(entries, ['app.min.js', 'index.html', 'style.css'], 'www/ must contain exactly app.min.js, index.html, style.css — no fourth file is allowed');
});
test('www/app.min.js exists and no raw app.js or psps.js exists', (t) => {
    const wwwPath = path.resolve(__dirname, '../../www');
    t.true(fs.existsSync(path.resolve(wwwPath, 'app.min.js')), 'www/app.min.js must exist');
    t.false(fs.existsSync(path.resolve(wwwPath, 'app.js')), 'www/app.js must NOT exist');
    t.false(fs.existsSync(path.resolve(wwwPath, 'psps.js')), 'www/psps.js must NOT exist');
});
test('www has no .d.ts and no .map files', (t) => {
    const wwwPath = path.resolve(__dirname, '../../www');
    const entries = fs.readdirSync(wwwPath);
    t.false(entries.some((e) => e.endsWith('.d.ts')), 'www must not contain .d.ts files');
    t.false(entries.some((e) => e.endsWith('.map')), 'www must not contain .map files');
});
test('www/style.css exists and www/styles.css does not', (t) => {
    const wwwPath = path.resolve(__dirname, '../../www');
    t.true(fs.existsSync(path.resolve(wwwPath, 'style.css')), 'www/style.css must exist');
    t.false(fs.existsSync(path.resolve(wwwPath, 'styles.css')), 'www/styles.css must NOT exist');
});
test('generated www/index.html exists', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    t.true(fs.existsSync(indexPath), 'www/index.html must exist after build');
});
test('www/index.html declares English document language', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('<html lang="en">'), 'www/index.html must declare lang="en"');
    t.false(-1 !== html.indexOf('<html lang="it">'), 'www/index.html must not declare lang="it"');
});
test('www/index.html contains app.min.js? with digits for cache busting', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    const match = html.match(/app\.min\.js\?(\d+)/);
    t.truthy(match, 'www/index.html must contain app.min.js?<digits>');
    t.true(/^\d+$/.test(match[1]), 'Cache busting value must be digits');
});
test('www/index.html contains style.css? with digits for cache busting', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    const match = html.match(/style\.css\?(\d+)/);
    t.truthy(match, 'www/index.html must contain style.css?<digits>');
    t.true(/^\d+$/.test(match[1]), 'Cache busting value must be digits');
});
test('www/index.html has no data-tdal attributes', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.false(-1 !== html.indexOf('data-tdal-attributes'), 'www/index.html must not contain data-tdal-attributes');
});
test('www/index.html has no stale placeholder patterns', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.false(-1 !== html.indexOf('{{ stylesHref }}'), 'Must not contain {{ stylesHref }} placeholder');
    t.false(-1 !== html.indexOf('{{ appScriptSrc }}'), 'Must not contain {{ appScriptSrc }} placeholder');
});
test('www/app.min.js contains App module export and start call', (t) => {
    const appMinJsPath = path.resolve(__dirname, '../../www/app.min.js');
    const content = fs.readFileSync(appMinJsPath, 'utf-8');
    t.true(-1 !== content.indexOf('class App') || -1 !== content.indexOf('export class App'), 'www/app.min.js must contain App class');
    t.true(-1 !== content.indexOf('.start('), 'www/app.min.js must call .start()');
});
test('www/index.html has no legacy script or style references', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.false(-1 !== html.indexOf('app.js'), 'Must not reference app.js (must be app.min.js)');
    t.false(-1 !== html.indexOf('styles.css'), 'Must not reference styles.css (must be style.css)');
    t.false(-1 !== html.indexOf('psps.js'), 'Must not reference psps.js');
});
// ---------------------------------------------------------------------------
// Source-level structural tests
// ---------------------------------------------------------------------------
test('frontend source is app.ts; psps.ts does not exist', (t) => {
    const appSourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const pspsSourcePath = path.resolve(__dirname, '../../frontend/src/psps.ts');
    t.true(fs.existsSync(appSourcePath), 'frontend/src/app.ts must exist');
    t.false(fs.existsSync(pspsSourcePath), 'frontend/src/psps.ts must NOT exist');
});
test('app.ts exports class App', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/export\s+class\s+App\b/.test(src), 'app.ts must export class App');
    t.false(/export\s+class\s+PSPS\b/.test(src), 'app.ts must NOT export class PSPS');
});
test('app.ts has no import from ./psps.js', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.false(/from\s+['"]\.\/psps\.js['"]/.test(src), 'app.ts must not import from ./psps.js');
});
test('app.ts has bootstrap export with new App() and await app.start()', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/export\s+const\s+app\s*:\s*App\s*=/.test(src), 'app.ts must export const app: App =');
    t.true(/new\s+App\s*\(\)/.test(src), 'app.ts must instantiate new App()');
    t.true(/await\s+app\.start\s*\(\)/.test(src), 'app.ts must await app.start()');
});
test('app.ts uses App static references (not PSPS)', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    const codeOnly = src.replace(/`[^`]*`/g, ''); // Remove template literals which contain brand text
    t.false(/\bPSPS\b/.test(codeOnly), 'app.ts code must not contain PSPS identifier (only allowed in template brand text)');
});
test('app.ts default-imports Myopie and jFSMRouter with no @ts-expect-error', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/import\s+Myopie\s+from\s+['"]@stefanobalocco\/myopie\.js['"]/.test(src), 'Myopie must be a default import');
    t.true(/import\s+router\s+from\s+['"]@stefanobalocco\/jfsmrouter['"]/.test(src), 'jfsmrouter must be a default import as router');
    t.false(/@ts-expect-error/.test(src), 'app.ts must not contain @ts-expect-error');
    t.false(/import\s*\{\s*Myopie\s*\}/.test(src), 'app.ts must not use named import for Myopie');
    t.false(/import\s*\{\s*jFSMRouter\s*\}/.test(src), 'app.ts must not use named import for jFSMRouter');
});
test('app.ts never constructs jFSMRouter; uses singleton directly', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.false(/new\s+jFSMRouter/.test(src), 'app.ts must not construct jFSMRouter');
    t.false(/new\s+Myopie\(\s*\{/.test(src), 'app.ts must not construct Myopie with a config object');
});
test('app.ts uses Myopie get/set and handlersPermanentAdd', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/\.get\s*\(/.test(src), 'app.ts must use myopie.get');
    t.true(/\.set\s*\(/.test(src), 'app.ts must use myopie.set');
    t.true(/handlersPermanentAdd/.test(src), 'app.ts must use handlersPermanentAdd');
});
test('app.ts uses jFSMRouter camelCase methods and trigger', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/\.stateAdd\s*\(/.test(src), 'app.ts must use stateAdd');
    t.true(/\.routeAdd\s*\(/.test(src), 'app.ts must use routeAdd');
    t.true(/\.trigger\s*\(/.test(src), 'app.ts must use trigger');
    t.false(/\.navigate\s*\(/.test(src), 'app.ts must not use .navigate');
    t.false(/\bStateAdd\b/.test(src), 'app.ts must not use PascalCase StateAdd');
    t.false(/\bRouteAdd\b/.test(src), 'app.ts must not use PascalCase RouteAdd');
    t.false(/\bTrigger\b/.test(src), 'app.ts must not use PascalCase Trigger');
});
test('app.ts reads data-index and data-row from currentTarget', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(/currentTarget/.test(src), 'app.ts must read from currentTarget');
    t.false(/data\?\.index/.test(src), 'app.ts must not use old data?.index pattern');
    t.false(/data\?\.row/.test(src), 'app.ts must not use old data?.row pattern');
});
test('index.html importmap resolves to scoped packages with @latest versions', (t) => {
    const indexPath = path.resolve(__dirname, '../../frontend/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('@stefanobalocco/jfsmrouter'), 'importmap must use @stefanobalocco/jfsmrouter');
    t.true(-1 !== html.indexOf('@stefanobalocco/myopie.js@latest'), 'importmap must use @stefanobalocco/myopie.js@latest');
    t.true(-1 !== html.indexOf('@stefanobalocco/jtdal@latest'), 'importmap must use @stefanobalocco/jtdal@latest');
    t.false(-1 !== html.indexOf('jfsmrouter@1.1.5'), 'importmap must not use old jfsmrouter 1.1.5');
    t.false(-1 !== html.indexOf('.min.mjs'), 'importmap must not use .min.mjs');
    t.false(-1 !== html.indexOf('"jtdal":'), 'importmap must not use bare jtdal key');
});
// ---------------------------------------------------------------------------
// Login template checks
// ---------------------------------------------------------------------------
test('login template has no opacity-0 hidden input, pin-display, arrow-btn, or bottom-well', (t) => {
    t.false(-1 !== loginTemplate.indexOf('opacity: 0'), 'login template must not have opacity-0');
    t.false(-1 !== loginTemplate.indexOf('pin-display'), 'login template must not have pin-display');
    t.false(-1 !== loginTemplate.indexOf('arrow-btn'), 'login template must not have arrow-btn');
    t.false(-1 !== loginTemplate.indexOf('bottom-well'), 'login template must not have bottom-well');
    t.false(-1 !== loginTemplate.indexOf('pin-input'), 'login template must not have old pin-input class');
});
test('login template contains six explicit OTP input fields', (t) => {
    for (let iL1 = 0; iL1 < 6; iL1++) {
        t.true(-1 !== loginTemplate.indexOf(`login-pin-${iL1}`), `login template must contain login-pin-${iL1}`);
        t.true(-1 !== loginTemplate.indexOf(`data-index="${iL1}"`), `login template must contain data-index="${iL1}"`);
        t.true(-1 !== loginTemplate.indexOf(`name="otp-${iL1}"`), `login template must contain name="otp-${iL1}"`);
        t.true(-1 !== loginTemplate.indexOf(`aria-label="Digit ${iL1 + 1} of 6"`), `login template must contain aria-label for digit ${iL1 + 1}`);
    }
});
test('login template OTP fields have correct attributes', (t) => {
    t.true(-1 !== loginTemplate.indexOf('inputmode="numeric"'), 'OTP fields must have numeric inputmode');
    t.true(-1 !== loginTemplate.indexOf('pattern="[0-9]*"'), 'OTP fields must have digit pattern');
    t.true(-1 !== loginTemplate.indexOf('maxlength="1"'), 'OTP fields must have maxlength=1');
    t.true(-1 !== loginTemplate.indexOf('spellcheck="false"'), 'OTP fields must have spellcheck off');
    t.true(-1 !== loginTemplate.indexOf('autocapitalize="off"'), 'OTP fields must have autocapitalize off');
});
test('login template first OTP has autocomplete one-time-code, others do not', (t) => {
    t.true(-1 !== loginTemplate.indexOf('autocomplete="one-time-code"'), 'First OTP input must have autocomplete one-time-code');
    // Check that login-pin-1 through login-pin-5 don't have autocomplete
    const cL1 = 6;
    for (let iL1 = 1; iL1 < cL1; iL1++) {
        const fieldId = `login-pin-${iL1}`;
        const fieldStart = loginTemplate.indexOf(fieldId);
        const beforeField = loginTemplate.substring(Math.max(0, fieldStart - 80), fieldStart);
        t.false(-1 !== beforeField.indexOf('autocomplete'), `OTP field ${iL1} must not have autocomplete attribute`);
    }
});
test('login template OTP group has role and aria-label', (t) => {
    t.true(-1 !== loginTemplate.indexOf('role="group"'), 'OTP wrapper must have role=group');
    t.true(-1 !== loginTemplate.indexOf('aria-label="6-digit verification code"'), 'OTP wrapper must have aria-label');
});
test('login template has sr-only Verify button', (t) => {
    t.true(-1 !== loginTemplate.indexOf('class="sr-only"'), 'Login must contain sr-only element');
    t.true(-1 !== loginTemplate.indexOf('Verify code'), 'Login must contain visually-hidden verify button');
    t.true(-1 !== loginTemplate.indexOf('type="submit"'), 'SR-only button must be type=submit');
});
test('login template uses English guided copy', (t) => {
    t.true(-1 !== loginTemplate.indexOf('Step 1 of 2'), 'Login must show Step 1 of 2');
    t.true(-1 !== loginTemplate.indexOf('Step 2 of 2'), 'Login must show Step 2 of 2');
    t.true(-1 !== loginTemplate.indexOf('Access your passwords'), 'Login must show heading');
    t.true(-1 !== loginTemplate.indexOf('Enter the email address approved for this vault'), 'Login must show email subtitle');
    t.true(-1 !== loginTemplate.indexOf('Check your email'), 'Login must show PIN heading');
    t.true(-1 !== loginTemplate.indexOf('Enter the 6-digit code sent to'), 'Login must show PIN instructions');
    t.true(-1 !== loginTemplate.indexOf('Send access code'), 'Login must have email submit text');
    t.true(-1 !== loginTemplate.indexOf('Change email'), 'Login must have change email link');
    t.true(-1 !== loginTemplate.indexOf('Resend code'), 'Login must have resend text');
    t.true(-1 !== loginTemplate.indexOf('Sending'), 'Login must have Sending... status');
    t.true(-1 !== loginTemplate.indexOf('Verifying'), 'Login must have Verifying... status');
});
test('login template has no old auth endpoints', (t) => {
    t.false(-1 !== loginTemplate.indexOf('/api/auth/'), 'Login template must not reference /api/auth/');
    t.false(-1 !== loginTemplate.indexOf('/api/status'), 'Login template must not reference /api/status');
    t.false(-1 !== loginTemplate.indexOf('sharing'), 'Login template must not reference sharing');
});
test('login template has semantic form elements', (t) => {
    t.true(-1 !== loginTemplate.indexOf('data-myopie="emailForm"'), 'Login must have email form handler');
    t.true(-1 !== loginTemplate.indexOf('data-myopie="pinForm"'), 'Login must have PIN form handler');
    t.true(-1 !== loginTemplate.indexOf('<form'), 'Login must use form elements');
    t.true(-1 !== loginTemplate.indexOf('label for="login-email"'), 'Login must have email label');
    t.true(-1 !== loginTemplate.indexOf('required'), 'Email input must be required');
    t.true(-1 !== loginTemplate.indexOf('role="alert"'), 'Error must have role=alert');
    t.true(-1 !== loginTemplate.indexOf('aria-live="assertive"'), 'Error must have assertive live region');
});
// ---------------------------------------------------------------------------
// Source does not contain forbidden strings
// ---------------------------------------------------------------------------
test('app.ts does not contain Set-Cookie, role, spreadsheetId, or spreadsheetUrl in state', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.false(-1 !== src.indexOf('Set-Cookie'), 'app.ts must not contain Set-Cookie');
    t.false(-1 !== src.indexOf('spreadsheetId'), 'app.ts must not contain spreadsheetId');
    t.false(-1 !== src.indexOf('spreadsheetUrl'), 'app.ts must not contain spreadsheetUrl');
    t.false(-1 !== src.indexOf('spreadsheetURL'), 'app.ts must not contain spreadsheetURL');
});
test('app.ts does not contain /api/auth/, /api/status, /api/accounts, /api/sharing', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.false(-1 !== src.indexOf('/api/auth/'), 'app.ts must not reference /api/auth/');
    t.false(-1 !== src.indexOf('/api/status'), 'app.ts must not reference /api/status');
    t.false(-1 !== src.indexOf('/api/accounts'), 'app.ts must not reference /api/accounts');
    t.false(-1 !== src.indexOf('/api/sharing'), 'app.ts must not reference /api/sharing');
});
test('app.ts accounts handlers use closest( .account-card ) not data-index or global querySelectorAll', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(-1 !== src.indexOf('closest( \'.account-card\' )'), 'Handlers must use closest( .account-card )');
    t.false(-1 !== src.indexOf('querySelectorAll( \'.password-masked\' )'), 'Must not querySelectorAll password-masked globally');
    t.false(-1 !== src.indexOf('querySelectorAll(\'.password-masked\')'), 'Must not querySelectorAll password-masked (no spaces)');
});
test('app.ts toggle handler uses is-revealed class for state', (t) => {
    const sourcePath = path.resolve(__dirname, '../../frontend/src/app.ts');
    const src = fs.readFileSync(sourcePath, 'utf-8');
    t.true(-1 !== src.indexOf('is-revealed'), 'Toggle handler must use is-revealed class');
});
// ---------------------------------------------------------------------------
// Real template rendering tests
// ---------------------------------------------------------------------------
test('accounts template renders without placeholders or data-tdal remnants', (t) => {
    const engine = new jTDAL();
    const data = {
        accounts: [
            {
                service: 'Email Test',
                username: 'user@test.com',
                password: 'secret123',
                link: 'https://mail.example.com',
                isExternalLink: true,
                isInlineLink: false,
                linkDisplay: 'https://mail.example.com',
            },
            {
                service: 'Server Test',
                username: 'admin',
                password: 'adminpass',
                link: '',
                isExternalLink: false,
                isInlineLink: true,
                linkDisplay: 'No link provided',
            },
        ],
        empty: false,
    };
    const result = engine.CompileToFunction(accountsTemplate)(data);
    t.false(-1 !== result.indexOf('{{'), 'Rendered output must not contain {{');
    t.false(-1 !== result.indexOf('}}'), 'Rendered output must not contain }}');
    t.false(-1 !== result.indexOf('data-tdal-'), 'Rendered output must not contain unprocessed data-tdal-* attributes');
    t.true(-1 !== result.indexOf('secret123'), 'Rendered output must contain the first password value');
    t.true(-1 !== result.indexOf('user@test.com'), 'Rendered output must contain the username value');
    t.true(-1 !== result.indexOf('opens in a new tab'), 'Rendered output must contain sr-only new tab text');
    t.true(-1 !== result.indexOf('No link provided'), 'Rendered output must contain default link placeholder');
});
// ---------------------------------------------------------------------------
// Accounts template structure
// ---------------------------------------------------------------------------
test('accounts template has four labelled rows in strict order', (t) => {
    const serviceIdx = accountsTemplate.indexOf('Service');
    const usernameIdx = accountsTemplate.indexOf('Username');
    const passwordIdx = accountsTemplate.indexOf('Password');
    const linkIdx = accountsTemplate.indexOf('Link');
    t.true(-1 !== serviceIdx, 'Template must contain Service label');
    t.true(-1 !== usernameIdx, 'Template must contain Username label');
    t.true(-1 !== passwordIdx, 'Template must contain Password label');
    t.true(-1 !== linkIdx, 'Template must contain Link label');
    t.true(serviceIdx < usernameIdx, 'Service must appear before Username');
    t.true(usernameIdx < passwordIdx, 'Username must appear before Password');
    t.true(passwordIdx < linkIdx, 'Password must appear before Link');
});
test('accounts template uses card.account-card and accounts-list classes', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('class="card account-card"'), 'Card must have class="card account-card"');
    t.true(-1 !== accountsTemplate.indexOf('class="accounts-list"'), 'Outer container must have accounts-list class');
});
test('accounts template has no _index or data-index', (t) => {
    t.false(-1 !== accountsTemplate.indexOf('_index'), 'Template must not reference _index');
    t.false(-1 !== accountsTemplate.indexOf('data-index'), 'Template must not contain data-index attributes');
});
test('accounts template icon buttons have correct aria labels', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('aria-label="Show password"'), 'Toggle button must have Show aria label');
    t.true(-1 !== accountsTemplate.indexOf('aria-label="Copy password"'), 'Copy button must have Copy aria label');
});
test('accounts template all SVGs have aria-hidden and focusable false', (t) => {
    const svgCount = (accountsTemplate.match(/<svg/g) || []).length;
    const ariaHiddenCount = (accountsTemplate.match(/aria-hidden="true"/g) || []).length;
    const focusableCount = (accountsTemplate.match(/focusable="false"/g) || []).length;
    t.true(0 < svgCount, 'Template must contain at least one SVG');
    t.is(svgCount, ariaHiddenCount, 'Every SVG must have aria-hidden="true"');
    t.is(svgCount, focusableCount, 'Every SVG must have focusable="false"');
});
test('accounts template has both eye icons with show/hide classes', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('class="icon-show"'), 'Template must contain icon-show SVG');
    t.true(-1 !== accountsTemplate.indexOf('class="icon-hide"'), 'Template must contain icon-hide SVG');
});
test('accounts template has password-masked span with data-password attribute', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('class="password-masked"'), 'Template must contain password-masked span');
    t.true(-1 !== accountsTemplate.indexOf('data-password'), 'Template must use data-password attribute');
});
test('accounts template password action group buttons are icon-button type', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('class="icon-button" data-myopie="togglePassword"'), 'Toggle must be icon-button');
    t.true(-1 !== accountsTemplate.indexOf('class="icon-button" data-myopie="copyPassword"'), 'Copy must be icon-button');
});
test('accounts template external link anchor has correct attributes', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('target="_blank"'), 'External link must have target=_blank');
    t.true(-1 !== accountsTemplate.indexOf('rel="noopener"'), 'External link must have rel=noopener');
    t.true(-1 !== accountsTemplate.indexOf('aria-label="Open link in new tab"'), 'External link must have accessible label');
    t.true(-1 !== accountsTemplate.indexOf('class="sr-only"'), 'External link must have sr-only text');
    t.true(-1 !== accountsTemplate.indexOf('opens in a new tab'), 'External link must have visually hidden text');
});
test('accounts template has external and inline link conditions', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('data-tdal-condition="account/isExternalLink"'), 'Template must have external link condition');
    t.true(-1 !== accountsTemplate.indexOf('data-tdal-condition="account/isInlineLink"'), 'Template must have inline link condition');
});
test('accounts template uses linkDisplay content binding', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('data-tdal-content="account/linkDisplay"'), 'Template must use linkDisplay content');
});
test('login template renders with pin step showing masked email and timer', (t) => {
    const engine = new jTDAL();
    const data = {
        isEmailStep: false,
        isPinStep: true,
        email: 'mario.rossi@example.com',
        maskedEmail: 'm***@***.com',
        error: '',
        loading: false,
        notLoading: true,
        resendDisabled: true,
        resendEnabled: false,
        resendLabel: '0:45',
        verifying: false,
    };
    const result = engine.CompileToFunction(loginTemplate)(data);
    t.false(-1 !== result.indexOf('{{'), 'Rendered output must not contain {{');
    t.false(-1 !== result.indexOf('}}'), 'Rendered output must not contain }}');
    t.false(-1 !== result.indexOf('data-tdal-'), 'Rendered output must not contain unprocessed data-tdal-* attributes');
    t.false(-1 !== result.indexOf('mario.rossi@example.com'), 'Rendered output must NOT contain unmasked email');
    t.true(-1 !== result.indexOf('m***@***.com'), 'Rendered output must contain masked email');
    t.true(-1 !== result.indexOf('0:45'), 'Rendered output must contain timer label');
    t.true(-1 !== result.indexOf('login-pin-0'), 'Rendered output must contain OTP inputs');
    t.false(-1 !== result.indexOf('<input type="text" id="login-pin"'), 'Rendered output must NOT contain old single PIN input');
});
// ---------------------------------------------------------------------------
// Import map URL checks
// ---------------------------------------------------------------------------
test('frontend/index.html uses jsdelivr for chota (not unpkg)', (t) => {
    const indexPath = path.resolve(__dirname, '../../frontend/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('https://cdn.jsdelivr.net/npm/chota@0.9.2/dist/chota.min.css'), 'frontend/index.html must use jsdelivr for chota');
    t.false(-1 !== html.indexOf('https://unpkg.com/chota@0.9.2/dist/chota.min.css'), 'frontend/index.html must not use unpkg for chota');
});
test('built www/index.html uses jsdelivr for chota (not unpkg)', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('cdn.jsdelivr.net/npm/chota@0.9.2/dist/chota.min.css'), 'www/index.html must use jsdelivr for chota');
    t.false(-1 !== html.indexOf('unpkg.com/chota@0.9.2/dist/chota.min.css'), 'www/index.html must not use unpkg for chota');
});
test('frontend/index.html uses jsdelivr for @stefanobalocco/jtdal (not unpkg)', (t) => {
    const indexPath = path.resolve(__dirname, '../../frontend/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('https://cdn.jsdelivr.net/npm/@stefanobalocco/jtdal@latest/jTDAL.min.js'), 'frontend/index.html import map must use jsdelivr for @stefanobalocco/jtdal');
    t.false(-1 !== html.indexOf('https://unpkg.com/@stefanobalocco/jtdal@latest/jTDAL.min.js'), 'frontend/index.html import map must not use unpkg for @stefanobalocco/jtdal');
});
test('built www/index.html uses jsdelivr for @stefanobalocco/jtdal (not unpkg)', (t) => {
    const indexPath = path.resolve(__dirname, '../../www/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('cdn.jsdelivr.net/npm/@stefanobalocco/jtdal@latest/jTDAL.min.js'), 'www/index.html import map must use jsdelivr for @stefanobalocco/jtdal');
    t.false(-1 !== html.indexOf('unpkg.com/@stefanobalocco/jtdal@latest/jTDAL.min.js'), 'www/index.html import map must not use unpkg for @stefanobalocco/jtdal');
});
// ---------------------------------------------------------------------------
// Bootstrap instantiation check
// ---------------------------------------------------------------------------
test('frontend/style.css has dark mode media query', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('@media ( prefers-color-scheme: dark )'), 'frontend/style.css must contain dark mode media query');
    t.true(-1 !== content.indexOf('--color-darkGrey'), 'frontend/style.css must use --color-darkGrey');
    t.false(-1 !== content.indexOf('--color-grey-dark'), 'frontend/style.css must not use --color-grey-dark');
});
test('built www/style.css has dark mode media query', (t) => {
    const stylesPath = path.resolve(__dirname, '../../www/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('@media ( prefers-color-scheme: dark )'), 'www/style.css must contain dark mode media query');
});
// ---------------------------------------------------------------------------
// CSS design tokens and login-specific styles
// ---------------------------------------------------------------------------
test('frontend/style.css has warm paper/terracotta CSS tokens', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('--psps-paper'), 'CSS must define --psps-paper');
    t.true(-1 !== content.indexOf('--psps-surface'), 'CSS must define --psps-surface');
    t.true(-1 !== content.indexOf('--psps-ink'), 'CSS must define --psps-ink');
    t.true(-1 !== content.indexOf('--psps-terracotta'), 'CSS must define --psps-terracotta');
    t.true(-1 !== content.indexOf('--psps-terracotta-hover'), 'CSS must define --psps-terracotta-hover');
    t.true(-1 !== content.indexOf('--psps-border'), 'CSS must define --psps-border');
    t.true(-1 !== content.indexOf('--psps-input'), 'CSS must define --psps-input');
    t.true(-1 !== content.indexOf('--psps-error-bg'), 'CSS must define --psps-error-bg');
    t.true(-1 !== content.indexOf('--psps-error-ink'), 'CSS must define --psps-error-ink');
});
test('frontend/style.css has OTP input style classes', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('otp-group'), 'CSS must contain .otp-group');
    t.true(-1 !== content.indexOf('otp-input'), 'CSS must contain .otp-input');
    t.true(-1 !== content.indexOf('link-button'), 'CSS must contain .link-button');
    t.true(-1 !== content.indexOf('error-banner'), 'CSS must contain .error-banner');
    t.true(-1 !== content.indexOf('button-primary'), 'CSS must contain .button-primary');
    t.true(-1 !== content.indexOf('sr-only'), 'CSS must contain .sr-only');
});
test('frontend/style.css has reduced motion media query', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('prefers-reduced-motion: reduce'), 'CSS must contain reduced motion media query');
});
test('frontend/style.css dark mode overrides psps tokens', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    // Dark mode section must re-declare psps tokens
    const darkModeSection = content.substring(content.indexOf('@media ( prefers-color-scheme: dark )'));
    t.true(-1 !== darkModeSection.indexOf('--psps-paper: #1a1512'), 'Dark mode must override --psps-paper with warm dark');
    t.true(-1 !== darkModeSection.indexOf('--psps-terracotta: #d97757'), 'Dark mode must override --psps-terracotta');
});
test('frontend/style.css responsive OTP styles for narrow viewports', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('max-width: 30rem'), 'CSS must have responsive breakpoint for OTP');
});
// ---------------------------------------------------------------------------
// CSS — app full-bleed and body canvas
// ---------------------------------------------------------------------------
test('frontend/style.css has body with warm paper and ink colors', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('background: var( --psps-paper )') || -1 !== content.indexOf('background: var(--psps-paper)'), 'Body must use psps-paper background');
    t.true(-1 !== content.indexOf('color: var( --psps-ink )') || -1 !== content.indexOf('color: var(--psps-ink)'), 'Body must use psps-ink color');
});
test('frontend/style.css #app overrides Chota container with full-bleed', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const appSection = content.indexOf('#app') >= 0 ? content.substring(content.indexOf('#app')) : '';
    t.true(-1 !== appSection.indexOf('max-width: none'), '#app must have max-width: none');
    t.true(-1 !== appSection.indexOf('width: 100%'), '#app must have width: 100%');
    t.true(-1 !== appSection.indexOf('padding: 0'), '#app must have padding: 0');
    t.true(-1 !== appSection.indexOf('margin: 0'), '#app must have margin: 0');
});
// ---------------------------------------------------------------------------
// CSS — mobile-first login
// ---------------------------------------------------------------------------
test('frontend/style.css login-shell uses 100dvh and no outer padding on mobile', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('100dvh'), 'Login shell must use 100dvh');
    t.true(-1 !== content.indexOf('min-height: 100vh'), 'Login shell must have 100vh fallback');
    // Mobile base: no padding on login-shell (check only the .login-shell block itself)
    const loginShellStart = content.indexOf('.login-shell');
    const loginShellBlock = content.substring(loginShellStart, content.indexOf('}\n\n.login-panel'));
    t.false(-1 !== loginShellBlock.indexOf('padding:'), 'Login shell must have no padding in base rule');
});
test('frontend/style.css login panel is full-width flat on mobile, restored at 48rem', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    // Mobile base: no border/radius/shadow
    const panelStart = content.indexOf('.login-panel');
    const panelBlock = content.substring(panelStart, panelStart + 300);
    t.true(-1 !== panelBlock.indexOf('width: 100%'), 'Login panel must be width:100% on mobile');
    t.true(-1 !== panelBlock.indexOf('box-sizing: border-box'), 'Login panel must have box-sizing: border-box');
    // Desktop restore at 48rem
    t.true(-1 !== content.indexOf('min-width: 48rem'), 'CSS must have 48rem breakpoint for desktop login');
});
// ---------------------------------------------------------------------------
// CSS — accounts grid and cards
// ---------------------------------------------------------------------------
test('frontend/style.css accounts-list has no min-height', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const start = content.indexOf('.accounts-list');
    t.true(-1 !== start, 'CSS must contain .accounts-list selector');
    const block = content.substring(start, content.indexOf('@media', start));
    t.false(-1 !== block.indexOf('min-height'), '.accounts-list must not have min-height');
});
test('frontend/style.css .account-card .link-external has flex:1, truncation properties', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const start = content.indexOf('.account-card .link-external');
    t.true(-1 !== start, 'CSS must contain .account-card .link-external');
    const block = content.substring(start, content.indexOf('}', start));
    t.true(-1 !== block.indexOf('flex: 1'), '.link-external must have flex: 1');
    t.true(-1 !== block.indexOf('min-width: 0'), '.link-external must have min-width: 0');
    t.true(-1 !== block.indexOf('overflow: hidden'), '.link-external must have overflow: hidden');
    t.true(-1 !== block.indexOf('text-overflow: ellipsis'), '.link-external must have text-overflow: ellipsis');
    t.true(-1 !== block.indexOf('white-space: nowrap'), '.link-external must have white-space: nowrap');
    t.false(-1 !== block.indexOf('max-width'), '.link-external must not have max-width');
});
test('frontend/style.css .sr-only still exists', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('.sr-only'), 'CSS must still contain sr-only class');
});
test('frontend/style.css accounts-list grid uses 1fr base and progressive breakpoints', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const baseStart = content.indexOf('.accounts-list');
    t.true(-1 !== baseStart, 'CSS must contain .accounts-list selector');
    // Base rule: grid-template-columns: 1fr (no repeat)
    const block40Start = content.indexOf('@media ( min-width: 40rem )');
    t.true(-1 !== block40Start, 'CSS must have @media ( min-width: 40rem )');
    const baseBlock = content.substring(baseStart, block40Start);
    t.true(-1 !== baseBlock.indexOf('grid-template-columns: 1fr'), 'Base must be grid-template-columns: 1fr');
    // 40rem breakpoint: repeat( 2, 1fr )
    const block56Start = content.indexOf('@media ( min-width: 56rem )');
    t.true(-1 !== block56Start, 'CSS must have @media ( min-width: 56rem )');
    const block40 = content.substring(block40Start, block56Start);
    t.true(-1 !== block40.indexOf('grid-template-columns: repeat( 2, 1fr )'), '40rem must contain repeat( 2, 1fr )');
    // 56rem breakpoint: repeat( 3, 1fr )
    const block72Start = content.indexOf('@media ( min-width: 72rem )');
    t.true(-1 !== block72Start, 'CSS must have @media ( min-width: 72rem )');
    const block56 = content.substring(block56Start, block72Start);
    t.true(-1 !== block56.indexOf('grid-template-columns: repeat( 3, 1fr )'), '56rem must contain repeat( 3, 1fr )');
    // 72rem breakpoint: repeat( 4, 1fr )
    const block72 = content.substring(block72Start, content.indexOf('/* ---- Account cards ----', block72Start));
    t.true(-1 !== block72.indexOf('grid-template-columns: repeat( 4, 1fr )'), '72rem must contain repeat( 4, 1fr )');
});
test('frontend/style.css account-card has warm surface, border, no margin', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('.account-card'), 'Must have .account-card selector');
    t.true(-1 !== content.indexOf('margin: 0'), 'Account card must have margin:0');
});
test('frontend/style.css icon-button has 44px minimum target size', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.true(-1 !== content.indexOf('min-width: 44px'), 'Icon button must have min-width 44px');
    t.true(-1 !== content.indexOf('min-height: 44px'), 'Icon button must have min-height 44px');
});
// ---------------------------------------------------------------------------
// CSS — dark mode uses warm values, no navy blue
// ---------------------------------------------------------------------------
test('frontend/style.css dark mode has no navy #1a1a2e or blue #4a90d9', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    t.false(-1 !== content.indexOf('#1a1a2e'), 'Dark mode must not contain navy #1a1a2e');
    t.false(-1 !== content.indexOf('#4a90d9'), 'Dark mode must not contain blue #4a90d9');
});
test('frontend/style.css dark mode keeps --color-darkGrey and warm primary', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const darkModeSection = content.indexOf('@media ( prefers-color-scheme: dark )') >= 0
        ? content.substring(content.indexOf('@media ( prefers-color-scheme: dark )'))
        : '';
    t.true(-1 !== darkModeSection.indexOf('--color-darkGrey'), 'Dark mode must keep --color-darkGrey');
});
test('frontend/style.css reduced motion includes icon-button', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const reducedSection = content.indexOf('prefers-reduced-motion: reduce') >= 0
        ? content.substring(content.indexOf('prefers-reduced-motion: reduce'))
        : '';
    t.true(-1 !== reducedSection.indexOf('.icon-button'), 'Reduced motion must include .icon-button');
});
test('frontend/style.css field-value has min-width: 0 and overflow-wrap: anywhere', (t) => {
    const stylesPath = path.resolve(__dirname, '../../frontend/style.css');
    const content = fs.readFileSync(stylesPath, 'utf-8');
    const start = content.indexOf('.account-card .field-value');
    t.true(-1 !== start, 'CSS must contain .account-card .field-value');
    const block = content.substring(start, content.indexOf('}', start));
    t.true(-1 !== block.indexOf('min-width: 0'), '.field-value must have min-width: 0');
    t.true(-1 !== block.indexOf('overflow-wrap: anywhere'), '.field-value must have overflow-wrap: anywhere');
});
test('accounts template external link contains sr-only opens in a new tab', (t) => {
    t.true(-1 !== accountsTemplate.indexOf('class="sr-only"'), 'External link must contain sr-only element');
    t.true(-1 !== accountsTemplate.indexOf('opens in a new tab'), 'External link sr-only must contain opens in a new tab');
});
// ---------------------------------------------------------------------------
// Prefix-contract: frontend/app.js and frontend/app.min.js must exist
// ---------------------------------------------------------------------------
test('frontend/app.js and frontend/app.min.js exist after build', (t) => {
    const frontendPath = path.resolve(__dirname, '../../frontend');
    const appJsPath = path.resolve(frontendPath, 'app.js');
    const appMinJsPath = path.resolve(frontendPath, 'app.min.js');
    t.true(fs.existsSync(appJsPath), 'frontend/app.js must exist after build');
    t.true(fs.existsSync(appMinJsPath), 'frontend/app.min.js must exist after build');
    const minContent = fs.readFileSync(appMinJsPath, 'utf-8');
    t.true(0 < minContent.length, 'frontend/app.min.js must be non-empty');
});
// ---------------------------------------------------------------------------
// jTDAL import — must use scoped specifier (@stefanobalocco/jtdal) for browser import-map compat
// ---------------------------------------------------------------------------
test('frontend/app.min.js imports @stefanobalocco/jtdal, not bare jtdal', (t) => {
    const appMinJsPath = path.resolve(__dirname, '../../frontend/app.min.js');
    const content = fs.readFileSync(appMinJsPath, 'utf-8');
    t.true(-1 !== content.indexOf('@stefanobalocco/jtdal'), 'app.min.js must import "@stefanobalocco/jtdal"');
    t.false(-1 !== content.indexOf('"jtdal"'), 'app.min.js must NOT import bare "jtdal"');
});
test('frontend/index.html import map has @stefanobalocco/jtdal key for browser resolution', (t) => {
    const indexPath = path.resolve(__dirname, '../../frontend/index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    t.true(-1 !== html.indexOf('"@stefanobalocco/jtdal":'), 'frontend/index.html import map must have @stefanobalocco/jtdal key');
});
// ---------------------------------------------------------------------------
// Runtime behaviour-driven journey against app.min.js
// ---------------------------------------------------------------------------
// Globals that the bundle and its dependencies expect
const _runtimeGlobals = [
    'document', 'window', 'navigator', 'location', 'Event', 'Node',
    'HTMLElement', 'HTMLInputElement', 'HTMLSpanElement', 'NodeList',
    'MutationObserver',
];
test.serial('full user journey: email validation, OTP, resend, verification, accounts, toggle, copy', async (t) => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><main id="app"></main></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    const doc = dom.window.document;
    const DomEvent = dom.window.Event;
    // ---- Save original global descriptors ----
    const savedDescriptors = {};
    const cGlobals = _runtimeGlobals.length;
    for (let iL1 = 0; iL1 < cGlobals; iL1++) {
        const name = _runtimeGlobals[iL1];
        savedDescriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name) || null;
    }
    // ---- Install JSDOM globals ----
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        writable: true,
        configurable: true,
    });
    globalThis.location = dom.window.location;
    globalThis.Event = DomEvent;
    globalThis.Node = dom.window.Node;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.HTMLSpanElement = dom.window.HTMLSpanElement;
    globalThis.NodeList = dom.window.NodeList;
    globalThis.MutationObserver = dom.window.MutationObserver;
    // ---- Mock Date.now ----
    const originalDateNow = Date.now;
    let testNow = originalDateNow();
    Date.now = () => testNow;
    // ---- Teardown: restore globals, Date.now, and close JSDOM ----
    const jsdomWindow = dom.window;
    t.teardown(() => {
        Date.now = originalDateNow;
        if (!jsdomWindow.closed) {
            jsdomWindow.close();
        }
        const cRestore = _runtimeGlobals.length;
        for (let iL1 = 0; iL1 < cRestore; iL1++) {
            const name = _runtimeGlobals[iL1];
            const descriptor = savedDescriptors[name];
            if (null !== descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            }
            else {
                delete globalThis[name];
            }
        }
    });
    // ---- Mock fetch with deterministic response state machine ----
    let emailFetchCount = 0;
    let verifyFetchCount = 0;
    const fetchRequests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const urlStr = 'string' === typeof url ? url : url.toString();
        if ('/api/login' === urlStr && 'POST' === (init?.method || 'GET')) {
            const body = JSON.parse(init?.body || '{}');
            fetchRequests.push({ url: urlStr, method: 'POST', body });
            if (body.email && !body.pin) {
                const idx = emailFetchCount++;
                switch (idx) {
                    case 0: return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                    case 1: throw new Error('Network error');
                    case 2: return new Response(JSON.stringify({ message: 'If your email is authorized, you have received a code.', next: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    case 3: return new Response(JSON.stringify({ message: 'If your email is authorized, you have received a code.', next: testNow + 2000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    case 4: return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    case 5: throw new Error('Network error');
                    case 6: return new Response(JSON.stringify({ message: 'If your email is authorized, you have received a code.', next: testNow + 60_000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    default: return new Response('Not found', { status: 404 });
                }
            }
            if (body.email && body.pin) {
                const idx = verifyFetchCount++;
                switch (idx) {
                    case 0: throw new Error('Network error');
                    case 1: return new Response(JSON.stringify({ error: 'Invalid or expired PIN.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
                    case 2: return new Response(JSON.stringify({ error: 'Invalid or expired PIN.', reset: true }), { status: 401, headers: { 'Content-Type': 'application/json' } });
                    case 3: return new Response(JSON.stringify({ accounts: [{ service: 'Email Service', username: 'user@test.com', password: 'secret123', link: 'https://mail.example.com' }, { service: 'Server Admin', username: 'root', password: 'admin!pass', link: '' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    default: return new Response('Not found', { status: 404 });
                }
            }
        }
        return new Response('Not found', { status: 404 });
    };
    t.teardown(() => {
        globalThis.fetch = originalFetch;
    });
    // ---- Mock clipboard ----
    let clipboardText = '';
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (text) => { clipboardText = text; } },
        writable: true,
        configurable: true,
    });
    t.teardown(() => {
        Object.defineProperty(navigator, 'clipboard', {
            value: originalClipboard,
            writable: true,
            configurable: true,
        });
    });
    // ---- Import the minified bundle (triggers bootstrap) ----
    // @ts-expect-error — no .d.ts for minified bundle, side-effect-only import
    await import('../../frontend/app.min.js');
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const appEl = doc.getElementById('app');
    t.truthy(appEl, '#app must exist');
    // ============ 1. Submit empty email → client-side validation error ============
    let emailField = doc.getElementById('login-email');
    t.truthy(emailField, 'Email input must be present');
    t.true(-1 !== appEl.innerHTML.indexOf('Send access code'), 'Submit button must be rendered');
    t.true(-1 !== appEl.innerHTML.indexOf('Step 1 of 2'), 'Step progress must show step 1');
    let formEl = doc.querySelector('[data-myopie="emailForm"]');
    t.truthy(formEl, 'Email form must be present');
    const prevEmailCount = emailFetchCount;
    formEl.dispatchEvent(new DomEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    t.is(emailFetchCount, prevEmailCount, 'fetch must NOT be called for empty email');
    // ============ 2. Submit valid email → HTTP 500 ============
    emailField = doc.getElementById('login-email');
    t.truthy(emailField, 'Email input must exist for step 2');
    emailField.value = 'user@test.com';
    formEl = doc.querySelector('[data-myopie="emailForm"]');
    t.truthy(formEl, 'Email form must exist for step 2');
    formEl.dispatchEvent(new DomEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.true(-1 !== appEl.innerHTML.indexOf('Error requesting code.'), 'HTTP 500 must show error text');
    t.true(-1 !== appEl.innerHTML.indexOf('login-email'), 'Must stay on email step after 500');
    // ============ 3. Submit valid email → fetch rejects ============
    emailField = doc.getElementById('login-email');
    t.truthy(emailField, 'Email input must exist for step 3');
    emailField.value = 'user@test.com';
    formEl = doc.querySelector('[data-myopie="emailForm"]');
    t.truthy(formEl, 'Email form must exist for step 3');
    formEl.dispatchEvent(new DomEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.true(-1 !== appEl.innerHTML.indexOf('Connection error. Try again.'), 'Rejected fetch must show connection error');
    t.true(-1 !== appEl.innerHTML.indexOf('login-email'), 'Must stay on email step after reject');
    // ============ 4. Submit valid email → 200 with past/non-numeric next ============
    emailField = doc.getElementById('login-email');
    t.truthy(emailField, 'Email input must exist for step 4');
    emailField.value = 'user@test.com';
    formEl = doc.querySelector('[data-myopie="emailForm"]');
    t.truthy(formEl, 'Email form must exist for step 4');
    formEl.dispatchEvent(new DomEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.true(-1 !== appEl.innerHTML.indexOf('otp-input'), 'OTP inputs must be rendered even with past next');
    t.true(-1 !== appEl.innerHTML.indexOf('u***@***.com'), 'Masked email must be shown');
    t.true(-1 !== appEl.innerHTML.indexOf('Step 2 of 2'), 'Step progress must show step 2');
    // ============ 5. OTP focus/select and paste prevention ============
    const pin0 = doc.getElementById('login-pin-0');
    t.truthy(pin0, 'OTP field 0 must exist');
    pin0.value = '5';
    pin0.focus();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    // ponytail: JSDOM focus does not bubble; select() only runs if event wired
    if (0 === pin0.selectionStart) {
        t.true(0 < pin0.selectionEnd, 'Selection end must cover content if select() ran');
    }
    // Plain native paste event (no clipboardData)
    const pasteEvent = new DomEvent('paste', { bubbles: true, cancelable: true });
    pin0.dispatchEvent(pasteEvent);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    t.true(pasteEvent.defaultPrevented, 'Paste event must be prevented');
    t.is(pin0.value, '5', 'Value must remain unchanged after paste with no clipboardData');
    pin0.value = '';
    // ============ 6. Multi-char → verify-fetch rejection ============
    let pinField = doc.getElementById('login-pin-2');
    t.truthy(pinField, 'OTP field 2 must exist for step 6');
    pinField.value = '123456';
    pinField.dispatchEvent(new DomEvent('input', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    t.true(-1 !== appEl.innerHTML.indexOf('Connection error. Try again.'), 'Verify rejection must show connection error');
    const cleared0 = doc.getElementById('login-pin-0');
    t.is(cleared0.value, '', 'PIN fields must be cleared after verify rejection');
    t.is(doc.activeElement?.id, 'login-pin-0', 'Focus must return to first OTP field');
    // ============ 7. Multi-char → non-reset 401 ============
    pinField = doc.getElementById('login-pin-2');
    t.truthy(pinField, 'OTP field 2 must exist for step 7');
    pinField.value = '123456';
    pinField.dispatchEvent(new DomEvent('input', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const errorBanner = doc.querySelector('.error-banner');
    t.truthy(errorBanner, 'Error banner must appear after non-reset failure');
    t.true(-1 !== (errorBanner.textContent || '').indexOf('Invalid'), 'Error text must mention invalid');
    const cleared1 = doc.getElementById('login-pin-0');
    t.is(cleared1.value, '', 'PIN fields must be cleared after non-reset failure');
    // ============ 8. Multi-char → reset 401 ============
    pinField = doc.getElementById('login-pin-2');
    t.truthy(pinField, 'OTP field 2 must exist for step 8');
    pinField.value = '123456';
    pinField.dispatchEvent(new DomEvent('input', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    t.true(-1 !== appEl.innerHTML.indexOf('login-email'), 'Must return to email step after reset failure');
    t.false(-1 !== appEl.innerHTML.indexOf('otp-input'), 'OTP inputs must be gone after reset');
    // ============ 9. Re-submit with short future next ============
    let emailField2 = doc.getElementById('login-email');
    t.truthy(emailField2, 'Email input must exist after reset');
    emailField2.value = 'user@test.com';
    let formEl2 = doc.querySelector('[data-myopie="emailForm"]');
    t.truthy(formEl2, 'Email form must exist after reset');
    formEl2.dispatchEvent(new DomEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.true(-1 !== appEl.innerHTML.indexOf('otp-input'), 'OTP inputs must appear after re-submit');
    // ============ 10. Advance past timer → resend enabled ============
    testNow += 3000;
    await new Promise((resolve) => { setTimeout(resolve, 1100); });
    let resendBtn = doc.querySelector('[data-myopie="resendPin"]');
    t.truthy(resendBtn, 'Resend button must be enabled after timer expiry');
    // ============ 11. Resend with non-OK response ============
    const prevReqsLen1 = fetchRequests.length;
    resendBtn.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.is(fetchRequests.length, prevReqsLen1 + 1, 'Resend must make a fetch request');
    t.is(fetchRequests[prevReqsLen1].body.email, 'user@test.com', 'Resend must use user email');
    let resendAfter1 = doc.querySelector('[data-myopie="resendPin"]');
    t.truthy(resendAfter1, 'Resend button must remain after non-OK resend');
    // ============ 12. Resend with rejected fetch ============
    const prevReqsLen2 = fetchRequests.length;
    resendAfter1.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    t.is(fetchRequests.length, prevReqsLen2 + 1, 'Resend must make a fetch request');
    t.is(fetchRequests[prevReqsLen2].body.email, 'user@test.com', 'Resend must use user email');
    const resendAfter2 = doc.querySelector('[data-myopie="resendPin"]');
    t.truthy(resendAfter2, 'Resend button must remain after rejected resend');
    // ============ 13. Complete OTP → verify success → accounts ============
    const pin2Final = doc.getElementById('login-pin-2');
    t.truthy(pin2Final, 'OTP field 2 must exist for final verify');
    pin2Final.value = '123456';
    pin2Final.dispatchEvent(new DomEvent('input', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    t.false(-1 !== appEl.innerHTML.indexOf('login-pin-0'), 'PIN fields must not appear after success');
    t.true(-1 !== appEl.innerHTML.indexOf('account-card'), 'Account cards must appear');
    t.true(-1 !== appEl.innerHTML.indexOf('Email Service'), 'First account service must appear');
    t.true(-1 !== appEl.innerHTML.indexOf('Server Admin'), 'Second account service must appear');
    // ============ Password reveal/hide ============
    const toggleButtons = doc.querySelectorAll('[data-myopie="togglePassword"]');
    const passwordSpans = doc.querySelectorAll('[data-password]');
    t.is(2, toggleButtons.length, 'Must have two toggle buttons');
    t.is(2, passwordSpans.length, 'Must have two password spans');
    t.is(passwordSpans[0].textContent, '********', 'First card initially masked');
    t.is(passwordSpans[1].textContent, '********', 'Second card initially masked');
    toggleButtons[0].dispatchEvent(new DomEvent('click', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    t.is(passwordSpans[0].textContent, 'secret123', 'First card password revealed');
    t.is(passwordSpans[0].className, 'password-revealed', 'First card has revealed class');
    t.true(toggleButtons[0].classList.contains('is-revealed'), 'First toggle has is-revealed class');
    t.is(passwordSpans[1].textContent, '********', 'Second card stays masked');
    t.false(toggleButtons[1].classList.contains('is-revealed'), 'Second toggle lacks is-revealed class');
    toggleButtons[0].dispatchEvent(new DomEvent('click', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    t.is(passwordSpans[0].textContent, '********', 'First card returns to masked');
    // ============ Copy action ============
    const copyButtons = doc.querySelectorAll('[data-myopie="copyPassword"]');
    t.is(2, copyButtons.length, 'Must have two copy buttons');
    copyButtons[1].dispatchEvent(new DomEvent('click', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    t.is(clipboardText, 'admin!pass', 'Clipboard must receive the second card password');
});
