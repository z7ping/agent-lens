import { clientModel } from '../client/model'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalFileLink, parseLocalFileTarget } from './LocalFileLink'
import { LocalPathActions } from './LocalPathActions'

export type LocalResourceKind = 'file' | 'directory' | 'path'
export type LocalResourcePresentation = 'block' | 'inline'

export interface LocalResourceReferenceProps {
  value: string
  kind: LocalResourceKind
  presentation?: LocalResourcePresentation
  className?: string
}

export function isActionableLocalResource(value: string): boolean {
  return parseLocalFileTarget(value) !== null
}

export function LocalResourceReference({
  value,
  kind,
  presentation = 'block',
  className = '',
}: LocalResourceReferenceProps) {
  const target = parseLocalFileTarget(value)
  if (!target) {
    return presentation === 'block'
      ? <CopyableCodeBlock className={className} copyValue={value}>{value}</CopyableCodeBlock>
      : <span className={className}>{value}</span>
  }

  const classes = `local-resource-reference is-${presentation} is-${kind} ${className}`.trim()
  const content = kind === 'file'
    ? <LocalFileLink href={value} className="local-resource-link"><code title={value}>{value}</code></LocalFileLink>
    : <code title={value}>{value}</code>

  return <span className={classes} data-local-resource-kind={kind}>
    <span className="local-resource-value">{content}</span>
    <LocalPathActions path={target.path} onOpen={clientModel.openHostPath}/>
  </span>
}

