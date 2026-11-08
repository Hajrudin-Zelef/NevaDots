/** Verrou anti-double-submit (H5) : un ref-like synchrone, pas un state
 *  React (stale entre deux appels rapprochés, surtout avec un
 *  `prepareSend` asynchrone entre les deux). */
export interface SubmitGuard {
  /** Prend le verrou ; `false` si déjà pris (appel à ignorer). */
  tryAcquire(): boolean;
  /** Libère le verrou (dans un `finally`). */
  release(): void;
}

export function createSubmitGuard(): SubmitGuard {
  let taken = false;
  return {
    tryAcquire() {
      if (taken) return false;
      taken = true;
      return true;
    },
    release() {
      taken = false;
    },
  };
}
