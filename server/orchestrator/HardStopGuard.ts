import { SymbolState } from './types';

export interface HardStopGuardConfig {
  maxLossPct: number;
}

export interface HardStopEvaluation {
  hardStopTriggered: boolean;
  profitLockTriggered: boolean;
}

export function evaluateHardStop(state: SymbolState, config: HardStopGuardConfig, currentPrice: number | null): HardStopEvaluation {
  if (!state.position) {
    return { hardStopTriggered: false, profitLockTriggered: false };
  }

  const threshold = -Math.abs(config.maxLossPct);
  const hardStopTriggered = state.position.unrealizedPnlPct <= threshold;

  const profitLockTriggered = Boolean(
    state.position.profitLockActivated &&
    typeof state.position.hardStopPrice === 'number' &&
    Number.isFinite(state.position.hardStopPrice) &&
    typeof currentPrice === 'number' &&
    Number.isFinite(currentPrice) &&
    (
      (state.position.side === 'LONG' && currentPrice <= state.position.hardStopPrice) ||
      (state.position.side === 'SHORT' && currentPrice >= state.position.hardStopPrice)
    )
  );

  return { hardStopTriggered, profitLockTriggered };
}
