import assert from 'node:assert/strict'
import test from 'node:test'
import { commandsToWorkspaceActions, parseHermesHelpCommands, probeHermesWorkspaceActions } from './workspace-action-capabilities.js'

test('native argparse choices, not help prose, authorize individual Hermes commands',()=>{
  const boards=parseHermesHelpCommands('usage: hermes kanban boards {list,create,rename,rm}\n')
  const kanban=parseHermesHelpCommands('usage: hermes kanban {create,edit,assign,link,unlink,archive,block,unblock,complete,promote}\n')
  const cron=parseHermesHelpCommands('usage: hermes cron {list,create,edit,pause,resume,remove,cancel,run}\n')
  const actions=commandsToWorkspaceActions([boards,kanban,cron])
  assert.ok(actions.includes('board.archive'))
  assert.ok(actions.includes('task.unblock'))
  assert.ok(actions.includes('cron.run'))
  assert.ok(actions.includes('cron.cancel'))
  assert.equal(actions.length,21)
})

test('unknown, partially supported and misleading help output fail closed',()=>{
  assert.equal(commandsToWorkspaceActions([new Set(),new Set(),new Set()]).length,0)
  const misleading=parseHermesHelpCommands('You can create or run cron jobs, but this CLI has no subcommand usage.')
  assert.equal(misleading.size,0)
  const oldCron=parseHermesHelpCommands('usage: hermes cron {list,create,pause}\n')
  const actions=commandsToWorkspaceActions([new Set(),new Set(),oldCron])
  assert.deepEqual(actions,['cron.create','cron.pause'])
  const multiline=parseHermesHelpCommands('usage: hermes cron {list,create,edit,\n    pause,resume,run}')
  assert.ok(multiline.has('create'))
  assert.ok(multiline.has('run'))
})

test('CLI discovery rejects unverified roots without probing PATH',async()=>{
  assert.deepEqual(await probeHermesWorkspaceActions({roots:['relative/not-authorized']}),[])
  assert.deepEqual(await probeHermesWorkspaceActions({roots:[]}),[])
})
