import { ref, watch, shallowRef } from 'vue';
import { fetchExchanges, fetchSymbols } from '../api';
import { EXCHANGE_IDS } from '../constants';
import { DEFAULT_EXCHANGE, DEFAULT_SYMBOL } from '../core/defaults';

export function useSymbolPicker(initialExchange = DEFAULT_EXCHANGE, initialSymbol = DEFAULT_SYMBOL) {
  const exchange = ref(initialExchange);
  const symbol = ref(initialSymbol);
  const exchanges = shallowRef<string[]>([]);
  const symbols = shallowRef<{ symbol: string; volume?: number }[]>([]);
  const loading = ref(false);

  async function loadExchanges() {
    try {
      const list = await fetchExchanges();
      exchanges.value = list.length ? list : ['Binance', 'Coinbase', 'Bybit', 'OKX'];
    } catch {
      exchanges.value = ['Binance', 'Coinbase', 'Bybit', 'OKX'];
    }
    if (!exchanges.value.includes(exchange.value) && exchanges.value.length) {
      exchange.value = exchanges.value[0];
    }
  }

  async function loadSymbols() {
    if (!exchange.value) return;
    loading.value = true;
    try {
      const exId = EXCHANGE_IDS[exchange.value] ?? exchange.value.toLowerCase();
      const list = await fetchSymbols(exId);
      symbols.value = list;
      const hasCurrent = list.some((s) => s.symbol === symbol.value);
      if (!hasCurrent && list.length) symbol.value = list[0].symbol;
    } catch {
      symbols.value = [{ symbol: DEFAULT_SYMBOL }];
    } finally {
      loading.value = false;
    }
  }

  watch(exchange, () => { loadSymbols(); });

  function init() {
    return loadExchanges().then(loadSymbols);
  }

  return { exchange, symbol, exchanges, symbols, loading, loadSymbols, init };
}
