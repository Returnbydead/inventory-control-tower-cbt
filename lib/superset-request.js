const TRANSIENT_HTTP_STATUSES = new Set([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524,
]);

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Superset request timeout setelah ${timeoutMs} ms`));
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithTransientRetry(url, options = {}, retryOptions = {}) {
  const {
    attempts = 2,
    timeoutMs = 90_000,
    retryDelaysMs = [2_000],
    fetchImpl = fetch,
    sleepImpl = wait,
    onRetry = () => {},
  } = retryOptions;
  const maxAttempts = Math.max(1, Math.trunc(attempts));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
      const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
      if (!retryable || attempt === maxAttempts) return response;

      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
      onRetry({ attempt, nextAttempt: attempt + 1, status: response.status, delayMs });
      await response.body?.cancel().catch(() => {});
      await sleepImpl(delayMs);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
      onRetry({
        attempt,
        nextAttempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        delayMs,
      });
      await sleepImpl(delayMs);
    }
  }

  throw new Error("Superset request gagal tanpa respons.");
}

module.exports = {
  requestWithTransientRetry,
};
