import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type {
  DetectedSource,
  ObservationCapability,
  SourceDefinition,
  SourcePluginManifest,
  SourceRecord,
} from '@agent-lens/core'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { readAuthorizedNativeJsonlEntry, readNativeSessionWindow,
  readNativeJsonlTextFragments, inspectNativeSessionRecordSpan,
  authorizeNativeSessionPath, verifyJsonlLineSha256 } from '@agent-lens/source-support'
import { discoverPiAssets, piAssetInternals } from './assets'
import { PI_PARSER_VERSION, PI_SOURCE_ID } from './constants'
import { normalizePiRecord } from './normalize'
import {
  detectPi,
  ingestPiHistory,
  listJsonlFiles,
  readPiSessionMetadata,
  readPiSessionTailMetadata,
  piSessionInternals,
  startPiRuntimeCapture,
} from './session'

export async function declarePiCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: PI_SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'context', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'model-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'thinking-level-change', status: 'available', captureModes: ['history', 'native-tail'] },
    {
      sourceId: PI_SOURCE_ID,
      name: 'asset-discovery',
      status: 'partial',
      captureModes: ['static-scan'],
      reason: 'Persisted Pi resources are resolved statically; external CLI-only and runtime extension-discovered resources require invocation/runtime evidence',
    },
    { sourceId: PI_SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'No stable permission event is proven in the native session log' },
    { sourceId: PI_SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history'], reason: 'Parent session links are retained; explicit subagent lifecycle is not proven' },
    { sourceId: PI_SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: PI_SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: PI_SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const piManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-pi',
  pluginVersion: '1.0.0',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Pi Source',
  sourceId: PI_SOURCE_ID,
  productId: PI_SOURCE_ID,
  parserVersion: PI_PARSER_VERSION,
}

const jsonlRawRecovery: NonNullable<SourceDefinition['rawRecovery']> = {
  describe(record) {
    const stable = record.locator.kind === 'file'
      && Boolean(record.locator.path)
      && record.locator.offset !== undefined
      && Boolean(record.fingerprint)
    return stable
      ? {
          authority: 'native-store',
          locatorStability: 'stable',
          mutability: 'append-oriented',
          verification: 'fingerprint',
          canReread: true,
          canReparse: true,
          replayable: true,
          persistencePreference: 'reference',
        }
      : {
          authority: record.locator.kind === 'runtime-hook' ? 'agent-lens-only' : 'unknown',
          locatorStability: 'none',
          mutability: record.locator.kind === 'runtime-hook' ? 'ephemeral' : 'unknown',
          verification: 'none',
          canReread: false,
          canReparse: false,
          replayable: false,
          persistencePreference: 'preserve',
          reason: record.locator.kind === 'runtime-hook'
            ? 'runtime-hook source is consumed from an ephemeral inbox'
            : 'record does not expose a stable JSONL path+offset+fingerprint locator',
        }
  },
  async hydrate(record, ctx) {
    const read = await readAuthorizedNativeJsonlEntry({
      reference: record,
      installationId: ctx.installation.id,
      sourceId: PI_SOURCE_ID,
      parserVersion: PI_PARSER_VERSION,
      allowedRoots: ctx.installation.dataRoot ? [ctx.installation.dataRoot] : [],
      abortSignal: ctx.abortSignal,
    })
    if (read.state !== 'available') return read
    ctx.abortSignal.throwIfAborted()
    const session = await readPiSessionMetadata(read.canonicalPath)
    if (record.sourceSessionNativeId && session.nativeSessionId !== record.sourceSessionNativeId) {
      return { state: 'drifted', reason: 'source-native-session-identity-changed' }
    }
    // Transient payload: only the existing Source normalizer receives it.
    return { state: 'available', record: { ...record, payload: { entry: read.entry, session } } }
  },
  async verify(record) {
    const result = await verifyJsonlLineSha256({
      ...(record.locator.path === undefined ? {} : { path: record.locator.path }),
      ...(record.locator.offset === undefined ? {} : { offset: record.locator.offset }),
      ...(record.fingerprint === undefined ? {} : { expectedFingerprint: record.fingerprint }),
    })
    return {
      ...result,
      checkedAt: new Date().toISOString(),
    }
  },
}

/** Evidence-complete recovery only when ONE huge inline image makes a Pi
 * user/assistant record oversized and all semantic text/Thinking and tool
 * arguments fit the bounded Source window. Never invent missing fields.
 */
async function readPiVerifiedLargeImagePage(
  query:Parameters<NonNullable<SourceDefinition['readNativeSessionPage']>>[0],
  ctx:Parameters<NonNullable<SourceDefinition['readNativeSessionPage']>>[1],
):ReturnType<NonNullable<SourceDefinition['readNativeSessionPage']>>{
  const roots=ctx.installation.dataRoot?[ctx.installation.dataRoot]:[]
  const scan=await inspectNativeSessionRecordSpan({
    path:query.filePath,allowedRoots:roots,
    ...(query.cursor?{cursor:query.cursor}:{}),
    signal:ctx.abortSignal,
  })
  if(scan.state!=='available')
    return {state:scan.state==='pending'?'unsupported':scan.state,
      reason:scan.state==='pending'?'native-record-pending-tail':scan.reason}
  if(!scan.span.oversized)
    return {state:'unsupported',reason:'native-large-record-not-oversized'}
  const read=await readNativeJsonlTextFragments({
    path:query.filePath,allowedRoots:roots,
    ...(query.cursor?{cursor:query.cursor}:{}),
    expectedSha256:scan.span.sha256,fragmentOffset:0,limit:16,
    signal:ctx.abortSignal,
  })
  if(read.state!=='available')
    return {state:read.state==='pending'?'unsupported':read.state,
      reason:read.state==='pending'?'native-record-pending-tail':read.reason}
  const original=read.record
  if(query.cursor?.recordFingerprint
    &&query.cursor.recordFingerprint!==original.sourceLineSha256)
    return {state:'drifted',reason:'native-record-fingerprint-changed'}
  const blocks=original.contentBlocks
  const imageBlocks=blocks.filter(block=>block.kind==='image')
  const verifiedImages=new Map(original.images.map(info=>[info.contentIndex,info]))
  const assistant=original.role==='assistant'
  const toolResult=original.role==='tool'||original.role==='toolResult'
  const scalar=(toolResult?original.strictLargeToolResultShape
    :original.strictLargeScalarShape)&&original.scalarContentVerified
    &&(original.role==='user'||assistant
      ||toolResult&&Boolean(original.nativeResultCallId)
        &&Boolean(original.nativeResultToolName)
        &&original.nativeResultIsError!==undefined)
    &&original.nativeType==='message'&&Boolean(original.nativeEventId)
    &&original.recordSha256===scan.span.sha256
    &&original.fileIdentity===scan.span.fileIdentity
    &&blocks.length===0&&original.images.length===0
    &&original.totalTextFragments>16&&original.fragments.length===16
    &&original.fragments.every(piece=>piece.kind===(toolResult?'tool-result':'message')
      &&piece.contentIndex===undefined)
  if(!scalar && (!(assistant?original.strictLargeAssistantShape:original.strictImageUserShape)
    ||original.nativeType!=='message'
    ||(original.role!=='user'&&!assistant)
    ||!original.nativeEventId||original.recordSha256!==scan.span.sha256
    ||original.fileIdentity!==scan.span.fileIdentity
    ||original.contentBlocksTruncated||original.imagesTruncated
    ||imageBlocks.length<1||imageBlocks.length>4
    ||original.images.length!==imageBlocks.length
    ||imageBlocks.some(block=>!verifiedImages.has(block.contentIndex)
      ||!verifiedImages.get(block.contentIndex)?.mimeType)
    ||blocks.length===0||blocks.length>64
    ||blocks.some((block,index)=>block.contentIndex!==index
      ||(assistant
        ?!['text','thinking','tool-call','image'].includes(block.kind)
        :block.kind!=='text'&&block.kind!=='image'))
    ||(assistant&&blocks.some(block=>block.kind==='tool-call'
      &&(!block.nativeCallId||!block.name||!block.verifiedArguments
        ||block.fragmentCount!==original.fragments.filter(piece=>
          piece.contentIndex===block.contentIndex).length)))
    ||(assistant&&new Set(blocks.filter(block=>block.kind==='tool-call')
      .map(block=>block.nativeCallId)).size
      !==blocks.filter(block=>block.kind==='tool-call').length)
    ||original.totalTextFragments!==original.fragments.length
    ||original.totalTextFragments>16
    ||original.fragments.some(fragment=>
      fragment.contentIndex===undefined
      ||!blocks.some(block=>block.contentIndex===fragment.contentIndex
        &&(block.kind==='text'&&fragment.kind==='message'
          ||assistant&&block.kind==='thinking'&&fragment.kind==='thinking'
          ||assistant&&block.kind==='tool-call'&&fragment.kind==='tool-call')))
    ||blocks.some(block=>['text','thinking'].includes(block.kind)
      &&(block.fragmentCount===0
        ||original.fragments.filter(piece=>piece.contentIndex===block.contentIndex)
          .length!==block.fragmentCount))))
    return {state:'unsupported',reason:'native-record-too-large'}

  // Reuse the existing image validator; a MIME label and a JSON string by
  // themselves do not prove the original base64 image payload is well formed.
  if(!scalar){
    // Each original media payload must be independently verified; same-MIME
    // pictures remain distinct by original content[] ordinal, never order-
    // guessed by the client. Four images cap repeated streaming passes.
    for(const image of imageBlocks){
      const media=await readNativeJsonlTextFragments({
        path:query.filePath,allowedRoots:roots,
        ...(query.cursor?{cursor:query.cursor}:{}),
        expectedSha256:scan.span.sha256,fragmentOffset:0,limit:1,
        media:{contentIndex:image.contentIndex,offset:0,limit:4},
        signal:ctx.abortSignal,
      })
      if(media.state!=='available'){
        if(media.state==='drifted'||media.state==='unavailable')return {state:media.state,reason:media.reason}
        return {state:'unsupported' as const,reason:'native-record-too-large'}
      }
      if(media.record.recordSha256!==scan.span.sha256)
        return {state:'drifted' as const,reason:'native-record-hash-changed'}
      if(media.record.media?.contentIndex!==image.contentIndex
        ||media.record.media.mimeType!==verifiedImages.get(image.contentIndex)?.mimeType)
        return {state:'unsupported' as const,reason:'native-record-too-large'}
    }
  }

  const auth=await authorizeNativeSessionPath(query.filePath,roots)
  if(auth.state!=='authorized')return auth
  const before=await stat(auth.sourcePath)
  if(!before.isFile()||`${before.dev}:${before.ino}`!==scan.span.fileIdentity)
    return {state:'drifted',reason:'native-file-identity-changed'}
  const session=await readPiSessionMetadata(auth.sourcePath)
  if(session.nativeSessionId!==query.nativeSessionId)
    return {state:'drifted',reason:'native-session-identity-changed'}
  const after=await stat(auth.sourcePath)
  if(!after.isFile()||after.dev!==before.dev||after.ino!==before.ino
    ||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
    return {state:'drifted',reason:'native-file-changed-after-semantic-scan'}
  const content=scalar?'':blocks.map(block=>{
    if(block.kind==='image')
      return {type:'image',mimeType:verifiedImages.get(block.contentIndex)!.mimeType,
        nativeContentIndex:block.contentIndex}
    if(block.kind==='tool-call')
      return {type:'toolCall',id:block.nativeCallId!,name:block.name!,
        arguments:block.verifiedArguments!}
    const text=original.fragments.filter(x=>x.contentIndex===block.contentIndex)
      .map(x=>x.text).join('')
    return block.kind==='thinking'?{type:'thinking',thinking:text}
      :{type:'text',text}
  })
  const start=scan.span.offset
  const sequence=(query.cursor?.sequence??0)+1
  const recordHash=createHash('sha256')
    .update(`${query.filePath}|${start}|${original.sourceLineSha256}`)
    .digest('hex').slice(0,32)
  const timestamp=original.nativeTimestamp
    &&Number.isFinite(Date.parse(original.nativeTimestamp))
    ?new Date(original.nativeTimestamp).toISOString():undefined
  const entry={
    type:'message',id:original.nativeEventId,
    ...(original.nativeParentId?{parentId:original.nativeParentId}:{}),
    ...(timestamp?{timestamp}:{}),
    message:{role:original.role,content,
      ...(assistant?original.assistantMeta??{}:{}),
      ...(scalar&&toolResult?{
        toolCallId:original.nativeResultCallId!,
        toolName:original.nativeResultToolName!,
        isError:original.nativeResultIsError!,
      }:{})},
  }
  const record:SourceRecord={
    id:`pi-record-${recordHash}`,sourceId:PI_SOURCE_ID,
    installationId:ctx.installation.id,
    sourceSessionNativeId:session.nativeSessionId,nativeType:'history/message',
    ...(original.nativeEventId ? {nativeId:original.nativeEventId} : {}),sourceSequence:sequence*1000,
    ...(timestamp?{occurredAt:timestamp}:{}),
    capturedAt:new Date().toISOString(),
    locator:{kind:'file',path:query.filePath,offset:start},
    fingerprint:original.sourceLineSha256,parserVersion:PI_PARSER_VERSION,
    // The proof lives OUTSIDE the untrusted original native entry.
    payload:{entry,session,
      ...(scalar?{verifiedLargeTextRecord:{
        recordSha256:original.recordSha256,
        totalTextFragments:original.totalTextFragments,
      }}:{verifiedLargeImageRecord:true})},
  }
  return {state:'available',records:[record],
    recordCursors:[{offset:start,sequence:sequence-1,
      fileIdentity:scan.span.fileIdentity,
      boundaryHash:scan.span.boundaryHash,
      recordFingerprint:original.sourceLineSha256}],
    nextCursor:{offset:scan.span.nextOffset,sequence,
      fileIdentity:scan.span.fileIdentity,boundaryHash:scan.span.endBoundaryHash},
    hasMore:after.size>scan.span.nextOffset,pendingTail:false}
}

export const piSourceDefinition: SourceDefinition = {
  manifest: piManifest,
  detect: detectPi,
  declareCapabilities: declarePiCapabilities,
  rawRecovery: jsonlRawRecovery,
  nativeSessionCoverageComplete: true,
  async *discoverNativeSessions(ctx) {
    const root = ctx.installation.dataRoot
    if (!root) return
    const paths = await listJsonlFiles(root, ctx.historyWindow)
    for (const filePath of paths) {
      ctx.abortSignal.throwIfAborted()
      try {
        const before = await stat(filePath)
        if (!before.isFile()) continue
        const session = await readPiSessionMetadata(filePath)
        const after = await stat(filePath)
        if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue
        const tail = await readPiSessionTailMetadata(filePath)
        yield {
          sourceId: PI_SOURCE_ID,
          installationId: ctx.installation.id,
          nativeSessionId: session.nativeSessionId,
          locationKind: 'native' as const,
          filePath,
          fileIdentity: `${after.dev}:${after.ino}`,
          fileSize: after.size,
          fileMtimeMs: after.mtimeMs,
          lastActivityAt: tail.lastActivityAt ?? new Date(after.mtimeMs).toISOString(),
          ...(tail.title ? { title: tail.title } : {}),
          updatedAt: new Date().toISOString(),
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
    }
  },
  async readNativeSessionPage(query, ctx) {
    const page = await readNativeSessionWindow({
      path: query.filePath,
      allowedRoots: ctx.installation.dataRoot ? [ctx.installation.dataRoot] : [],
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      signal: ctx.abortSignal,
    })
    if (page.state !== 'available') {
      if(page.state==='unsupported'&&page.reason==='native-record-too-large'
        &&query.limit===1)
        return readPiVerifiedLargeImagePage(query,ctx)
      return page
    }
    ctx.abortSignal.throwIfAborted()
    const session = await readPiSessionMetadata(query.filePath)
    if (session.nativeSessionId !== query.nativeSessionId) {
      return { state: 'drifted', reason: 'native-session-identity-changed' }
    }
    // Session metadata is read through a second open. A replace/rename race
    // must not splice metadata from a different inode onto verified page bytes.
    let current: Awaited<ReturnType<typeof stat>>
    try { current = await stat(query.filePath) }
    catch (error) {
      if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return { state: 'drifted', reason: 'native-file-disappeared-after-page-read' }
      }
      throw error
    }
    if (!current.isFile() || `${current.dev}:${current.ino}` !== page.nextCursor.fileIdentity) {
      return { state: 'drifted', reason: 'native-file-identity-changed' }
    }
    const records = page.lines.map(line => {
      const entry = line.entry
      const nativeId = typeof entry.id === 'string' && entry.id ? entry.id : undefined
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp
        : typeof (entry.message as { timestamp?: unknown } | undefined)?.timestamp === 'number'
          ? new Date((entry.message as { timestamp: number }).timestamp).toISOString()
          : undefined
      const recordHash = createHash('sha256')
        .update(`${query.filePath}|${line.offset}|${line.textFingerprint}`).digest('hex').slice(0, 32)
      return {
        id: `pi-record-${recordHash}`,
        sourceId: PI_SOURCE_ID,
        installationId: ctx.installation.id,
        sourceSessionNativeId: session.nativeSessionId,
        nativeType: `history/${typeof entry.type === 'string' ? entry.type : 'unknown'}`,
        ...(nativeId ? { nativeId } : {}),
        sourceSequence: line.sequence * 1000,
        ...(timestamp ? { occurredAt: timestamp } : {}),
        capturedAt: new Date().toISOString(),
        locator: { kind: 'file' as const, path: query.filePath, offset: line.offset },
        fingerprint: line.textFingerprint,
        payload: { entry, session },
        parserVersion: PI_PARSER_VERSION,
      }
    })
    return {
      state: 'available',
      records,
      recordCursors: page.lines.map(line => ({
        offset: line.offset, sequence: line.sequence - 1,
        fileIdentity: page.nextCursor.fileIdentity,
        boundaryHash: line.boundaryHash,
        recordFingerprint: line.textFingerprint,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      pendingTail: page.pendingTail,
    }
  },
  async locateOversizedRecord(query,ctx) {
    const limit=query.limit??8
    if(!Number.isSafeInteger(limit)||limit<1||limit>8)
      return {state:'unsupported' as const,reason:'invalid-oversized-search-limit'}
    ctx.abortSignal.throwIfAborted()
    const roots=ctx.installation.dataRoot?[ctx.installation.dataRoot]:[]
    const auth=await authorizeNativeSessionPath(query.filePath,roots)
    if(auth.state!=='authorized')return auth
    const header=await readPiSessionMetadata(auth.sourcePath)
    if(header.nativeSessionId!==query.nativeSessionId)
      return {state:'drifted' as const,reason:'native-session-identity-changed'}
    const original=await stat(auth.sourcePath)
    if(!original.isFile())return {state:'unsupported' as const,reason:'native-source-is-not-a-file'}
    let cursor=query.cursor
    let inspectedBytes=0
    for(let n=0;n<limit;n++){
      ctx.abortSignal.throwIfAborted()
      if(cursor && cursor.offset>=original.size)
        return {state:'end' as const}
      const inspected=await inspectNativeSessionRecordSpan({
        path:query.filePath,allowedRoots:roots,
        ...(cursor?{cursor}:{}),signal:ctx.abortSignal,
      })
      if(inspected.state!=='available')return inspected
      const {span}=inspected
      const startCursor={
        offset:span.offset,sequence:cursor?.sequence??0,
        fileIdentity:span.fileIdentity,boundaryHash:span.boundaryHash,
      }
      if(span.oversized){
        // Do not offer a cursor for malformed JSON or a rewritten source.
        // This read yields no raw text outside the Source adapter.
        const checked=await readNativeJsonlTextFragments({
          path:query.filePath,allowedRoots:roots,cursor:startCursor,
          expectedSha256:span.sha256,limit:1,signal:ctx.abortSignal,
        })
        if(checked.state!=='available')return checked
        const last=await stat(query.filePath)
        if(!last.isFile()||last.size!==original.size
          ||last.mtimeMs!==original.mtimeMs
          ||last.dev!==original.dev||last.ino!==original.ino)
          return {state:'drifted' as const,reason:'native-file-changed-after-scan'}
        return {state:'found' as const,
          cursor:{...startCursor,recordFingerprint:checked.record.sourceLineSha256},
          recordSha256:checked.record.recordSha256,
          hasText:checked.record.totalTextFragments>0,
          hasMedia:checked.record.images.length>0,
          ...(checked.record.nativeEventId?{nativeEventId:checked.record.nativeEventId}:{}),
          ...(span.nextOffset<original.size?{nextCursor:{
            offset:span.nextOffset,sequence:startCursor.sequence+1,
            fileIdentity:span.fileIdentity,boundaryHash:span.endBoundaryHash,
          }}:{})
        }
      }
      inspectedBytes+=span.nextOffset-span.offset
      cursor={offset:span.nextOffset,sequence:startCursor.sequence+1,
        fileIdentity:span.fileIdentity,boundaryHash:span.endBoundaryHash}
      if(inspectedBytes>=8*1024*1024)
        return {state:'more' as const,nextCursor:cursor}
    }
    return cursor&&cursor.offset>=original.size
      ?{state:'end' as const}
      :{state:'more' as const,nextCursor:cursor!}
  },
  async findNativeToolResult(query,ctx) {
    const limit=query.limit??4
    const leafAnchor=query.fragmentOrdinal!==undefined
    const blockAnchor=query.contentIndex!==undefined
    if(!Number.isSafeInteger(limit)||limit<1||limit>4
      ||leafAnchor===blockAnchor
      ||(leafAnchor&&(!Number.isSafeInteger(query.fragmentOrdinal)
        ||query.fragmentOrdinal! < 0||query.fragmentOrdinal! > 10_000_000))
      ||(blockAnchor&&(!Number.isSafeInteger(query.contentIndex)
        ||query.contentIndex! < 0||query.contentIndex! > 10_000_000))
      ||!/^[0-9a-f]{64}$/.test(query.expectedSha256)
      ||!/^[0-9a-f]{64}$/.test(query.callKey))
      return {state:'unsupported' as const,reason:'invalid-native-tool-link-query'}
    ctx.abortSignal.throwIfAborted()
    const roots=ctx.installation.dataRoot?[ctx.installation.dataRoot]:[]
    const auth=await authorizeNativeSessionPath(query.filePath,roots)
    if(auth.state!=='authorized')return auth
    const header=await readPiSessionMetadata(auth.sourcePath)
    if(header.nativeSessionId!==query.nativeSessionId)
      return {state:'drifted' as const,reason:'native-session-identity-changed'}
    const original=await stat(auth.sourcePath)
    if(!original.isFile())
      return {state:'unsupported' as const,reason:'native-source-is-not-a-file'}
    // Every resumed scan reattests its original native call anchor. A text
    // leaf and a content[] object are distinct forms of exact Source proof;
    // neither the caller's hash nor tool name alone authorizes the lookup.
    const anchor=await readNativeJsonlTextFragments({
      path:query.filePath,allowedRoots:roots,cursor:query.cursor,
      expectedSha256:query.expectedSha256,
      fragmentOffset:query.fragmentOrdinal??0,
      limit:1,signal:ctx.abortSignal,
    })
    if(anchor.state!=='available')return anchor
    const leaf=anchor.record.fragments[0]
    const block=anchor.record.contentBlocks.find(item=>
      item.contentIndex===query.contentIndex)
    const anchored=leafAnchor
      ?Boolean(leaf&&leaf.ordinal===query.fragmentOrdinal
        &&leaf.kind==='tool-call'&&leaf.callKey===query.callKey)
      :Boolean(block&&block.kind==='tool-call'&&block.callKey===query.callKey)
    // One native call ID must not silently identify multiple tools inside
    // the original oversized record. A truncated block outline cannot prove
    // uniqueness; fall back to unpaired Source evidence rather than guessing.
    const matchingBlocks=anchor.record.contentBlocks.filter(item=>
      item.kind==='tool-call'&&item.callKey===query.callKey)
    if(anchor.record.contentBlocksTruncated||matchingBlocks.length>1)
      return {state:'unsupported' as const,reason:'ambiguous-native-tool-call-evidence'}
    if(anchor.record.recordSha256!==query.expectedSha256
      ||(query.cursor.recordFingerprint
        &&anchor.record.sourceLineSha256!==query.cursor.recordFingerprint)
      ||!anchored)
      return {state:'unsupported' as const,reason:'native-tool-call-evidence-mismatch'}
    const start=await inspectNativeSessionRecordSpan({
      path:query.filePath,allowedRoots:roots,cursor:query.cursor,
      signal:ctx.abortSignal,
    })
    if(start.state!=='available')return start
    const firstNext=start.span.nextOffset
    let cursor=query.scanCursor??{
      offset:firstNext,sequence:query.cursor.sequence+1,
      fileIdentity:start.span.fileIdentity,boundaryHash:start.span.endBoundaryHash,
    }
    if(cursor.offset<firstNext
      ||cursor.fileIdentity!==start.span.fileIdentity)
      return {state:'unsupported' as const,reason:'native-tool-link-cursor-invalid'}
    let scannedRecords=0
    let match:undefined|{cursor:typeof cursor;recordSha256:string}
    const checkUnchanged=async()=>{
      const now=await stat(auth.sourcePath)
      return now.isFile()&&now.size===original.size&&now.mtimeMs===original.mtimeMs
        &&now.dev===original.dev&&now.ino===original.ino
    }
    for(;scannedRecords<limit&&cursor.offset<original.size;scannedRecords++){
      ctx.abortSignal.throwIfAborted()
      const inspected=await inspectNativeSessionRecordSpan({
        path:query.filePath,allowedRoots:roots,cursor,signal:ctx.abortSignal,
      })
      if(inspected.state!=='available')return inspected
      const record=await readNativeJsonlTextFragments({
        path:query.filePath,allowedRoots:roots,cursor,
        expectedSha256:inspected.span.sha256,fragmentOffset:0,limit:1,
        signal:ctx.abortSignal,
      })
      if(record.state!=='available')return record
      if(record.record.recordSha256!==inspected.span.sha256
        ||(cursor.recordFingerprint
          &&record.record.sourceLineSha256!==cursor.recordFingerprint))
        return {state:'drifted' as const,reason:'native-tool-link-record-changed'}
      if(record.record.resultCallKey===query.callKey){
        match={cursor:{...cursor,
          recordFingerprint:record.record.sourceLineSha256},
          recordSha256:record.record.recordSha256}
        scannedRecords++
        break
      }
      if(inspected.span.nextOffset<=cursor.offset)
        return {state:'unsupported' as const,reason:'native-tool-link-stalled'}
      cursor={offset:inspected.span.nextOffset,sequence:cursor.sequence+1,
        fileIdentity:inspected.span.fileIdentity,
        boundaryHash:inspected.span.endBoundaryHash}
    }
    if(!await checkUnchanged())
      return {state:'drifted' as const,reason:'native-file-changed-after-scan'}
    return {state:'available' as const,scannedRecords,
      ...(match?{match}:{...(cursor.offset<original.size?{nextCursor:cursor}:{})}),
    }
  },
  async readNativeTextFragments(query,ctx) {
    const result=await readNativeJsonlTextFragments({
      path:query.filePath,
      allowedRoots:ctx.installation.dataRoot?[ctx.installation.dataRoot]:[],
      cursor:query.cursor,
      ...(query.expectedSha256?{expectedSha256:query.expectedSha256}:{}),
      ...(query.fragmentOffset===undefined?{}:{fragmentOffset:query.fragmentOffset}),
      ...(query.limit===undefined?{}:{limit:query.limit}),
      ...(query.media?{media:query.media}:{}),
      signal:ctx.abortSignal,
    })
    if(result.state!=='available')return result
    // Review index cursor must still point to this exact physical Source
    // record, even after an in-place rewrite with restored stat metadata.
    if(query.cursor.recordFingerprint
      &&result.record.sourceLineSha256!==query.cursor.recordFingerprint)
      return {state:'drifted',reason:'native-record-fingerprint-changed'}
    ctx.abortSignal.throwIfAborted()
    const session=await readPiSessionMetadata(query.filePath)
    if(session.nativeSessionId!==query.nativeSessionId)
      return {state:'drifted',reason:'native-session-identity-changed'}
    const current=await stat(query.filePath)
    if(!current.isFile()||`${current.dev}:${current.ino}`!==result.record.fileIdentity)
      return {state:'drifted',reason:'native-file-identity-changed'}
    return result
  },
  discoverAssets: discoverPiAssets,
  ingestHistory: ingestPiHistory,
  startCapture: startPiRuntimeCapture,
  normalize: normalizePiRecord,
}

const applyPiSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(piSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const piSourcePlugin = defineAgentLensPlugin(piManifest, applyPiSource)

export {
  detectPi,
  discoverPiAssets,
  ingestPiHistory,
  normalizePiRecord,
  startPiRuntimeCapture,
}

export const piInternals = {
  ...piSessionInternals,
  ...piAssetInternals,
}
