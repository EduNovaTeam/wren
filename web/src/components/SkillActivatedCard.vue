<script setup>
import { computed } from 'vue';

const props = defineProps({ event: { type: Object, required: true } });

const sourceLabel = computed(() => (props.event.source === 'user' ? '本地' : '内置'));
const missingTools = computed(() => props.event.missing_tools ?? []);
</script>

<template>
  <div class="skill-card">
    <p>已启用技能 <code>/{{ event.name }}</code></p>
    <p class="muted small">来源：{{ sourceLabel }}</p>
    <p v-if="missingTools.length" class="warn small">
      以下工具尚未提供：{{ missingTools.join('、') }}，相关操作可能无法完成
    </p>
  </div>
</template>

<style scoped>
.skill-card {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 0.5rem 0;
}

.skill-card p {
  margin: 0.15rem 0;
}

.warn {
  color: var(--warning, #b45309);
}
</style>
