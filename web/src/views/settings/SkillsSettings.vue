<script setup>
import { onMounted, ref } from 'vue';

import { api } from '@/api/client.js';

const skills = ref([]);
const loading = ref(false);
const error = ref('');
/** @type {import('vue').Ref<Record<string, boolean>>} */
const pending = ref({});

const statusLabels = { usable: '可用', disabled: '已停用', invalid: '格式错误' };

/** @param {any} skill */
function status(skill) {
  if (!skill.valid) return 'invalid';
  return skill.enabled ? 'usable' : 'disabled';
}

async function refresh() {
  if (loading.value || Object.keys(pending.value).length) return;
  loading.value = true;
  error.value = '';
  try {
    skills.value = (await api.getSkills()).skills;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** @param {any} skill */
async function toggle(skill, event) {
  event.target.checked = skill.valid && skill.enabled;
  if (loading.value || Object.keys(pending.value).length) return;
  const next = !skill.enabled;
  if (next && !skill.valid) return;
  pending.value = { ...pending.value, [skill.name]: true };
  error.value = '';
  try {
    skills.value = (await api.putSkills({ [skill.name]: next })).skills;
  } catch (err) {
    error.value = err.message;
  } finally {
    const rest = { ...pending.value };
    delete rest[skill.name];
    pending.value = rest;
  }
}

onMounted(refresh);
</script>

<template>
  <h3>技能</h3>
  <div class="toolbar">
    <button class="btn" :disabled="loading || Object.keys(pending).length > 0" @click="refresh">刷新</button>
    <span v-if="loading" class="muted small">载入中…</span>
  </div>
  <p class="muted small">
    用户本地技能目录默认为 <code>data/skills/&lt;技能名&gt;/SKILL.md</code>，可点刷新发现新技能；
    同名本地技能会覆盖内置技能。关闭技能会清除会话中的激活记录，重新开启后需再次选用。
  </p>
  <p v-if="error" class="error small">{{ error }}</p>
  <p v-else-if="!loading && !skills.length" class="muted small">还没有发现任何技能。</p>
  <ul class="skill-list">
    <li v-for="s in skills" :key="s.name">
      <div class="skill-head">
        <label class="switch">
          <input
            type="checkbox"
            :checked="s.valid && s.enabled"
            :disabled="!s.valid || loading || Object.keys(pending).length > 0"
            @change="toggle(s, $event)"
          />
          <code>/{{ s.name }}</code>
        </label>
        <span class="meta muted small">
          来源：{{ s.source === 'user' ? '本地' : '内置' }} · 状态：{{ statusLabels[status(s)] }}
        </span>
      </div>
      <p v-if="s.description" class="muted small">{{ s.description }}</p>
      <p v-if="s.error" class="error small">{{ s.error }}</p>
      <p v-if="s.allowed_tools?.length" class="muted small">
        依赖工具：{{ s.allowed_tools.join('、') }}
      </p>
    </li>
  </ul>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
  flex-wrap: wrap;
}

.skill-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0;
}

.skill-list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.skill-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.skill-list p {
  margin: 0.2rem 0;
}
</style>
