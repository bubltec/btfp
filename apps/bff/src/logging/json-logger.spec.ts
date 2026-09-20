import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonLogger } from './json-logger.js';
import { requestContext } from './request-context.js';

function capture(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.map((line) => JSON.parse(line));
}

afterEach(() => vi.restoreAllMocks());

describe('JsonLogger', () => {
  it('writes exactly one single-line JSON object per call', () => {
    const [entry, ...more] = capture(() => new JsonLogger().log('hello', 'AppService'));
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({ level: 'info', message: 'hello', context: 'AppService' });
  });

  it('keeps a multi-line stack inside one event (message, stack, context)', () => {
    const stack = 'TypeError: boom\n    at foo (/var/task/lambda.js:1:1)\n    at bar (x.js:2:2)';
    const entries = capture(() => new JsonLogger().error('boom', stack, 'ExceptionsHandler'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      message: 'boom',
      stack,
      context: 'ExceptionsHandler',
    });
  });

  it('treats a lone string after an error message as context, not a stack', () => {
    const [entry] = capture(() => new JsonLogger().error('nope', 'SomeContext'));
    expect(entry?.context).toBe('SomeContext');
    expect(entry?.stack).toBeUndefined();
  });

  it('serializes an Error argument with its stack', () => {
    const err = new Error('kaboom');
    const [entry] = capture(() => new JsonLogger().error(err));
    expect(entry).toMatchObject({ message: 'kaboom', stack: err.stack });
  });

  it('tags lines with the Lambda request id from the request context', () => {
    const [entry] = capture(() =>
      requestContext.run({ requestId: 'req-123' }, () => new JsonLogger().warn('careful')),
    );
    expect(entry).toMatchObject({ level: 'warn', requestId: 'req-123' });
  });

  it('omits requestId outside a request', () => {
    const [entry] = capture(() => new JsonLogger().log('startup'));
    expect(entry).not.toHaveProperty('requestId');
  });

  it('suppresses debug/verbose unless enabled', () => {
    expect(capture(() => new JsonLogger(false).debug('d'))).toHaveLength(0);
    expect(capture(() => new JsonLogger(true).debug('d'))).toHaveLength(1);
  });

  it('does not throw on a circular object message', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => capture(() => new JsonLogger().log(circular))).not.toThrow();
  });
});
