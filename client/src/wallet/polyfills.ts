/**
 * Some NEAR wallet plugins (Meteor, HERE) were written for Node and expect `process` and `Buffer`
 * to exist globally. Browsers have neither, so we provide minimal versions right before loading them.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { process?: unknown; Buffer?: unknown; global?: unknown };
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= { env: {}, browser: true, version: '', versions: {}, nextTick: (fn: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => fn(...a)) };
