<script setup>
import { onMounted, ref } from 'vue';

import { api } from '@/api/client.js';

const tools = ref([]);
const error = ref('');

onMounted(async () => {
  try {
    tools.value = (await api.getTools()).tools;
  } catch (err) {
    error.value = err.message;
  }
});

async function toggle(tool) {
  const next = !tool.enabled;
  try {
    await api.putTools({ [tool.name]: next });
    tool.enabled = next;
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <h3>工具</h3>
  <p class="muted small">关闭的工具不会提供给模型。修改从下一个回合开始生效。</p>
  <p v-if="error" class="error small">{{ error }}</p>
  <ul class="tool-list">
    <li v-for="t in tools" :key="t.name">
      <label class="switch">
        <input type="checkbox" :checked="t.enabled" @change="toggle(t)" />
        <code>{{ t.name }}</code>
        <span v-if="t.exposure === 'on-demand'" class="badge">按需</span>
      </label>
      <p class="muted small">{{ t.description }}</p>
      <p v-if="t.exposure === 'on-demand' && !t.enabled" class="muted small">
        已明确禁用：即使 Skill 声明需要，也不会开放。
      </p>
    </li>
  </ul>
</template>
