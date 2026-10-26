import { createHash } from 'node:crypto'
import type {
  AssetBinding, AssetBindingHint, AssetDefinition, AssetDefinitionHint,
  AssetService, AssetStateInput, AssetStateObservation,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { isSlimDatabase } from './slim-schema'
import { upsertAssetCurrentState } from './asset-current-state'

function stableId(prefix:string,parts:unknown[]):string{
  return prefix+'-'+createHash('sha256')
    .update(JSON.stringify(parts)).digest('hex').slice(0,32)
}

/** Source-discovered assets: only the current state, without a parallel
 * Evidence/Observation history, and with the SAME stable IDs as the old
 * DefaultAssetService to keep existing user bindings during one-time upgrade.
 */
export class SqliteSlimAssetService implements AssetService {
  constructor(private readonly executor:SqliteExecutor){
    if(!isSlimDatabase(executor.db))throw new Error('Slim asset service requires slim SQLite')
  }

  async resolveDefinition(input:AssetDefinitionHint):Promise<AssetDefinition>{
    if(!input.canonicalName?.trim())throw new TypeError('Asset canonical name is required')
    const definition:AssetDefinition={
      id:stableId('asset',[input.type,input.upstreamIdentity??input.canonicalName]),
      type:input.type,canonicalName:input.canonicalName,
      ...(input.displayName?{displayName:input.displayName}:{}),
      ...(input.upstreamIdentity?{upstreamIdentity:input.upstreamIdentity}:{}),
    }
    await this.executor.run(()=>{
      this.executor.db.prepare(`
        INSERT INTO asset_definitions(id,type,canonical_name,display_name,upstream_identity)
        VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          type=excluded.type,canonical_name=excluded.canonical_name,
          display_name=COALESCE(excluded.display_name,asset_definitions.display_name),
          upstream_identity=COALESCE(excluded.upstream_identity,asset_definitions.upstream_identity)
      `).run(definition.id,definition.type,definition.canonicalName,
        definition.displayName??null,definition.upstreamIdentity??null)
    })
    return definition
  }

  async resolveBinding(input:AssetBindingHint):Promise<AssetBinding>{
    if(!input.assetId || !input.installationId){
      throw new TypeError('Asset binding requires asset and installation')
    }
    const binding:AssetBinding={
      id:stableId('asset-binding',[input.assetId,input.installationId,
        input.path??'',input.source??'']),
      assetId:input.assetId,installationId:input.installationId,
      ...(input.runtimeProfileId?{runtimeProfileId:input.runtimeProfileId}:{}),
      ...(input.scope?{scope:input.scope}:{}),
      ...(input.scopeRoot?{scopeRoot:input.scopeRoot}:{}),
      ...(input.path?{path:input.path}:{}),
      ...(input.source?{source:input.source}:{}),
      ...(input.version?{version:input.version}:{}),
    }
    await this.executor.run(()=>{
      const db=this.executor.db
      const previous=db.prepare('SELECT runtime_profile_id FROM asset_bindings WHERE id=?')
        .get(binding.id) as {runtime_profile_id:string|null}|undefined
      if(previous?.runtime_profile_id && binding.runtimeProfileId
        && previous.runtime_profile_id!==binding.runtimeProfileId) {
        throw new Error('Asset binding identity collision across runtime profiles')
      }
      db.prepare(`
        INSERT INTO asset_bindings(
          id,asset_id,installation_id,runtime_profile_id,
          path,source,version,scope,scope_root
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          runtime_profile_id=COALESCE(excluded.runtime_profile_id,asset_bindings.runtime_profile_id),
          version=COALESCE(excluded.version,asset_bindings.version),
          scope=COALESCE(excluded.scope,asset_bindings.scope),
          scope_root=COALESCE(excluded.scope_root,asset_bindings.scope_root)
      `).run(
        binding.id,binding.assetId,binding.installationId,binding.runtimeProfileId??null,
        binding.path??null,binding.source??null,binding.version??null,
        binding.scope??null,binding.scopeRoot??null)
    })
    return binding
  }

  async recordState(input:AssetStateInput):Promise<AssetStateObservation>{
    if(!Number.isFinite(Date.parse(input.observedAt))){
      throw new TypeError('Asset current state observedAt is invalid')
    }
    const state:AssetStateObservation={
      id:stableId('asset-state',[input.assetBindingId,input.state,input.observedAt]),
      assetBindingId:input.assetBindingId,state:input.state,
      value:input.value,observedAt:input.observedAt,
      // Evidence is rehydrated from Source on demand, never mirrored into
      // the slim current-state table. This is a durable metadata projection.
      evidenceRefs:[],
    }
    await this.executor.run(()=>{
      upsertAssetCurrentState(this.executor.db,state)
    })
    return state
  }
}
