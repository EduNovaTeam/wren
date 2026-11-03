/**
 * Skill 功能在前端的接入点：对话里的事件卡片。
 */

import { registerEventRenderer } from '@/chat/renderers.js';
import SkillActivatedCard from '@/components/SkillActivatedCard.vue';
import SkillUnavailableCard from '@/components/SkillUnavailableCard.vue';

registerEventRenderer('skill_activated', SkillActivatedCard);
registerEventRenderer('skill_unavailable', SkillUnavailableCard);
