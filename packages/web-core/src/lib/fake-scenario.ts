/**
 * What the READ calls of an in-memory fake answer. A test-only hook (unit tests pass it to the
 * fake backends); the running app never sets it, so no screen offers a way to force a state.
 */
export type FakeScenario = 'ready' | 'loading' | 'empty' | 'error' | 'denied';
