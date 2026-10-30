import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { AgentLensApi, type QueryFilters } from '../client/api'
import { copyText } from '../client/clipboard'
import { agentLabel } from '../components/AgentScope'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { EmptyStatePanel, ErrorStateBanner } from '../components/StateViews'
import { Button, Disclosure, Toolbar, ToolbarGroup, UiIcon } from '../components/ui'
import { NativeFailureScanner } from './native-failure-examples'
import './native-failure-examples.css'

const api = new AgentLensApi()

/** 洞察与工具详情复用同一失败样本读取与展示，不创建第二套会话正文。 */
export function NativeFailureExamples({filters,toolName}: {filters:QueryFilters;toolName?:string}) {
  const {t,i18n} = useTranslation('tools')
  const navigate = useNavigate()
  const sourceIdsKey = JSON.stringify(filters.sourceIds)
  const scanner = useMemo(()=>new NativeFailureScanner(api,{
    sourceIds:JSON.parse(sourceIdsKey) as string[] | null,
    projectId:filters.projectId,range:filters.range,
  },toolName),[sourceIdsKey,filters.projectId,filters.range,toolName])
  const controller = useRef<AbortController | null>(null)
  const [,setRevision] = useState(0)
  const [loading,setLoading] = useState(false)
  const [error,setError] = useState('')
  const [copyState,setCopyState] = useState<'idle'|'copied'|'error'>('idle')
  useEffect(()=>{
    controller.current?.abort()
    controller.current=null
    setLoading(false)
    setError('')
    setCopyState('idle')
    return ()=>controller.current?.abort()
  },[scanner])
  const scan = async()=>{
    if(controller.current)return
    const current = new AbortController()
    controller.current=current
    setLoading(true)
    setError('')
    setCopyState('idle')
    try {
      // 用户每次触发最多四次已有有界请求；没有命中也不自动扫完整个磁盘。
      for(let step=0;step<4&&!current.signal.aborted&&!scanner.finished&&!scanner.capped;step++) {
        await scanner.next(current.signal)
        if(!current.signal.aborted)setRevision(value=>value+1)
      }
    } catch(reason) {
      if(!current.signal.aborted)setError(reason instanceof Error
        ?reason.message==='native-failure-cursor-stalled'?t('failures.cursorStalled'):reason.message
        :String(reason))
    } finally {
      if(controller.current===current){controller.current=null;setLoading(false)}
    }
  }
  const stop = ()=>{
    controller.current?.abort()
    controller.current=null
    setLoading(false)
  }
  const copy = async()=>{
    try {
      await copyText(JSON.stringify({schemaVersion:1,coverage:'bounded',
        filters,toolName:toolName??null,scannedPages:scanner.pages,
        skippedSessions:scanner.skippedSessions,scanFinished:scanner.finished,
        sampleLimitReached:scanner.capped,examples:scanner.examples},null,2))
      setCopyState('copied')
    } catch {setCopyState('error')}
  }
  return <section className="native-failure-examples" aria-label={t('failures.title')}>
    <p className="native-failure-note">{t('failures.description')}</p>
    <Toolbar aria-label={t('failures.title')}>
      <ToolbarGroup>
        {loading ? <Button onClick={stop}>{t('failures.stop')}</Button>
          : <Button onClick={()=>void scan()} disabled={scanner.finished||scanner.capped}>
            {scanner.pages ? t('failures.continue') : t('failures.scan')}</Button>}
        <Button disabled={!scanner.examples.length} onClick={()=>void copy()}>
          {t(copyState==='copied'?'failures.copied':copyState==='error'?'failures.copyFailed':'failures.copy')}</Button>
      </ToolbarGroup>
    </Toolbar>
    <p className="native-failure-note" role="status" aria-live="polite">
      {t('failures.progress',{sessions:scanner.checkedSessions,pages:scanner.pages,count:scanner.examples.length})}
      {' '}{t(loading?'failures.loading':scanner.capped?'failures.capped':scanner.finished?'failures.finished':'failures.incomplete')}
    </p>
    {error&&<ErrorStateBanner message={error} onRetry={()=>void scan()}/>}
    {scanner.skippedSessions>0&&<p className="native-failure-note">{t('failures.skipped',{count:scanner.skippedSessions})} {scanner.lastIssue}</p>}
    {!scanner.examples.length&&!loading&&<EmptyStatePanel compact icon={<UiIcon name="search" size={20}/>} title={t('failures.empty')}
      description={t('failures.emptyDescription')}/>}
    {scanner.examples.map(example=><Disclosure key={`${example.sessionId}:${example.id}`}
      summary={`${example.toolName??t(example.kind==='tool'?'failures.unknownTool':'failures.runtime')} · ${agentLabel(example.sourceId)} · ${new Date(example.at).toLocaleString(i18n.resolvedLanguage)}`}
      summaryMeta={t('failures.round',{ordinal:example.ordinal})}>
      <div className="native-failure-detail">
        <p className="native-failure-context" title={example.title??example.sessionId}>{example.projectName??example.title??example.sessionId}</p>
        <div><strong>{t('failures.prompt')}</strong><CopyableCodeBlock>{example.prompt??t('failures.unknownPrompt')}</CopyableCodeBlock></div>
        {example.kind==='tool'&&<div><strong>{t('failures.input')}</strong><CopyableCodeBlock>{example.input??t('failures.unknownInput')}</CopyableCodeBlock></div>}
        <div><strong>{t('failures.error')}</strong><CopyableCodeBlock>{example.error}</CopyableCodeBlock></div>
        {(example.truncated||example.contextPartial)&&<p className="native-failure-note">{t('failures.partial')}</p>}
        <p className="native-failure-note">{t('failures.evidence',{observations:example.observationIds.length,evidence:example.evidenceIds.length})}</p>
        <Button onClick={()=>navigate(`/review/${encodeURIComponent(example.sessionId)}?range=all&status=all`)}>{t('failures.openSession')}</Button>
      </div>
    </Disclosure>)}
  </section>
}
