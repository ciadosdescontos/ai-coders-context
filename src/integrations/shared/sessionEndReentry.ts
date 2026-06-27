function isTruthyReentrySignal(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

export function isSessionEndReentry(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  return isTruthyReentrySignal(record.stop_hook_active)
    || isTruthyReentrySignal(record.stopHookActive)
    || isTruthyReentrySignal(record.session_end_active)
    || isTruthyReentrySignal(record.sessionEndActive)
    || isTruthyReentrySignal(record.agent_end_active)
    || isTruthyReentrySignal(record.agentEndActive)
    || isTruthyReentrySignal(record.reentry)
    || isTruthyReentrySignal(record.reentrant);
}
