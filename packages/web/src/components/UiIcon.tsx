import type { SVGProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
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
  'arrow-big-down': ArrowDown,
  'arrow-big-up': ArrowUp,
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
} satisfies Record<UiIconName, LucideIcon>

export interface UiIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: UiIconName
  size?: number
}

export function UiIcon({ name, size = 16, className, strokeWidth = 1.75, ...props }: UiIconProps) {
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
