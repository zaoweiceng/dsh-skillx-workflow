// Process completion is separate from tool transport success. Raw callers may
// intentionally inspect nonzero exits; checked callers opt into enforcement.
export function processOutcome(result, acceptedExitCodes = [0]) {
  if (result?.sandbox?.denied) return { ok: false, code: 'PROCESS_ACCESS_DENIED', category: 'external' };
  if (result?.timedOut) return { ok: false, code: 'PROCESS_TIMEOUT', category: 'unknown' };
  if (result?.aborted) return { ok: false, code: 'PROCESS_CANCELLED', category: 'unknown' };
  if (result?.signal) return { ok: false, code: 'PROCESS_SIGNALLED', category: 'unknown' };
  if (!Number.isInteger(result?.exitCode)) return { ok: false, code: 'PROCESS_RESULT_UNKNOWN', category: 'unknown' };
  if (!acceptedExitCodes.includes(result.exitCode)) return { ok: false, code: 'PROCESS_EXIT_FAILED', category: 'unknown' };
  if (result?.stdout?.truncated) return { ok: false, code: 'PROCESS_OUTPUT_TRUNCATED', category: 'unknown' };
  // stderr is diagnostic output. Truncation alone does not invalidate a result.
  return { ok: true };
}

export function acceptedProcessExitCodes(value = [0]) {
  if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(code => !Number.isSafeInteger(code) || code < 0 || code > 4294967295)) {
    throw Object.assign(new Error('acceptedExitCodes must contain 1..32 integer exit codes from 0 to 4294967295'), { code: 'INVALID_PROCESS_ARGUMENT' });
  }
  return [...new Set(value)];
}
