<script setup lang="ts">
import { computed } from 'vue';
import type { RegionNode } from './types';
import WorkspaceSplitter from './WorkspaceSplitter.vue';

defineOptions({ name: 'WorkspaceSplitPane' });

const props = defineProps<{
  node: RegionNode;
  path?: number[];
  layoutLocked?: boolean;
}>();

const emit = defineEmits<{
  splitRatio: [path: number[], ratio: number];
}>();

const splitPath = computed(() => props.path ?? []);

const gridStyle = computed(() => {
  if (props.node.kind !== 'split') return {};
  const pct = Math.round(props.node.ratio * 1000) / 10;
  if (props.node.axis === 'h') {
    return {
      display: 'grid',
      gridTemplateColumns: `${pct}% 4px ${100 - pct}%`,
      width: '100%',
      height: '100%',
    };
  }
  return {
    display: 'grid',
    gridTemplateRows: `${pct}% 4px ${100 - pct}%`,
    width: '100%',
    height: '100%',
  };
});

function onRatio(ratio: number): void {
  emit('splitRatio', splitPath.value, ratio);
}
</script>

<template>
  <div v-if="node.kind === 'split'" class="ws-split" :style="gridStyle">
    <div class="ws-split-pane">
      <WorkspaceSplitPane
        :node="node.a"
        :path="[...splitPath, 0]"
        :layout-locked="layoutLocked"
        @split-ratio="(p, r) => emit('splitRatio', p, r)"
      >
        <template #leaf="slotProps">
          <slot name="leaf" v-bind="slotProps" />
        </template>
      </WorkspaceSplitPane>
    </div>
    <WorkspaceSplitter v-if="!layoutLocked" :axis="node.axis" :ratio="node.ratio" @ratio="onRatio" />
    <div class="ws-split-pane">
      <WorkspaceSplitPane
        :node="node.b"
        :path="[...splitPath, 1]"
        :layout-locked="layoutLocked"
        @split-ratio="(p, r) => emit('splitRatio', p, r)"
      >
        <template #leaf="slotProps">
          <slot name="leaf" v-bind="slotProps" />
        </template>
      </WorkspaceSplitPane>
    </div>
  </div>
  <div v-else-if="node.kind === 'leaf'" class="ws-leaf">
    <slot name="leaf" :anchor-id="node.anchorId" />
  </div>
</template>

<style scoped>
.ws-split {
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.ws-split-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.ws-leaf {
  width: 100%;
  height: 100%;
  min-height: 0;
  position: relative;
}
</style>
