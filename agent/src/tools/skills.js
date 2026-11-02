/**
 * skill 工具：按需读取 skills/ 下某个 skill 的完整说明。
 *
 * 系统提示里只有名字和一句话描述；正文在模型真正要用时取，用不到的 skill 不占上下文。
 * 说明里引用的附带文件（模板、规范）也通过这个工具读，参数是 skill 目录内的相对路径。
 */

/** @type {import('./registry.js').ToolDefinition} */
export const useSkill = {
  name: 'use_skill',
  description:
    '读取一个 skill 的完整说明。系统提示里列出了可用的 skill：用户的要求正好属于其中某一类时，先调用它拿到做法，再按说明执行。'
    + '说明里如果提到附带文件（模板、规范等），再次调用并传 file 读取。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称，取自系统提示里的清单' },
      file: {
        type: 'string',
        description: '可选：该 skill 目录内的相对路径，例如 references/style.md',
      },
    },
    required: ['name'],
  },
  timeoutMs: 15_000,
  async execute({ name, file }, { backend, signal }) {
    const skillName = String(name ?? '').trim();
    if (!skillName) throw new Error('name 不能为空');

    if (file) {
      const found = await backend.getSkillFile(skillName, String(file).trim(), signal);
      return found.content;
    }

    const skill = await backend.getSkill(skillName, signal);
    const lines = [`# ${skill.name}`, '', skill.description, '', skill.body];
    if (skill.files?.length) {
      lines.push('', `附带文件（需要时带 file 参数再读）：${skill.files.join('、')}`);
    }
    return lines.join('\n');
  },
};
