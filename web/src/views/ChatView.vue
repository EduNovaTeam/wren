<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { api, subscribeTurn } from '@/api/client.js';
import TurnItem from '@/components/TurnItem.vue';
import { applyEvent, fromStored, newLiveView } from '@/chat/turnView.js';
import { refreshSessions } from '@/stores/sessions.js';

const props = defineProps({ sessionId: { type: String, default: null } });
const router = useRouter();

/** @type {import('vue').Ref<any[]>} */
const turns = ref([]);
const input = ref('');
const error = ref('');
const loading = ref(false);
const sending = ref(false);
const scroller = ref(null);
/** @type {import('vue').Ref<any[]>} */
const sessionSkills = ref([]);
/** @type {{ close: () => void } | null} */
let subscription = null;

const running = computed(() => turns.value.find((t) => t.status === 'running') ?? null);

onMounted(async () => {
  if (!props.sessionId) return;
  loading.value = true;
  try {
    const data = await api.listTurns(props.sessionId);
    turns.value = data.turns.map((t) => reactive(fromStored(t)));
    const live = turns.value.at(-1);
    // 刷新页面时回合可能还在进行：清空已落库的部分，从事件流完整重放。
    if (live?.status === 'running') follow(live.id, live.userText, true);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
    scrollToBottom();
    await loadSessionSkills();
  }
});

async function loadSessionSkills() {
  if (!props.sessionId) {
    sessionSkills.value = [];
    return;
  }
  try {
    sessionSkills.value = (await api.listSessionSkills(props.sessionId)).skills;
  } catch {
    // 会话还没有激活项或 agent 暂时不可用时，不打断对话。
  }
}

/** @param {{ name: string }} skill */
async function removeSkill(skill) {
  if (!props.sessionId) return;
  try {
    await api.removeSessionSkill(props.sessionId, skill.name);
    await loadSessionSkills();
  } catch (err) {
    error.value = err.message;
  }
}

onBeforeUnmount(() => subscription?.close());

/**
 * @param {number} turnId
 * @param {string} userText
 * @param {boolean} [replace]
 */
function follow(turnId, userText, replace = false) {
  const view = reactive(newLiveView(turnId, userText));
  if (replace) turns.value.splice(turns.value.length - 1, 1, view);
  else turns.value.push(view);
  subscription?.close();
  subscription = subscribeTurn(turnId, (event) => {
    applyEvent(view, event);
    scrollToBottom();
    if (event.type === 'skill_activated' || event.type === 'skill_unavailable') {
      loadSessionSkills();
    }
    if (event.type === 'turn_end') {
      loadSessionSkills();
      refreshSessions();
    }
  });
  subscription.done.catch((err) => {
    view.status = 'failed';
    view.error = `事件流中断：${err.message}`;
  });
}

async function send() {
  const text = input.value.trim();
  if (!text || sending.value || running.value) return;
  sending.value = true;
  error.value = '';
  try {
    let sessionId = props.sessionId;
    if (!sessionId) sessionId = String((await api.createSession()).id);
    const { turn_id: turnId } = await api.createTurn(sessionId, text);
    input.value = '';
    if (sessionId !== props.sessionId) {
      // 新会话：跳到会话页，由新页面加载并接上进行中的回合
      await refreshSessions();
      router.replace(`/c/${sessionId}`);
      return;
    }
    follow(turnId, text);
    refreshSessions();
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}

async function stop() {
  if (!running.value) return;
  try {
    await api.stopTurn(running.value.id);
  } catch (err) {
    error.value = err.message;
  }
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = scroller.value;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  });
}
</script>

<template>
  <div class="chat">
    <div ref="scroller" class="chat-scroll">
      <div class="chat-inner">
        <p v-if="loading" class="muted">加载中…</p>
        <div v-else-if="!turns.length" class="empty">
          <h1>有什么可以帮你？</h1>
          <p class="muted">首次使用请先到 <RouterLink to="/settings/model">设置 → 模型</RouterLink> 填写 API key。</p>
        </div>
        <TurnItem v-for="t in turns" :key="t.id" :turn="t" />
      </div>
    </div>
    <div class="composer">
      <p v-if="error" class="error small">{{ error }}</p>
      <div v-if="sessionSkills.length" class="active-skills">
        <span class="muted small">已启用 Skill：</span>
        <span
          v-for="skill in sessionSkills"
          :key="skill.name"
          class="skill-chip"
          :class="{ bad: skill.status !== 'ok' }"
          :title="skill.error || skill.description"
        >
          {{ skill.name }}
          <span v-if="skill.status !== 'ok'" class="skill-chip-note">
            {{ skill.status === 'disabled' ? '已停用' : skill.status === 'unknown' ? '未校验' : '不可用' }}
          </span>
          <button type="button" class="link" title="从本会话移除" @click="removeSkill(skill)">✕</button>
        </span>
      </div>
      <div class="composer-box">
        <textarea
          v-model="input"
          rows="2"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          @keydown="onKeydown"
        />
        <button v-if="running" class="btn danger" @click="stop">停止</button>
        <button v-else class="btn primary" :disabled="!input.trim() || sending" @click="send">发送</button>
      </div>
    </div>
  </div>
</template>
