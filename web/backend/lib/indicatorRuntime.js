/**
 * Server-side indicator runtime relay — script templates + RPC limits.
 */
import { rpcCreateRuntime, rpcUpdateInputs, rpcUpdateContext } from './mmtProtocol.js';

export const SCRIPT_TEMPLATES = {
  'aggregated-ob-imbalance': `//@version=2
indicator("Aggregated OB Imbalance", false);
const selected = input.exchanges("Aggregate From", ["binancef"]);
`,
  'net-positioning': `//@version=2
indicator("Net Positioning", false);
const selected = input.exchanges("Aggregate From", ["binancef"], { filter: ["futures", "inverse"] });
`,
  'key-levels': `//@version=2
indicator("Key Levels v2.2", true);
const showMaster = input.bool("Show All Levels", true);
`,
};

export const RUNTIME_LIMITS = {
  maxRuntimesPerClient: 10,
  maxScriptBytes: 65536,
  idleTimeoutMs: 5 * 60 * 1000,
};

/**
 * @param {string} scriptId
 * @param {object} context
 * @param {number} createToken
 */
export function buildCreateRuntimePayload(scriptId, context, createToken = 1) {
  const code = SCRIPT_TEMPLATES[scriptId];
  if (!code || code.length > RUNTIME_LIMITS.maxScriptBytes) return null;
  return rpcCreateRuntime({
    createToken,
    context: {
      exchange: context.exchange ?? 'binancef',
      symbol: context.symbol ?? 'btc/usd',
      timeframe: context.timeframe ?? 3600,
      from: context.from ?? 0,
      to: context.to ?? 0,
      realtime_enabled: context.realtime_enabled !== false,
      up_color: context.up_color ?? 0,
      down_color: context.down_color ?? 0,
    },
    code,
  });
}

export { rpcUpdateInputs, rpcUpdateContext };
