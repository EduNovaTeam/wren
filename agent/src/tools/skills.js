/**
 * Skill 相关工具。
 *
 * 两个工具始终对模型可见（exposure: core），但它们只操作 Skill，不直接提供任何外部能力。
 * 具体工具权限由 `SkillRuntime.allowedToolNames()` 在每次模型请求前重新计算。
 */

import { RESOURCE_MAX_CHARS } from '../skills/runtime.js';

/** @type {import('./registry.js').ToolDefinition} */
export const activateSkill = {
  name: 'activate_skill',
  description:
    '启用一个 Skill，读出它的完整操作指引。当用户的任务属于某个 Skill 的适用范围时调用；' +
    '启用后按正文执行，正文提到的模板或资料用 read_skill_resource 读取。重复启用同一个 Skill 不会有副作用。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称，见系统提示里的可用 Skill 列表' },
    },
    required: ['name'],
  },
  exposure: 'core',
  // Skill 正文预算允许到 24k token，工具结果上限要跟着放宽，不能在这里把正文截掉。
  maxResultChars: 200_000,
  async execute({ name }, { skills }) {
    const result = await skills.activate(name, { viaTool: true });
    if (result.status === 'already') {
      return `Skill「${result.skill.name}」已启用，正文已在上下文中。`;
    }
    const source = result.skill.source === 'user' ? '用户目录' : '内置';
    return [
      `已启用 Skill「${result.skill.name}」（来源：${source}）。以下按它的要求执行：`,
      '',
      result.skill.body,
      '',
      '需要正文提到的模板或参考资料时，用 read_skill_resource 读取，path 使用正文里的相对路径。',
    ].join('\n');
  },
};

/** @type {import('./registry.js').ToolDefinition} */
export const readSkillResource = {
  name: 'read_skill_resource',
  description:
    '读取当前会话已激活 Skill 目录下的附属文本文件，例如 references/template.md。' +
    '只有已激活的 Skill 可以读取，只支持 Skill 目录内的相对路径。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称' },
      path: { type: 'string', description: 'Skill 目录内的相对路径，使用 / 分隔' },
    },
    required: ['name', 'path'],
  },
  exposure: 'core',
  async execute({ name, path }, { skills }) {
    const result = await skills.readResource(name, path);
    const header = `Skill「${name}」的 ${path}（共 ${result.totalChars} 字符）：`;
    if (!result.truncated) return `${header}\n---\n${result.text}`;
    return (
      `${header}\n---\n${result.text}\n---\n` +
      `（内容已截断：文件共 ${result.totalChars} 字符，本次返回前 ${RESOURCE_MAX_CHARS} 字符）`
    );
  },
};
