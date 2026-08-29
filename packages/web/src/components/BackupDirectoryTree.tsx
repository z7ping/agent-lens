import type { BackupDataRootSummaryDto, BackupDirectoryNodeDto } from '@agent-lens/protocol'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function DirectoryNode({ node }: { node: BackupDirectoryNodeDto }) {
  const children = node.children ?? []
  const expandable = children.length > 0 || Boolean(node.omittedChildren)
  const meta = `${node.fileCount.toLocaleString()} 文件${node.totalBytes === undefined ? '' : ` · ${formatBytes(node.totalBytes)}`}`

  if (!expandable) return <div className="backup-tree-leaf">
    <span className="backup-tree-name" title={node.relativePath}>{node.name}</span>
    <small>{meta}</small>
  </div>

  return <details className="backup-tree-node">
    <summary>
      <span className="backup-tree-name" title={node.relativePath}>{node.name}</span>
      <small>{meta}</small>
    </summary>
    <div className="backup-tree-children">
      {children.map(child => <DirectoryNode key={child.relativePath} node={child}/>)}
      {Boolean(node.omittedChildren) && <div className="backup-tree-omitted">另有 {node.omittedChildren} 个同级目录未展开显示</div>}
    </div>
  </details>
}

export function BackupDataRootTree({ root, onCopy }: { root: BackupDataRootSummaryDto; onCopy(path: string): void }) {
  const tree = root.tree ?? []
  return <section className="backup-root-tree">
    <header className="backup-root-tree-head">
      <span className="badge">{root.scope === 'config' ? '配置目录' : '数据目录'}</span>
      <code title={root.path}>{root.path}</code>
      <button className="link-btn" onClick={() => onCopy(root.path)}>复制路径</button>
    </header>
    <div className="backup-root-tree-meta">
      <span>{root.fileCount === undefined ? '文件数待扫描' : `${root.fileCount.toLocaleString()} 文件`}</span>
      {root.totalBytes !== undefined && <span>{formatBytes(root.totalBytes)}</span>}
      <span>默认仅展开第 1 层</span>
    </div>
    {tree.length ? <div className="backup-tree">{tree.map(node => <DirectoryNode key={node.relativePath} node={node}/>)}</div>
      : <div className="backup-tree-empty">根目录下没有可展示的子目录；文件可能直接位于该目录。</div>}
  </section>
}
