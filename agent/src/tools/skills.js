/**
 * skill 工具：按需读取 skills/ 下某个 skill 的完整说明。
 *
 * 系统提示里不列 skill，只说「有需要就查」。所以这个工具要承担两个职责：
 * 不带 name 时返回清单，带 name 时返回正文。用不到的 skill 一个字都不占上下文。
 * 说明里引用的附带文件（模板、规范）也通过它读，参数是 skill 目录内的相对路径。
 */

/** @type {import('./registry.js').ToolDefinition} */
export const useSkill = {
  name: 'use_skill',
  description:
    '查看或读取 skill。不带参数时返回可用 skill 的清单（名字与一句话描述）；带上 name 时返回该 skill 的完整说明。'
    + '用户的要求像是有一套现成做法可循时，先查看清单，再读取对应的说明照着做；说明里提到的附带文件（模板、规范）可再带 file 读取。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称，取自清单；省略则只返回清单' },
      file: {
        type: 'string',
        description: '可选：该 skill 目录内的相对路径，例如 references/style.md；需要同时提供 name',
      },
    },
  },
  timeoutMs: 15_000,
  async execute({ name, file }, { backend, sessionId, signal }) {
    const skillName = String(name ?? '').trim();
    const relative = String(file ?? '').trim();

    if (!skillName) {
      if (relative) throw new Error('读取附带文件需要同时提供 name');
      return renderList(await backend.listSkills(signal));
    }
    if (relative) {
      const found = await backend.getSkillFile(skillName, relative, signal);
      return found.content;
    }

    const skill = await backend.getSkill(skillName, signal);
    // 读过正文就算用上了：记进会话，后续回合继续带上。失败不影响本回合的结果。
    await backend.activateSkill(sessionId, skill.name, signal).catch(() => {});
    const lines = [`# ${skill.name}`, '', skill.description, '', skill.body];
    if (skill.files?.length) {
      lines.push('', `附带文件（需要时带 file 参数再读）：${skill.files.join('、')}`);
    }
    // 这里不要写「它的工具下一回合起才能用」：工具结果会永久留在历史里，
    // 模型下一回合读到这句会继续等，明明工具已经开放了也坚持说没有。
    // 工具是否可用由每回合重新生成的系统提示说明。
    return lines.join('\n');
  },
};

/**
 * @param {{ skills: import('../types.js').SkillSummary[] }} data
 * @returns {string}
 */
function renderList({ skills }) {
  if (!skills.length) return '当前没有可用的 skill。';
  return [
    `可用的 skill（${skills.length} 个）：`,
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
    '',
    '需要时用 use_skill(name) 读取其中某个的完整说明。',
  ].join('\n');
}
