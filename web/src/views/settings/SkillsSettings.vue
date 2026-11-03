<script setup>
import { onMounted, ref } from 'vue';

import { api } from '@/api/client.js';

const skills = ref([]);
const errors = ref([]);
const error = ref('');
const loading = ref(true);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.listSkills();
    skills.value = data.skills;
    errors.value = data.errors ?? [];
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function toggle(skill) {
  const next = !skill.enabled;
  skill.enabled = next;
  try {
    await api.putSkills({ [skill.name]: next });
  } catch (err) {
    skill.enabled = !next;
    error.value = err.message;
  }
}
</script>

<template>
  <h3>Skills</h3>
  <p class="muted small">
    Skill 是「一类事该怎么做」的说明书。模型按需启用，启用后本会话持续生效；停用后不再加载正文，也不开放它的工具。
    内容来自仓库的 <code>skills/</code> 与用户目录，同名的用户版本优先。
  </p>
  <p v-if="error" class="error small">{{ error }}</p>
  <p v-for="item in errors" :key="item" class="error small">{{ item }}</p>
  <p v-if="loading" class="muted small">加载中…</p>
  <p v-else-if="!skills.length" class="muted small">没有找到 Skill。</p>

  <ul class="skill-list">
    <li v-for="s in skills" :key="s.name" :class="{ off: !s.enabled, bad: !s.valid }">
      <label class="switch">
        <input type="checkbox" :checked="s.enabled" @change="toggle(s)" />
        <strong>{{ s.name }}</strong>
        <span class="badge">{{ s.source === 'user' ? '用户' : '内置' }}</span>
        <span v-if="!s.valid" class="badge danger">不可用</span>
        <span v-else-if="!s.enabled" class="badge">已停用</span>
      </label>
      <p class="muted small">{{ s.description || '（没有简介）' }}</p>
      <p v-if="s.error" class="error small">{{ s.error }}</p>
      <p v-if="s.allowed_tools && s.allowed_tools.length" class="muted small">
        声明依赖：
        <code v-for="tool in s.allowed_tools" :key="tool" class="tool-tag">{{ tool }}</code>
      </p>
    </li>
  </ul>
</template>
