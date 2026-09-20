import { AsyncLocalStorage } from 'node:async_hooks';

/** Set by the Lambda handler so every log line in a request carries its request id. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
