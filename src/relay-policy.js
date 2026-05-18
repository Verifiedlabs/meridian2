export function shouldUseLpAgentRelay(apiConfig) {
  return !!apiConfig?.lpAgentRelayEnabled;
}

export function shouldUseZapOutRelay(apiConfig) {
  return shouldUseLpAgentRelay(apiConfig) && !!apiConfig?.zapOutRelayEnabled;
}
