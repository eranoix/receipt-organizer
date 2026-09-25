import { describe, expect, it } from 'vitest';
import { DriveError } from '@/lib/drive/types';
import { classifyError, PermanentError, TransientError } from '@/lib/queue/errors';

describe('classifyError', () => {
  it.each([
    [new DriveError('nameAlreadyExists', 'x', 409), true, 'nameAlreadyExists'],
    [new DriveError('itemNotFound', 'x', 404), true, 'itemNotFound'],
    [new DriveError('throttled', 'x', 429), false, 'throttled'],
    [new DriveError('serviceUnavailable', 'x', 503), false, 'serviceUnavailable'],
    [new PermanentError('x', 'declined'), true, 'declined'],
    [new TransientError('x', 'blip'), false, 'blip'],
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), false, 'ECONNRESET'],
    [Object.assign(new Error('x'), { status: 400 }), true, 'http_400'],
    [Object.assign(new Error('x'), { status: 502 }), false, 'http_502'],
    [new DOMException('t', 'TimeoutError'), false, 'timeout'],
    [new Error('who knows'), false, 'unknown'],
  ])('%s -> permanent=%s code=%s', (err, permanent, code) => {
    const v = classifyError(err);
    expect(v.permanent).toBe(permanent);
    expect(v.code).toBe(code);
  });

  it('prefers the provider code in the body over the HTTP status', () => {
    const v = classifyError(Object.assign(new Error('Conflict'), { status: 409, body: { error: { code: 'nameAlreadyExists' } } }));
    expect(v).toMatchObject({ permanent: true, code: 'nameAlreadyExists' });
  });

  it('carries Retry-After through', () => {
    expect(classifyError(new DriveError('throttled', 'x', 429, 7_000)).retryAfterMs).toBe(7_000);
  });
});
