export const DEFAULT_QUERY_TIMEOUT_MS = 12_000;

export function withQueryTimeout<T>(
  promise: PromiseLike<T>,
  label = 'Data source',
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} unavailable after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function getQueryErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  }
  return null;
}
