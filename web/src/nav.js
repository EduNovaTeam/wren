/**
 * 左侧导航底部的入口和设置页的分区。新增页面时在这里登记即可出现在界面上。
 */

import { notesLink } from './features/notes.js';

/** @type {{ to: string, label: string }[]} */
export const sidebarLinks = [notesLink, { to: '/settings', label: '设置' }];

/** @type {{ to: string, label: string }[]} */
export const settingsSections = [
  { to: '/settings/model', label: '模型' },
  { to: '/settings/tools', label: '工具' },
  { to: '/settings/skills', label: 'Skills' },
  { to: '/settings/prompt', label: '系统提示' },
];
