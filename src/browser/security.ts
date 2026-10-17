// Single source of truth lives in ../server/net-security.ts: this module only
// re-exports, so the allow/deny lists cannot drift apart again.
export { isPublicAddress, validateUrl } from '../server/net-security.js';
export type { ValidatedUrl } from '../server/net-security.js';
