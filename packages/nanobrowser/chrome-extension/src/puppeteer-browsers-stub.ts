// Stub for @puppeteer/browsers - not needed in Chrome extension context
// The extension uses ExtensionTransport to connect to existing Chrome tabs,
// never launches browsers, so none of these functions are called at runtime.
export const Browser = { CHROME: 'chrome', FIREFOX: 'firefox', EDGE: 'edge' }
export const CDP_WEBSOCKET_ENDPOINT_REGEX = /ws:\/\/.*\/devtools\/browser\/.*/
export const WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX = /ws:\/\/.*\/session\/.*/
export const TimeoutError = class TimeoutError extends Error {}
export function resolveBuildId() { return Promise.resolve('') }
export function detectBrowserPlatform() { return null }
export function getInstalledBrowsers() { return Promise.resolve([]) }
export function uninstall() { return Promise.resolve() }
export function computeExecutablePath() { return '' }
export function launch() { throw new Error('Not available in extension') }
export function resolveDefaultUserDataDir() { return '' }
export const ChromeReleaseChannel = {}
