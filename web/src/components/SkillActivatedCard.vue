<script setup>
defineProps({ event: { type: Object, required: true } });
</script>

<template>
  <div class="skill-event">
    <span class="badge">Skill</span>
    已启用 <strong>{{ event.name }}</strong>
    <span class="muted small">
      {{ event.source === 'user' ? '用户目录' : '内置' }}{{ event.trigger === 'command' ? ' · 由 /命令触发' : '' }}
    </span>
  </div>
</template>
