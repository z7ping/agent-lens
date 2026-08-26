const target = process.argv[2]

function missing(names) {
  return names.filter(name => !process.env[name]?.trim())
}

function fail(message, names = []) {
  console.error(`[release-signing] ${message}`)
  for (const name of names) console.error(`  - 缺少环境变量：${name}`)
  process.exitCode = 1
}

if (target === 'windows') {
  const required = ['CSC_LINK', 'CSC_KEY_PASSWORD']
  const absent = missing(required)
  if (absent.length) fail('Windows 正式 Release 必须配置代码签名证书，禁止生成未签名公开安装包。', absent)
  else console.log('[release-signing] Windows 代码签名凭据已配置。')
} else if (target === 'macos') {
  const signing = missing(['CSC_LINK', 'CSC_KEY_PASSWORD'])
  if (signing.length) {
    fail('macOS 正式 Release 必须配置 Developer ID Application 证书。', signing)
  } else {
    const appleIdAuth = missing(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    const apiKeyAuth = missing(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
    if (appleIdAuth.length && apiKeyAuth.length) {
      fail('macOS 正式 Release 必须配置 Apple 公证凭据。支持 Apple ID 或 App Store Connect API Key 两种方式。')
      console.error('  Apple ID 方式：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID')
      console.error('  API Key 方式：APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER')
      process.exitCode = 1
    } else {
      console.log(`[release-signing] macOS Developer ID 与公证凭据已配置（${apiKeyAuth.length === 0 ? 'API Key' : 'Apple ID'}）。`)
    }
  }
} else {
  console.error('用法：node scripts/check-release-signing.mjs <windows|macos>')
  process.exitCode = 2
}
