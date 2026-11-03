/**
 * 运行配置：全部来自环境变量（`scripts/dev.mjs` 会读取根目录的 .env 再传进来）。
 * @param {NodeJS.ProcessEnv} [env]
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadConfig(env = process.env) {
  const token = (env.WREN_INTERNAL_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'WREN_INTERNAL_TOKEN 未设置：后端与 agent 之间的内部接口需要共享口令。' +
        '用 `node scripts/dev.mjs` 启动会自动生成；单独启动时请自行设置。',
    );
  }
  const backendPort = env.WREN_BACKEND_PORT || '5280';
  const dataDir = resolve(env.WREN_DATA_DIR || join(REPO_ROOT, 'data'));
  return {
    host: '127.0.0.1',
    port: Number(env.WREN_AGENT_PORT || 5281),
    backendUrl: env.WREN_BACKEND_URL || `http://127.0.0.1:${backendPort}`,
    internalToken: token,
    // 内置 Skill 随仓库走；用户目录默认放在数据目录下，不入库，可用环境变量覆盖。
    builtinSkillsDir: join(REPO_ROOT, 'skills'),
    userSkillsDir: env.WREN_SKILLS_DIR ? resolve(env.WREN_SKILLS_DIR) : join(dataDir, 'skills'),
    // 独立于历史预算的上下文预算（估算 token）。
    // 单个 Skill 正文的上限。内置的错误码速查表约 2.2 万 token，默认值要容得下它；
    // 正文超限时拒绝激活，不做静默截断。总预算限制同时激活多个大 Skill。
    skillBodyBudgetTokens: positiveInt(env.WREN_SKILL_BODY_BUDGET, 24_000),
    skillIndexBudgetTokens: positiveInt(env.WREN_SKILL_INDEX_BUDGET, 1500),
    skillActiveBudgetTokens: positiveInt(env.WREN_SKILL_ACTIVE_BUDGET, 40_000),
  };
}

/**
 * @param {string|undefined} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** @typedef {ReturnType<typeof loadConfig>} AgentConfig */
