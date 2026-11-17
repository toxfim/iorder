/** Injection token for the Login Widget verifier; the value is null when no bot token is configured. */
export const LOGIN_WIDGET_VERIFIER = Symbol('LOGIN_WIDGET_VERIFIER');

/**
 * The verifier of the STAFF website widget: the staff login bot when one is configured (see
 * identity.module.ts), otherwise the same bot as LOGIN_WIDGET_VERIFIER. Null without any token.
 */
export const STAFF_LOGIN_WIDGET_VERIFIER = Symbol('STAFF_LOGIN_WIDGET_VERIFIER');
