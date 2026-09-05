import type { SVGProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  Clock,
  Copy,
  Dot,
  FileText,
  Filter,
  FlaskConical,
  Globe,
  GripVertical,
  ListTodo,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sun,
  Terminal,
  TrendingUp,
  TriangleAlert,
  Upload,
  Wrench,
  X,
} from 'lucide-react'

export type UiIconName =
  | 'agent'
  | 'alert'
  | 'arrow-big-down'
  | 'arrow-big-up'
  | 'arrow-down'
  | 'arrow-down-to-line'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-up-to-line'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'collapse'
  | 'copy'
  | 'dot'
  | 'drag'
  | 'exclamation'
  | 'expand'
  | 'filter'
  | 'menu'
  | 'moon'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'sort-down'
  | 'sort-up'
  | 'sun'
  | 'task'
  | 'tool-edit'
  | 'tool-generic'
  | 'tool-mcp'
  | 'tool-read'
  | 'tool-search'
  | 'tool-shell'
  | 'tool-test'
  | 'tool-web'
  | 'trend'
  | 'upload'

const icons = {
  agent: Bot,
  alert: TriangleAlert,
  'arrow-down': ChevronsDown,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ChevronsUp,
  'arrow-up-to-line': ArrowUpToLine,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  clock: Clock,
  close: X,
  collapse: Minimize2,
  copy: Copy,
  dot: Dot,
  drag: GripVertical,
  exclamation: CircleAlert,
  expand: Maximize2,
  filter: Filter,
  menu: Menu,
  moon: Moon,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  'sort-down': ChevronDown,
  'sort-up': ChevronUp,
  sun: Sun,
  task: ListTodo,
  'tool-edit': Pencil,
  'tool-generic': Wrench,
  'tool-mcp': Network,
  'tool-read': FileText,
  'tool-search': Search,
  'tool-shell': Terminal,
  'tool-test': FlaskConical,
  'tool-web': Globe,
  trend: TrendingUp,
  upload: Upload,
} satisfies Record<Exclude<UiIconName, 'arrow-big-down' | 'arrow-big-up'>, LucideIcon>

export interface UiIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: UiIconName
  size?: number
}

function BigArrowIcon({
  direction,
  size,
  className,
  ...props
}: Omit<UiIconProps, 'name'> & { direction: 'up' | 'down'; size: number }) {
  return <svg
    {...props}
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    {direction === 'up'
      ? <path d="M6 14V6.7H3.3L8 2l4.7 4.7H10V14Z" />
      : <path d="M6 2h4v7.3h2.7L8 14 3.3 9.3H6Z" />}
  </svg>
}

export function UiIcon({ name, size = 16, className, strokeWidth = 1.75, ...props }: UiIconProps) {
  if (name === 'arrow-big-up' || name === 'arrow-big-down') {
    return <BigArrowIcon
      {...props}
      className={className}
      size={size}
      direction={name === 'arrow-big-up' ? 'up' : 'down'}
    />
  }

  const Icon = icons[name]
  return <Icon
    {...props}
    className={className}
    size={size}
    strokeWidth={strokeWidth}
    aria-hidden="true"
    focusable="false"
  />
}
