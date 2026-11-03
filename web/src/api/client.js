/**
 * 后端接口的唯一入口。组件不要直接 fetch。
 */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
export async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（例如后端没启动时 Vite 代理返回的错误页）
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `请求失败（${res.status}）`);
  return data;
}

export const api = {
  listSessions: () => request('GET', '/api/sessions'),
  createSession: () => request('POST', '/api/sessions'),
  renameSession: (id, title) => request('PATCH', `/api/sessions/${id}`, { title }),
  deleteSession: (id) => request('DELETE', `/api/sessions/${id}`),
  listTurns: (sessionId) => request('GET', `/api/sessions/${sessionId}/turns`),
  createTurn: (sessionId, content) => request('POST', `/api/sessions/${sessionId}/turns`, { content }),
  stopTurn: (turnId) => request('POST', `/api/turns/${turnId}/stop`),

  getModel: () => request('GET', '/api/settings/model'),
  putModel: (patch) => request('PUT', '/api/settings/model', patch),
  testModel: () => request('POST', '/api/settings/model/test'),
  getTools: () => request('GET', '/api/settings/tools'),
  putTools: (switches) => request('PUT', '/api/settings/tools', switches),
  getSystemPrompt: () => request('GET', '/api/settings/system-prompt'),
  putSystemPrompt: (text) => request('PUT', '/api/settings/system-prompt', { system_prompt: text }),

  listSkills: () => request('GET', '/api/skills'),
  putSkills: (switches) => request('PUT', '/api/skills', switches),
  listSessionSkills: (sessionId) => request('GET', `/api/sessions/${sessionId}/skills`),
  removeSessionSkill: (sessionId, name) =>
    request('DELETE', `/api/sessions/${sessionId}/skills/${encodeURIComponent(name)}`),

  listNotes: () => request('GET', '/api/notes'),
  deleteNote: (id) => request('DELETE', `/api/notes/${id}`),
};

/**
 * 订阅一个回合的事件流（SSE）。服务端会从回合开始补发全部事件，turn_end 后关闭。
 * @param {number} turnId
 * @param {(event: any) => void} onEvent
 * @returns {{ close: () => void, done: Promise<void> }}
 */
export function subscribeTurn(turnId, onEvent) {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`/api/turns/${turnId}/events`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new ApiError(res.status, `订阅回合失败（${res.status}）`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith('data: ')) onEvent(JSON.parse(frame.slice(6)));
      }
    }
  })().catch((err) => {
    if (err?.name !== 'AbortError') throw err;
  });
  return { close: () => controller.abort(), done };
}
