/**
 * 调用后端内部接口（/internal/*）的客户端。工具需要读写持久化数据时也走这里，
 * agent 自身不保存任何跨回合状态。
 */
export class BackendClient {
  /**
   * @param {string} baseUrl
   * @param {string} token
   */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  /**
   * @param {string} method
   * @param {string} path 以 /internal/ 开头
   * @param {unknown} [body]
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async request(method, path, body, signal) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'X-Wren-Internal-Token': this.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new BackendError(res.status, data?.error ?? text.slice(0, 300));
    }
    return data;
  }

  /**
   * @param {number} turnId
   * @returns {Promise<import('./types.js').TurnContext>}
   */
  turnContext(turnId) {
    return this.request('GET', `/internal/turns/${turnId}/context`);
  }

  /**
   * 可用的 skill 清单（只有名字与描述）。
   * 带上会话：用户退出过的 skill 不该再出现在清单里，否则模型翻到它又会用起来。
   * @param {number} sessionId
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ skills: import('./types.js').SkillSummary[] }>}
   */
  listSkills(sessionId, signal) {
    return this.request('GET', `/internal/skills${withSession(sessionId)}`, undefined, signal);
  }

  /**
   * 把 skill 记为会话级生效，后续回合继续带上它的正文。
   * @param {number} sessionId
   * @param {string} name
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ skills: string[] }>}
   */
  activateSkill(sessionId, name, signal) {
    return this.request('POST', `/internal/sessions/${sessionId}/skills`, { name }, signal);
  }

  /**
   * 一个 skill 的正文与附带文件列表。
   * @param {number} sessionId
   * @param {string} name
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ name: string, description: string, body: string, files: string[] }>}
   */
  getSkill(sessionId, name, signal) {
    return this.request(
      'GET',
      `/internal/skills/${encodeURIComponent(name)}${withSession(sessionId)}`,
      undefined,
      signal,
    );
  }

  /**
   * skill 目录内的一个附带文件。
   * @param {number} sessionId
   * @param {string} name
   * @param {string} file  相对路径，例如 references/style.md
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ path: string, content: string }>}
   */
  getSkillFile(sessionId, name, file, signal) {
    const path = file.split('/').map(encodeURIComponent).join('/');
    return this.request(
      'GET',
      `/internal/skills/${encodeURIComponent(name)}/files/${path}${withSession(sessionId)}`,
      undefined,
      signal,
    );
  }
}

/**
 * 内部接口的 `?session=` 参数。
 * @param {number} sessionId
 * @returns {string}
 */
function withSession(sessionId) {
  return `?session=${encodeURIComponent(String(sessionId))}`;
}

export class BackendError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(`后端 ${status}：${message}`);
    this.status = status;
  }
}
