<script setup>
defineProps({ event: { type: Object, required: true } });
</script>

<template>
  <div class="skill-event warn">
    <span class="badge danger">Skill</span>
    <strong>{{ event.name }}</strong> 不可用：{{ event.reason }}
  </div>
</template>
