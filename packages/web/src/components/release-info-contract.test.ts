import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ReleaseInfo.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../release-info.css', import.meta.url), 'utf8')
const overlayStyles = readFileSync(new URL('./ui/overlay.css', import.meta.url), 'utf8')

test('更新日志和新版本提示统一复用标准 Dialog，不维护第二套 backdrop', () => {
  assert.match(source, /import \{ Button, Dialog \} from '\.\/ui'/)
  assert.match(source, /<Dialog[\s\S]*?title="更新日志"/)
  assert.match(source, /<Dialog[\s\S]*?title="发现新版本"/)
  assert.doesNotMatch(source, /release-dialog-backdrop/)
  assert.doesNotMatch(source, /release-dialog-close/)
  assert.doesNotMatch(styles, /\.release-dialog-backdrop/)
  assert.match(overlayStyles, /\.ui-overlay \{[\s\S]*?z-index: 1400;/)
})
