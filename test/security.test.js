const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const path = require('node:path');
const { allowedOrigins, isPathInside, validateLocalRequest, validateHookToken, readJsonBody } = require('../server/security');

function request(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } };
}

test('只接受回环 Host、回环连接和明确允许的 Origin', () => {
  const origins = allowedOrigins(56789, {});
  assert.equal(validateLocalRequest(request({ host: '127.0.0.1:56789', origin: 'http://localhost:5173' }), { port: 56789, origins }).status, 403);
  const devOrigins = allowedOrigins(56789, { AGENT_LENS_ALLOWED_ORIGINS: 'http://localhost:5173' });
  assert.equal(validateLocalRequest(request({ host: '127.0.0.1:56789', origin: 'http://localhost:5173' }), { port: 56789, origins: devOrigins }).ok, true);
  assert.equal(validateLocalRequest(request({ host: '192.168.1.10:56789' }), { port: 56789, origins }).status, 403);
  assert.equal(validateLocalRequest(request({ host: 'localhost:56789', origin: 'https://evil.example' }), { port: 56789, origins }).status, 403);
  assert.equal(validateLocalRequest(request({ host: 'localhost:56789' }, '192.168.1.20'), { port: 56789, origins }).status, 403);
});

test('静态文件只能解析到声明的根目录内', () => {
  const base = path.resolve('C:/tmp/agent-lens/dist');
  assert.equal(isPathInside(base, path.join(base, 'assets/index.js')), true);
  assert.equal(isPathInside(base, path.resolve(base, '../dist-private/secret.txt')), false);
  assert.equal(isPathInside(base, path.resolve(base, '../outside.txt')), false);
});

test('Hook 写入令牌支持专用 Header 和 Bearer，错误令牌被拒绝', () => {
  assert.equal(validateHookToken(request({ 'x-agentlens-token': 'secret' }), 'secret'), true);
  assert.equal(validateHookToken(request({ authorization: 'Bearer secret' }), 'secret'), true);
  assert.equal(validateHookToken(request({ 'x-agentlens-token': 'wrong' }), 'secret'), false);
});

test('Hook JSON 请求限制 Content-Type 和请求体大小', async () => {
  const valid = new PassThrough();
  valid.headers = { 'content-type': 'application/json' };
  const parsedPromise = readJsonBody(valid, { maxBytes: 64 });
  valid.end('{"ok":true}');
  assert.deepEqual(await parsedPromise, { ok: true });

  const invalid = new PassThrough();
  invalid.headers = { 'content-type': 'text/plain' };
  await assert.rejects(readJsonBody(invalid), error => error.statusCode === 415);
});
