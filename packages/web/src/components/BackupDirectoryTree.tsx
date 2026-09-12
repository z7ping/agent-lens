import type { BackupDataRootSummaryDto, BackupDirectoryNodeDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { UiIcon } from './UiIcon'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function DirectoryNode({ node }: { node: BackupDirectoryNodeDto }) {
  const { t, i18n } = useTranslation('backup')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const children = node.children ?? []
  const expandable = children.length > 0 || Boolean(node.omittedChildren)
  const meta = `${t('tree.files', { count: node.fileCount.toLocaleString(locale) })}${node.totalBytes === undefined ? '' : ` · ${formatBytes(node.totalBytes)}`}`

  if (!expandable) return <div className="backup-tree-leaf">
    <span className="backup-tree-leaf-mark" aria-hidden="true"/>
    <span className="backup-tree-name" title={node.relativePath}>{node.name}</span>
    <small>{meta}</small>
  </div>

  return <details className="backup-tree-node">
    <summary>
      <UiIcon className="backup-tree-chevron" name="chevron-right" size={14}/>
      <span className="backup-tree-name" title={node.relativePath}>{node.name}</span>
      <small>{meta}</small>
    </summary>
    <div className="backup-tree-children">
      {children.map(child => <DirectoryNode key={child.relativePath} node={child}/>)}
      {Boolean(node.omittedChildren) && <div className="backup-tree-omitted">{t('tree.omitted', { count: node.omittedChildren })}</div>}
    </div>
  </details>
}

export function BackupDataRootTree({ root, onCopy }: { root: BackupDataRootSummaryDto; onCopy(path: string): void }) {
  const { t, i18n } = useTranslation('backup')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const tree = root.tree ?? []
  return <section className="backup-root-tree">
    <header className="backup-root-tree-head">
      <span className="badge">{root.scope === 'config' ? t('tree.configRoot') : t('tree.dataRoot')}</span>
      <code title={root.path}>{root.path}</code>
      <button className="link-btn" onClick={() => onCopy(root.path)}>{t('tree.copyPath')}</button>
    </header>
    <div className="backup-root-tree-meta">
      <span>{root.fileCount === undefined ? t('tree.filesPending') : t('tree.files', { count: root.fileCount.toLocaleString(locale) })}</span>
      {root.totalBytes !== undefined && <span>{formatBytes(root.totalBytes)}</span>}
      <span>{t('tree.defaultDepth')}</span>
    </div>
    {tree.length ? <div className="backup-tree">{tree.map(node => <DirectoryNode key={node.relativePath} node={node}/>)}</div>
      : <div className="backup-tree-empty">{t('tree.empty')}</div>}
  </section>
}
