<script setup>
import { ref, watch } from 'vue';

import { api } from '@/api/client.js';

const props = defineProps({
  sessionId: { type: String, default: null },
  running: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
});

const skills = ref([]);
const error = ref('');
const loading = ref(false);
/** @type {import('vue').Ref<Record<string, boolean>>} */
const removing = ref({});
let seq = 0;

async function load() {
  const current = ++seq;
  const sessionId = props.sessionId;
  error.value = '';
  if (!sessionId) {
    skills.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const data = await api.getSessionSkills(sessionId);
    if (current !== seq) return;
    skills.value = data.skills;
  } catch (err) {
    if (current !== seq) return;
    error.value = err.message;
  } finally {
    if (current === seq) loading.value = false;
  }
}

/** @param {any} skill */
async function remove(skill) {
  if (props.running || removing.value[skill.name]) return;
  const sessionId = props.sessionId;
  if (!sessionId) return;
  removing.value = { ...removing.value, [skill.name]: true };
  error.value = '';
  try {
    await api.removeSessionSkill(sessionId, skill.name);
    await load();
  } catch (err) {
    if (sessionId === props.sessionId) error.value = err.message;
  } finally {
    const rest = { ...removing.value };
    delete rest[skill.name];
    removing.value = rest;
  }
}

watch(() => [props.sessionId, props.revision], load, { immediate: true });
</script>

<template>
  <div class="session-skills">
    <p v-if="error" class="error small">{{ error }}</p>
    <template v-if="skills.length">
      <span class="muted small">已启用技能：</span>
      <span v-for="s in skills" :key="s.name" class="chip">
        <code>/{{ s.name }}</code>
        <button
          class="chip-remove"
          :disabled="running || removing[s.name]"
          title="移除技能"
          :aria-label="'移除技能 ' + s.name"
          @click="remove(s)"
        >
          ×
        </button>
      </span>
    </template>
    <span v-else-if="!loading" class="muted small">可输入 /技能名 选用技能</span>
  </div>
</template>

<style scoped>
.session-skills {
  max-width: 820px;
  margin-inline: auto;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 0.4rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.85rem;
}

.chip-remove {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0 0.15rem;
  color: inherit;
}

.chip-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
