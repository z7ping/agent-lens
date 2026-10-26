import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOfflineMetricArgs } from './slim-rebuild-metrics-all'

test('one-off metric rebuild requires an explicit staging database and safe budgets',()=>{
  assert.throws(()=>parseOfflineMetricArgs([]),/explicit --staging/)
  assert.throws(()=>parseOfflineMetricArgs(['--staging','a.db','--max-sessions','5001']),
    /session budget/)
  assert.throws(()=>parseOfflineMetricArgs(['--staging','a.db','--max-pages','16385']),
    /page budget/)
  assert.throws(()=>parseOfflineMetricArgs(['--staging','a.db','--max-pages','0']),
    /page budget/)
  assert.throws(()=>parseOfflineMetricArgs(['--staging','a.db','--staging','b.db']),
    /Invalid offline metrics argument/)
  const output=parseOfflineMetricArgs(['--staging','new.sqlite','--max-sessions','64'])
  assert.equal(output.maxSessions,64)
  assert.equal(output.maxPages,16384)
})


test('offline budget remains exact below one 64-page native reader slice',()=>{
  const one=parseOfflineMetricArgs(['--staging','slim.sqlite','--max-pages','1'])
  assert.equal(one.maxPages,1)
  const sixtyFive=parseOfflineMetricArgs(['--staging','slim.sqlite','--max-pages','65'])
  assert.equal(sixtyFive.maxPages,65)
})
