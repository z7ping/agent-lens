import { clientModel } from '../client/model'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalFileLink, parseLocalFileTarget } from './LocalFileLink'
import { LocalPathActions } from './LocalPathActions'
import './local-resource-reference.css'

export type LocalResourceKind = 'file' | 'directory' | 'path'
export type LocalResourcePresentation = 'block' | 'inline'

export interface LocalResourceReferenceProps {
  value: string
  kind: LocalResourceKind
  presentation?: LocalResourcePresentation
  displayValue?: string
  className?: string
}

export function isActionableLocalResource(value: string): boolean {
  return parseLocalFileTarget(value) !== null
}

export function LocalResourceReference({
  value,
  kind,
  presentation = 'block',
  displayValue,
  className = '',
}: LocalResourceReferenceProps) {
  const target = parseLocalFileTarget(value)
  const label = displayValue ?? value
  if (!target) {
    return presentation === 'block'
      ? <CopyableCodeBlock className={className} copyValue={value}>{label}</CopyableCodeBlock>
      : <span className={className}>{label}</span>
  }

  const classes = `local-resource-reference is-${presentation} is-${kind} ${className}`.trim()
  const content = kind === 'file'
    ? <LocalFileLink href={value} className="local-resource-link"><code title={value}>{label}</code></LocalFileLink>
    : <code title={value}>{label}</code>

  return <span className={classes} data-local-resource-kind={kind}>
    <span className="local-resource-value">{content}</span>
    <LocalPathActions path={target.path} onOpen={clientModel.openHostPath}/>
  </span>
}

