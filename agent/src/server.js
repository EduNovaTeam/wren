/**
 * agent 的 HTTP 入口（只监听 127.0.0.1，只接受带内部口令的请求）。
 *
 *   GET  /health
 *   GET  /tools                    工具清单（设置页用）
 *   GET  /skills                   Skill 清单与校验结果（设置页用，不含正文）
 *   POST /turns                    {session_id, turn_id} → NDJSON 事件流，直到 turn_end
 *   POST /turns/:id/abort          停止进行中的回合
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { BackendClient } from './backend.js';
import { loadConfig } from './config.js';
import { DEFAULT_SECTIONS } from './context.js';
import { loadCatalog } from './skills/catalog.js';
import { createToolRegistry } from './tools/index.js';
import { runTurn } from './turn.js';

const BODY_MAX = 64 * 1024;

/**
 * @param {object} options
 * @param {import('./config.js').AgentConfig} options.config
 * @param {Partial<import('./turn.js').TurnDeps>} [options.deps]  测试时替换依赖
 */
export function createAgentServer({ config, deps = {} }) {
  const backend = deps.backend ?? new BackendClient(config.backendUrl, config.internalToken);
  const skillOptions = deps.skillOptions ?? {
    builtinDir: config.builtinSkillsDir,
    userDir: config.userSkillsDir,
    bodyBudgetTokens: config.skillBodyBudgetTokens,
    indexBudgetTokens: config.skillIndexBudgetTokens,
    totalBodyBudgetTokens: config.skillActiveBudgetTokens,
  };
  /** @type {import('./turn.js').TurnDeps} */
  const turnDeps = {
    registry: deps.registry ?? createToolRegistry(),
    sections: deps.sections ?? DEFAULT_SECTIONS,
    backend,
    skillOptions,
    complete: deps.complete,
  };
  /** @type {Map<number, AbortController>} */
  const running = new Map();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://agent');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, running: running.size });
      }
      if (!authorized(req, config.internalToken)) return json(res, 401, { error: '内部口令错误' });

      if (req.method === 'GET' && url.pathname === '/tools') {
        return json(res, 200, { tools: turnDeps.registry.list() });
      }
      if (req.method === 'GET' && url.pathname === '/skills') {
        const catalog = await loadCatalog({
          ...turnDeps.skillOptions,
          toolNames: turnDeps.registry.toolNames(),
        });
        return json(res, 200, { skills: catalog.list(), errors: catalog.errors });
      }
      if (req.method === 'POST' && url.pathname === '/turns') {
        const body = await readJson(req);
        return await handleTurn(body, res);
      }
      const abort = url.pathname.match(/^\/turns\/(\d+)\/abort$/);
      if (req.method === 'POST' && abort) {
        const controller = running.get(Number(abort[1]));
        controller?.abort(new Error('用户停止'));
        return json(res, 200, { aborted: Boolean(controller) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });

  /**
   * @param {any} body
   * @param {import('node:http').ServerResponse} res
   */
  async function handleTurn(body, res) {
    const turnId = Number(body?.turn_id);
    if (!Number.isInteger(turnId) || turnId <= 0) return json(res, 400, { error: 'turn_id 不合法' });
    if (running.has(turnId)) return json(res, 409, { error: '回合已在运行' });

    const controller = new AbortController();
    running.set(turnId, controller);
    // 后端断开（例如强制停止）时同样中止回合。
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('后端连接断开'));
    });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    /** @param {import('./types.js').TurnEvent} event */
    const emit = (event) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      let ctx;
      try {
        ctx = await backend.turnContext(turnId);
      } catch (err) {
        emit({ type: 'turn_end', status: 'failed', error: `读取回合上下文失败：${String(err)}` });
        return;
      }
      await runTurn(ctx, turnDeps, emit, controller.signal);
    } finally {
      running.delete(turnId);
      res.end();
    }
  }

  return server;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 */
function authorized(req, token) {
  const given = Buffer.from(String(req.headers['x-wren-internal-token'] ?? ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  createAgentServer({ config }).listen(config.port, config.host, () => {
    console.log(`[agent] listening on http://${config.host}:${config.port}`);
  });
}
