/**
 * 技能功能在前端的全部接入点：设置分区、路由、对话里的 skill_activated 卡片。
 */

import { registerEventRenderer } from '@/chat/renderers.js';
import SkillActivatedCard from '@/components/SkillActivatedCard.vue';

registerEventRenderer('skill_activated', SkillActivatedCard);

/** @type {{ to: string, label: string }} */
export const skillsSection = { to: '/settings/skills', label: '技能' };

/** @type {import('vue-router').RouteRecordRaw} */
export const skillsRoute = {
  path: 'skills',
  name: 'settings-skills',
  component: () => import('../views/settings/SkillsSettings.vue'),
};
