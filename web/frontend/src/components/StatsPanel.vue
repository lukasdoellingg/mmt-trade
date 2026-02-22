<script setup>
defineProps({
  last: { type: Number, default: 0 },
  high: { type: Number, default: 0 },
  low: { type: Number, default: 0 },
  change: { type: Number, default: 0 },
  volume: { type: Number, default: 0 },
});
</script>

<template>
  <div class="stats">
    <div class="stat">
      <span class="stat-label">LAST</span>
      <span class="stat-value last">{{ last ? last.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—' }}</span>
    </div>
    <div class="stat">
      <span class="stat-label">24h HIGH</span>
      <span class="stat-value high">{{ high ? high.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—' }}</span>
    </div>
    <div class="stat">
      <span class="stat-label">24h LOW</span>
      <span class="stat-value low">{{ low ? low.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—' }}</span>
    </div>
    <div class="stat">
      <span class="stat-label">24h Δ</span>
      <span class="stat-value" :class="change >= 0 ? 'up' : 'down'">
        {{ change != null ? (change >= 0 ? '+' : '') + change.toFixed(2) + '%' : '—' }}
      </span>
    </div>
    <div class="stat">
      <span class="stat-label">24h VOL</span>
      <span class="stat-value vol">
        {{ volume >= 1e9 ? (volume / 1e9).toFixed(2) + 'B' : volume >= 1e6 ? (volume / 1e6).toFixed(2) + 'M' : volume >= 1e3 ? (volume / 1e3).toFixed(2) + 'K' : volume ? volume.toFixed(0) : '—' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: #0f0f14;
  border-radius: 4px;
  border: 1px solid #1e2a1e;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-label {
  font-size: 0.65rem;
  color: #5a7a5a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.stat-value {
  font-size: 0.9rem;
  font-weight: 600;
  color: #b8e6b8;
}
.stat-value.up { color: #3dc985; }
.stat-value.down { color: #ef4f60; }
.stat-value.vol { color: #8ab88a; }
</style>
