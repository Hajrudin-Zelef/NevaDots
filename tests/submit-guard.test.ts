import { expect, it } from 'vitest';
import { createSubmitGuard } from '../src/client/submit-guard';

it('anti-double-submit : second appel bloqué jusqu’au release (H5)', () => {
  const guard = createSubmitGuard();
  expect(guard.tryAcquire()).toBe(true);
  // Deux Entrée rapprochés : le second est ignoré, même après un
  // `await` (pas de state React stale).
  expect(guard.tryAcquire()).toBe(false);
  expect(guard.tryAcquire()).toBe(false);
  guard.release();
  expect(guard.tryAcquire()).toBe(true);
  guard.release();
});

it('release sans acquire ne bloque pas le cycle suivant', () => {
  const guard = createSubmitGuard();
  guard.release();
  expect(guard.tryAcquire()).toBe(true);
  guard.release();
});
