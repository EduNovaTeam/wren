<script setup>
import { computed, onMounted, ref } from 'vue';

import { api } from '@/api/client.js';

const skills = ref([]);
const error = ref('');
const loading = ref(true);

const brokenCount = computed(() => skills.value.filter((s) => !s.valid).length);

onMounted(async () => {
  try {
    skills.value = (await api.listSkills()).skills;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

/**
 * 有问题的 skill 显示为「有问题」并列出原因，即使它在配置里是启用状态——
 * 那种状态交给模型也是坏的，先说清楚。
 */
function statusOf(skill) {
  if (!skill.valid) return { label: '有问题', cls: 'bad' };
  return skill.enabled ? { label: '已启用', cls: 'ok' } : { label: '已停用', cls: 'off' };
}

async function toggle(skill) {
  const next = !skill.enabled;
  error.value = '';
  try {
    await api.setSkillEnabled(skill.name, next);
    skill.enabled = next;
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <h3>Skill</h3>
  <p class="muted small">
    skill 是「怎么把一类事做好」的做法说明，来自内置的 <code>skills/</code> 和本地的
    <code>data/skills/</code>。停用的 skill 不会出现在模型可用的清单里，<code>/名字</code> 也不能用；
    重新启用后，之前在这个会话里用过的 skill 会继续生效。
  </p>
  <p v-if="error" class="error small">{{ error }}</p>
  <p v-if="loading" class="muted small">加载中…</p>
  <p v-else-if="!skills.length" class="muted small">
    还没有 skill。在 <code>skills/</code> 下建一个目录，写一个 SKILL.md 就会出现。
  </p>
  <template v-else>
    <p class="muted small">
      共 {{ skills.length }} 个<span v-if="brokenCount">，其中 {{ brokenCount }} 个有问题（不会交给模型）</span>。
    </p>
    <ul class="skill-list">
      <li v-for="s in skills" :key="s.name" :class="{ broken: !s.valid }">
        <div class="skill-head">
          <label class="switch">
            <input
              type="checkbox"
              :checked="s.valid && s.enabled"
              :disabled="!s.valid"
              @change="toggle(s)"
            />
            <code>{{ s.name }}</code>
          </label>
          <span class="badge" :class="statusOf(s).cls">{{ statusOf(s).label }}</span>
          <span class="muted small skill-source">{{ s.source === 'user' ? '本地' : '内置' }}</span>
        </div>
        <p class="muted small skill-line">{{ s.description || '（没有描述）' }}</p>
        <p v-if="s.allowed_tools.length" class="muted small skill-line">
          需要工具：<code v-for="t in s.allowed_tools" :key="t" class="skill-tool">{{ t }}</code>
        </p>
        <ul v-if="s.problems.length" class="skill-problems">
          <li v-for="(problem, i) in s.problems" :key="i" class="error small">{{ problem }}</li>
        </ul>
        <p class="muted small skill-line skill-path"><code>{{ s.path }}</code></p>
      </li>
    </ul>
  </template>
</template>
