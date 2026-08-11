const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_JSON_BODY = 256 * 1024;

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function parseHostname(authority) {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return '';
  }
}

function allowedOrigins(port, env = process.env) {
  const values = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
  for (const item of String(env.AGENT_LENS_ALLOWED_ORIGINS || '').split(',')) {
    const origin = item.trim().replace(/\/$/, '');
    if (!origin) continue;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) values.add(parsed.origin);
    } catch (_) {}
  }
  return values;
}

function isPathInside(basePath, candidatePath) {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateLocalRequest(req, options = {}) {
  const port = options.port;
  const host = req.headers?.host || '';
  const hostname = parseHostname(host);
  if (!isLoopbackHostname(hostname)) return { ok: false, status: 403, message: '仅允许本机访问' };

  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (remoteAddress && !isLoopbackAddress(remoteAddress)) return { ok: false, status: 403, message: '仅允许本机访问' };

  const origin = req.headers?.origin;
  if (origin) {
    let normalized;
    try { normalized = new URL(origin).origin; } catch { return { ok: false, status: 403, message: '无效的请求来源' }; }
    const origins = options.origins || allowedOrigins(port, options.env);
    if (!origins.has(normalized)) return { ok: false, status: 403, message: '不允许的请求来源' };
    return { ok: true, origin: normalized };
  }
  return { ok: true, origin: null };
}

function applySecurityHeaders(res, origin = null) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function getOrCreateHookToken(filePath, env = process.env) {
  const fromEnv = String(env.AGENT_LENS_HOOK_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch (_) {}

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(filePath, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
  return token;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function validateHookToken(req, expectedToken) {
  const header = req.headers?.['x-agentlens-token'];
  const authorization = req.headers?.authorization || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return safeEqual(header || bearer, expectedToken);
}

function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_JSON_BODY;
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      const error = new Error('Content-Type 必须为 application/json');
      error.statusCode = 415;
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('请求体过大');
        error.statusCode = 413;
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        const error = new Error('请求体不是有效 JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', fail);
  });
}

module.exports = {
  DEFAULT_MAX_JSON_BODY,
  isLoopbackHostname,
  isLoopbackAddress,
  allowedOrigins,
  isPathInside,
  validateLocalRequest,
  applySecurityHeaders,
  getOrCreateHookToken,
  validateHookToken,
  readJsonBody,
};
