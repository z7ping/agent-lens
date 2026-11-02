import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { NativeErrorIndexItemDto, NativeErrorIndexResponseDto } from '@agent-lens/protocol'
import { AgentLensApi, rangeStart, type QueryFilters } from '../client/api'
import { copyText } from '../client/clipboard'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { EmptyStatePanel, ErrorStateBanner } from '../components/StateViews'
import { Button, Input, StatusBadge, Toolbar, ToolbarGroup, UiIcon } from '../components/ui'
import './native-failure-examples.css'

const api=new AgentLensApi()
const PAGE_SIZE=50

/** Complete, indexed error facts. Review remains the only authority for full input/output. */
export function NativeFailureExamples({filters,toolName}: {filters:QueryFilters;toolName?:string}) {
  const {t,i18n}=useTranslation('tools')
  const navigate=useNavigate()
  const sourceId=filters.sourceIds?.length===1?filters.sourceIds[0]??'':''
  const from=rangeStart(filters.range)
  const [query,setQuery]=useState('')
  const [search,setSearch]=useState('')
  const [offset,setOffset]=useState(0)
  const [data,setData]=useState<NativeErrorIndexResponseDto|null>(null)
  const [selectedKey,setSelectedKey]=useState<string|null>(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [copyState,setCopyState]=useState<'idle'|'copied'|'error'>('idle')
  const [retry,setRetry]=useState(0)

  useEffect(()=>{
    setOffset(0)
    setSelectedKey(null)
  },[sourceId,filters.projectId,filters.range,toolName,search])

  useEffect(()=>{
    const controller=new AbortController()
    if(!sourceId){setData(null);return ()=>controller.abort()}
    let timer:ReturnType<typeof setTimeout>|undefined
    let busy=false
    let first=true
    const load=async()=>{
      if(busy||controller.signal.aborted)return
      busy=true
      if(first){setLoading(true);first=false}
      try{
        const result=await api.nativeErrors({
          sourceId,projectId:filters.projectId||undefined,toolName,
          search:search||undefined,from,limit:PAGE_SIZE,offset,
          signal:controller.signal,
        })
        if(controller.signal.aborted)return
        setData(result)
        setError('')
        // The existing lazy metric refresh runs server-side. Poll only while
        // unindexed sessions remain, without inserting a second Source scanner.
        if(result.indexedSessions<result.eligibleSessions){
          timer=setTimeout(()=>{void load()},4000)
        }
      }catch(reason){
        if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:String(reason))
      }finally{
        busy=false
        if(!controller.signal.aborted)setLoading(false)
      }
    }
    setData(null)
    void load()
    return ()=>{controller.abort();if(timer)clearTimeout(timer)}
  },[sourceId,filters.projectId,from,toolName,search,offset,retry])

  const entries=data?.items??[]
  const active=entries.find(item=>item.eventKey===selectedKey)??entries[0]
  const openReview=(item:NativeErrorIndexItemDto)=>{
    if(!item.sessionId)return
    const params=new URLSearchParams({range:'all',status:'all'})
    // Only a Source-verified ordinal may be used as a precise Review anchor.
    if(item.turnOrdinal!==null)params.set('focusTurn',String(item.turnOrdinal))
    navigate(`/review/${encodeURIComponent(item.sessionId)}?${params}`)
  }
  const copy=async()=>{
    try{
      await copyText(JSON.stringify({schemaVersion:1,scope:{sourceId,toolName:toolName??null,search},
        indexed:data?.readySessions,eligible:data?.eligibleSessions,
        total:data?.total,offset,items:entries},null,2))
      setCopyState('copied')
    }catch{setCopyState('error')}
  }
  return <section className="native-failure-examples" aria-label={t('failures.title')}>
    <div className="native-failure-scan-bar">
      <span className="native-failure-scan-status" role="status" aria-live="polite">
        <StatusBadge dot tone={data&&(data.indexedSessions<data.eligibleSessions||data.partialSessions>0)?'warning':'neutral'}>
          {data&&data.indexedSessions<data.eligibleSessions||data.partialSessions>0?t('failures.indexing'):t('failures.indexed')}
        </StatusBadge>
        {data&&<span>{t('failures.indexCoverage',{ready:data.indexedSessions,eligible:data.eligibleSessions})}</span>}
        {data&&<b>{t('failures.samples',{count:data.total})}</b>}
      </span>
      <Toolbar aria-label={t('failures.title')}>
        <ToolbarGroup>
          <form className="native-failure-search" onSubmit={event=>{
            event.preventDefault();setSearch(query.trim());setOffset(0)
          }}>
            <Input value={query} onChange={event=>setQuery(event.target.value)}
              maxLength={128} aria-label={t('failures.search')} placeholder={t('failures.search')}/>
            <Button size="small" type="submit"><UiIcon name="search" size={14}/></Button>
          </form>
          <Button size="small" onClick={()=>void copy()} disabled={!entries.length}>
            {t(copyState==='copied'?'failures.copied':copyState==='error'?'failures.copyFailed':'failures.copy')}
          </Button>
        </ToolbarGroup>
      </Toolbar>
    </div>
    {error&&<ErrorStateBanner message={error} onRetry={()=>setRetry(value=>value+1)}/>}
    <div className="native-failure-split">
      <section className="native-failure-list-pane" aria-label={t('failures.title')}>
        <div className="native-failure-pane-heading">
          {data?t('failures.pageRange',{from:data.total?offset+1:0,
            to:offset+entries.length,total:data.total}):t('failures.title')}
        </div>
        {!sourceId?<EmptyStatePanel compact icon={<UiIcon name="search" size={20}/>}
          title={t('failures.selectAgent')} description={t('failures.selectAgent')}/>:
          !entries.length&&!loading&&<EmptyStatePanel compact icon={<UiIcon name="search" size={20}/>}
            title={t('failures.empty')} description={t('failures.indexed')}/>}
        <ul className="native-failure-list">{entries.map(item=><li key={item.eventKey}>
          <button type="button" className={`native-failure-item${active===item?' is-selected':''}`}
            aria-pressed={active===item} onClick={()=>setSelectedKey(item.eventKey)}>
            <span className="native-failure-item-main">
              <UiIcon name="exclamation" size={14}/>
              <b>{item.toolName??t('failures.runtime')}</b>
              {item.coverage==='partial'&&<StatusBadge tone="warning">{t('page.nativePartialStatus')}</StatusBadge>}
            </span>
            <span className="native-failure-item-meta">{item.summary||item.errorCode||'—'}</span>
            <span className="native-failure-item-meta">
              {new Date(item.occurredAt).toLocaleString(i18n.resolvedLanguage)}
            </span>
          </button>
        </li>)}</ul>
        {data&&data.total>PAGE_SIZE&&<div className="native-failure-pagination">
          <Button size="small" disabled={offset===0} onClick={()=>{setOffset(Math.max(0,offset-PAGE_SIZE));setSelectedKey(null)}}>
            {t('failures.previous')}</Button>
          <Button size="small" disabled={!data.hasMore}
            onClick={()=>{setOffset(offset+PAGE_SIZE);setSelectedKey(null)}}>{t('failures.next')}</Button>
        </div>}
      </section>
      <section className="native-failure-detail-pane" aria-label={t('failures.details')}>
        {active?<div className="native-failure-detail">
          <div className="native-failure-detail-heading">
            <span><StatusBadge tone="danger" dot>{t('failures.failure')}</StatusBadge>
              <strong>{active.toolName??t('failures.runtime')}</strong></span>
            <Button size="small" disabled={!active.sessionId} onClick={()=>openReview(active)}>
              <UiIcon name="link" size={14}/>{t('failures.openSession')}</Button>
          </div>
          <p className="native-failure-context">{active.errorCode??active.kind} · {new Date(active.occurredAt).toLocaleString(i18n.resolvedLanguage)}</p>
          <div className="native-failure-error-block"><strong>{t('failures.error')}</strong>
            <CopyableCodeBlock>{active.summary||active.errorCode||'—'}</CopyableCodeBlock></div>
          <div className="native-failure-detail-footer">
            <span title={active.fingerprint}>{t('failures.sameFingerprint')}</span>
            {active.coverage==='partial'&&<StatusBadge tone="warning">{t('page.nativePartialStatus')}</StatusBadge>}
          </div>
        </div>:<div className="native-failure-placeholder">{loading?t('failures.loading'):t('failures.selectExample')}</div>}
      </section>
    </div>
  </section>
}
