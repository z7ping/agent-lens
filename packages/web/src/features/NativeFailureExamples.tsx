import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { AgentLensApi, type QueryFilters } from '../client/api'
import { copyText } from '../client/clipboard'
import { agentLabel } from '../components/AgentScope'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { EmptyStatePanel, ErrorStateBanner } from '../components/StateViews'
import { Button, StatusBadge, Toolbar, ToolbarGroup, UiIcon } from '../components/ui'
import { NativeFailureScanner } from './native-failure-examples'
import './native-failure-examples.css'

const api = new AgentLensApi()
// A page/step remains bounded at the source; the view yields every four steps and
// pauses after a fixed budget instead of performing an uncontrolled disk sweep.
const AUTO_SCAN_BUDGET = 80
const SCAN_BATCH_SIZE = 4

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
  const [revision,setRevision] = useState(0)
  const [loading,setLoading] = useState(false)
  const [paused,setPaused] = useState(false)
  const [budgetReached,setBudgetReached] = useState(false)
  const [error,setError] = useState('')
  const [selectedId,setSelectedId] = useState<string | null>(null)
  const [copyState,setCopyState] = useState<'idle'|'copied'|'error'>('idle')

  const scan = useCallback(async()=>{
    if(controller.current||scanner.finished||scanner.capped)return
    const current = new AbortController()
    controller.current=current
    setPaused(false)
    setBudgetReached(false)
    setLoading(true)
    setError('')
    setCopyState('idle')
    let steps=0
    try {
      while(steps<AUTO_SCAN_BUDGET&&!current.signal.aborted&&!scanner.finished&&!scanner.capped){
        await scanner.next(current.signal)
        steps++
        if(current.signal.aborted)break
        // Publish partial results and return control to the browser at a bounded cadence.
        if(steps%SCAN_BATCH_SIZE===0){
          setRevision(value=>value+1)
          await new Promise<void>(resolve=>setTimeout(resolve,0))
        }
      }
      if(!current.signal.aborted){
        setRevision(value=>value+1)
        setBudgetReached(!scanner.finished&&!scanner.capped)
      }
    }catch(reason){
      if(!current.signal.aborted)setError(reason instanceof Error
        ?reason.message==='native-failure-cursor-stalled'?t('failures.cursorStalled'):reason.message
        :String(reason))
    }finally{
      if(controller.current===current){
        controller.current=null
        setLoading(false)
      }
    }
  },[scanner,t])

  useEffect(()=>{
    // StrictMode, filter changes and navigation must not leak a stale scan.
    controller.current?.abort()
    controller.current=null
    setRevision(0)
    setPaused(false)
    setBudgetReached(false)
    setError('')
    setSelectedId(null)
    setCopyState('idle')
    void scan()
    return ()=>{
      controller.current?.abort()
      controller.current=null
    }
  },[scan])

  const stop = ()=>{
    controller.current?.abort()
    controller.current=null
    setLoading(false)
    setPaused(true)
    setRevision(value=>value+1)
  }
  const copy = async()=>{
    try{
      await copyText(JSON.stringify({schemaVersion:1,coverage:'bounded',
        filters,toolName:toolName??null,scannedPages:scanner.pages,
        skippedSessions:scanner.skippedSessions,scanFinished:scanner.finished,
        sampleLimitReached:scanner.capped,scanBudgetReached:budgetReached,examples:scanner.examples},null,2))
      setCopyState('copied')
    }catch{setCopyState('error')}
  }
  const examples=scanner.examples
  const active=examples.find(example=>`${example.sessionId}::${example.id}`===selectedId)??examples[0]
  // Only identical, untruncated errors found within this bounded sample count as repeats.
  const repeatCounts=useMemo(()=>{
    const counts=new Map<string,number>()
    for(const example of examples){
      if(example.kind!=='tool'||!example.toolName||example.truncated)continue
      const key=JSON.stringify([example.toolName,example.error])
      counts.set(key,(counts.get(key)??0)+1)
    }
    return counts
  },[scanner,revision])
  const progress=t('failures.progress',{sessions:scanner.checkedSessions,pages:scanner.pages,count:examples.length})
  const status=loading?'failures.loading'
    :scanner.capped?'failures.capped'
    :scanner.finished?'failures.finished'
    :budgetReached?'failures.budgetReached'
    :paused?'failures.paused':'failures.incomplete'
  return <section className="native-failure-examples" aria-label={t('failures.title')}>
    <div className="native-failure-scan-bar">
      <span className="native-failure-scan-status" role="status" aria-live="polite">
        <StatusBadge tone={error||scanner.skippedSessions?'warning':scanner.finished?'success':'neutral'}
          dot>{t(status)}</StatusBadge>
        <span>{progress}</span>
        {scanner.skippedSessions>0&&<span title={scanner.lastIssue}>
          {t('failures.skippedCount',{count:scanner.skippedSessions})}</span>}
      </span>
      <Toolbar aria-label={t('failures.title')}>
        <ToolbarGroup>
          {loading?<Button size="small" onClick={stop}>{t('failures.pause')}</Button>
            :!scanner.finished&&!scanner.capped&&<Button size="small" onClick={()=>void scan()}>
              {t('failures.continue')}</Button>}
          <Button size="small" disabled={!examples.length} onClick={()=>void copy()}>
            {t(copyState==='copied'?'failures.copied':copyState==='error'?'failures.copyFailed':'failures.copy')}</Button>
        </ToolbarGroup>
      </Toolbar>
    </div>
    {error&&<ErrorStateBanner message={error} onRetry={()=>void scan()}/>}
    <div className="native-failure-split">
      <section className="native-failure-list-pane" aria-label={t('failures.title')}>
        <div className="native-failure-pane-heading">{t('failures.samples',{count:examples.length})}</div>
        {!examples.length&&!loading&&(scanner.finished||budgetReached||paused)&&
          <EmptyStatePanel compact icon={<UiIcon name="search" size={20}/>}
            title={t('failures.empty')} description={t('failures.emptyDescription')}/>}
        <ul className="native-failure-list">
          {examples.map(example=>{
            const key=`${example.sessionId}::${example.id}`
            const repeats=!example.truncated&&example.kind==='tool'&&example.toolName
              ?repeatCounts.get(JSON.stringify([example.toolName,example.error]))??1:1
            return <li key={key}>
              <button type="button"
                className={`native-failure-item${active===example?' is-selected':''}${repeats>=3?' is-repeated':''}`}
                aria-pressed={active===example} onClick={()=>setSelectedId(key)}>
                <span className="native-failure-item-main">
                  <UiIcon name="exclamation" size={14}/>
                  <b>{example.toolName??t(example.kind==='tool'?'failures.unknownTool':'failures.runtime')}</b>
                  {repeats>1&&<span className="native-failure-repeat-count" title={t('failures.repeatedSampleNote')}>×{repeats}</span>}
                </span>
                <span className="native-failure-item-meta">
                  {agentLabel(example.sourceId)} · {t('failures.round',{ordinal:example.ordinal})}
                </span>
                <span className="native-failure-item-meta">
                  {new Date(example.at).toLocaleString(i18n.resolvedLanguage)}
                </span>
              </button>
            </li>
          })}
        </ul>
      </section>
      <section className="native-failure-detail-pane" aria-label={t('failures.details')}>
        {active?<div className="native-failure-detail">
          <div className="native-failure-detail-heading">
            <span><StatusBadge tone="danger" dot>{t('failures.error')}</StatusBadge>
              <strong>{active.toolName??t(active.kind==='tool'?'failures.unknownTool':'failures.runtime')}</strong></span>
            <Button size="small" onClick={()=>navigate(`/review/${encodeURIComponent(active.sessionId)}?range=all&status=all&focusTurn=${encodeURIComponent(String(active.ordinal))}`)}>
              <UiIcon name="link" size={14}/>{t('failures.openSession')}</Button>
          </div>
          <p className="native-failure-context" title={active.title??active.sessionId}>
            {active.projectName??active.title??active.sessionId} · {t('failures.round',{ordinal:active.ordinal})}
          </p>
          <div className="native-failure-error-block"><strong>{t('failures.error')}</strong>
            <CopyableCodeBlock>{active.error}</CopyableCodeBlock></div>
          <div><strong>{t('failures.prompt')}</strong>
            <CopyableCodeBlock>{active.prompt??t('failures.unknownPrompt')}</CopyableCodeBlock></div>
          {active.kind==='tool'&&<div><strong>{t('failures.input')}</strong>
            <CopyableCodeBlock>{active.input??t('failures.unknownInput')}</CopyableCodeBlock></div>}
          <div className="native-failure-detail-footer">
            <span title={t('failures.evidence',{observations:active.observationIds.length,evidence:active.evidenceIds.length})}>
              {t('failures.evidence',{observations:active.observationIds.length,evidence:active.evidenceIds.length})}</span>
            {(active.truncated||active.contextPartial)&&<StatusBadge tone="warning" title={t('failures.partial')}>{t('failures.partialShort')}</StatusBadge>}
          </div>
        </div>:<div className="native-failure-placeholder">{loading?t('failures.loading'):t('failures.selectExample')}</div>}
      </section>
    </div>
  </section>
}
