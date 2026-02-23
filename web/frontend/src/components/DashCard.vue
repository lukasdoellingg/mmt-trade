<script setup lang="ts">
const props = defineProps({
  title: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  tfOptions: { type: Array, default: null },
  tfValue: { type: String, default: '1w' },
  toggleOptions: { type: Array, default: null },
  toggleValue: { type: String, default: '' },
});
const emit = defineEmits(['update:tfValue', 'update:toggleValue']);
</script>

<template>
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">{{ title }}</span>
      <div class="card-ctrls">
        <slot name="controls" />
        <div v-if="toggleOptions" class="toggle-group">
          <button
            v-for="opt in toggleOptions" :key="opt.value"
            class="toggle-btn"
            :class="{ active: toggleValue === opt.value }"
            @click="emit('update:toggleValue', opt.value)"
          >{{ opt.label }}</button>
        </div>
        <div v-if="tfOptions" class="tf-group">
          <button
            v-for="tf in tfOptions" :key="tf"
            class="tf-btn"
            :class="{ active: tfValue === tf }"
            @click="emit('update:tfValue', tf)"
          >{{ tf }}</button>
        </div>
      </div>
    </div>
    <div class="card-body">
      <div v-if="loading" class="card-loading">Loading…</div>
      <slot v-else />
    </div>
  </div>
</template>

<style scoped>
.card {
  background: #0f0f14;
  border: 1px solid #1e1e2a;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}
.card-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid #1a1a24;
  flex-shrink: 0;
  height: 26px;
  gap: 6px;
}
.card-title {
  font-size: .6rem;
  color: #7a8a9a;
  text-transform: uppercase;
  letter-spacing: .4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
  min-width: 0;
}
.card-ctrls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.tf-group, .toggle-group {
  display: flex;
  gap: 1px;
  background: #1a1a24;
  border-radius: 3px;
  overflow: hidden;
}
.tf-btn, .toggle-btn {
  background: transparent;
  border: none;
  color: #5a6a7a;
  font: inherit;
  font-size: .55rem;
  padding: 2px 5px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: .3px;
  transition: background .15s, color .15s;
}
.tf-btn:hover, .toggle-btn:hover { color: #a0b0c0; }
.tf-btn.active, .toggle-btn.active {
  background: #2a2a3a;
  color: #d0e0f0;
}
.card-body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.card-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #5a7a5a;
  font-size: .7rem;
}
</style>
