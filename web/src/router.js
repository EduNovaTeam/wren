import { createRouter, createWebHistory } from 'vue-router';

import { notesRoute } from './features/notes.js';
import { skillsRoute } from './features/skills.js';
import ChatView from './views/ChatView.vue';
import SettingsView from './views/SettingsView.vue';

/**
 * 页面路由。新增页面：在这里加路由；需要出现在左侧导航的，同时加到 `nav.js`。
 * @type {import('vue-router').RouteRecordRaw[]}
 */
export const routes = [
  { path: '/', name: 'home', component: ChatView },
  { path: '/c/:sessionId(\\d+)', name: 'chat', component: ChatView, props: true },
  notesRoute,
  {
    path: '/settings',
    component: SettingsView,
    children: [
      { path: '', redirect: '/settings/model' },
      { path: 'model', name: 'settings-model', component: () => import('./views/settings/ModelSettings.vue') },
      { path: 'tools', name: 'settings-tools', component: () => import('./views/settings/ToolSettings.vue') },
      { path: 'prompt', name: 'settings-prompt', component: () => import('./views/settings/PromptSettings.vue') },
      skillsRoute,
    ],
  },
];

export const router = createRouter({ history: createWebHistory(), routes });
