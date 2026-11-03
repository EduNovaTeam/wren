import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** @type {import('./registry.js').ToolDefinition} */
export const currentTime = {
  name: 'current_time',
  description: '获取当前日期时间。需要知道「今天」「现在」「本周」等时才调用。',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai；省略时用本机时区' },
    },
  },
  execute({ timezone }) {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const text = new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(new Date());
      return { timezone: tz, now: text, iso: new Date().toISOString() };
    } catch {
      throw new Error(`未知时区：${timezone}`);
    }
  },
};

const FETCH_MAX_BYTES = 2_000_000;

/**
 * 抓取网页正文。默认不对模型开放（exposure: on-demand），由上层按需开放。
 * @type {import('./registry.js').ToolDefinition}
 */
export const fetchUrl = {
  name: 'fetch_url',
  description:
    '抓取一个公开网页，返回去掉标签后的正文文本（最多约 2 万字）。' +
    '按需工具：只有已激活的 Skill 声明需要它时才可用。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http 或 https 地址' },
    },
    required: ['url'],
  },
  exposure: 'on-demand',
  timeoutMs: 20_000,
  async execute({ url }, { signal }) {
    const target = await assertPublicUrl(url);
    const res = await fetch(target, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Wren/0.1 (+fetch_url)', Accept: 'text/html,text/plain,*/*' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      return { status: res.status, redirect: location ? new URL(location, target).href : null,
        note: '目标发生跳转，如需继续请用新地址再次调用。' };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xml|xhtml))/.test(type)) {
      return { status: res.status, content_type: type, note: '不是文本内容，未读取。' };
    }
    const raw = await readLimited(res, FETCH_MAX_BYTES);
    const text = type.includes('html') ? htmlToText(raw) : raw;
    return { status: res.status, url: res.url || target.href, text };
  },
};

/** @param {unknown} url */
async function assertPublicUrl(url) {
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw new Error('url 不合法');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('只支持 http/https');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw new Error('不允许访问本机或内网地址');
  return target;
}

/** @param {string} ip */
export function isPrivateAddress(ip) {
  let text = String(ip ?? '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const family = isIP(text);
  if (family === 4) return isPrivateIPv4(text);
  if (family === 6) return isPrivateIPv6(text);
  // 无法判断的地址一律按私有处理，避免新写法绕过检查。
  return true;
}

/** @param {string} ip */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** @param {string} ip */
function isPrivateIPv6(ip) {
  const groups = ipv6Groups(ip);
  if (!groups) return true;

  const embedded = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4 映射地址（::ffff:0:0/96）：`http://[::ffff:127.0.0.1]/` 会被 URL 规范化成
  // `::ffff:7f00:1`，必须还原成 IPv4 再判断。
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(embedded(groups[6], groups[7]));
  }
  // IPv4 兼容地址（已废弃，但解析器仍可能遇到）。
  if (groups.slice(0, 6).every((g) => g === 0)) {
    return isPrivateIPv4(embedded(groups[6], groups[7]));
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // 文档地址
  if (groups[0] === 0x2002) return true; // 6to4 可能内嵌内网 IPv4
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return true; // NAT64 可能把请求转给内网 IPv4
  }
  return false;
}

/**
 * 把 IPv6 字符串拆成 8 个 16 位整数；非法时返回 null。
 * @param {string} ip
 * @returns {number[] | null}
 */
function ipv6Groups(ip) {
  let text = ip;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.includes('.')) {
    const idx = text.lastIndexOf(':');
    if (idx === -1) return null;
    const v4 = text.slice(idx + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, idx + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const total = head.length + tail.length;
  if (halves.length === 2 ? total > 7 : total !== 8) return null;
  const parts = [...head, ...Array(8 - total).fill('0'), ...tail];
  const groups = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/**
 * @param {Response} res
 * @param {number} max
 */
async function readLimited(res, max) {
  if (!res.body) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
    if (size >= max) break;
  }
  return out;
}

/** @param {string} html */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
