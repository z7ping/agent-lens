import type { SVGProps } from 'react'
import {
  type LucideIcon,
  ArchiveRestore,
  Brain,
  LoaderCircle,
  CheckCircle2,
  CircleX,
  ArrowBigDown,
  ArrowBigUp,
  ArrowDown,
  ArrowUp,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  Copy,
  Dot,
  Eye,
  FileText,
  File,
  FileCode2,
  Link2,
  Filter,
  FolderOpen,
  FlaskConical,
  Globe,
  GitFork,
  GripVertical,
  Info,
  Layers,
  Shield,
  ListTodo,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Sun,
  SquareTerminal,
  TrendingUp,
  TriangleAlert,
  Upload,
  Wrench,
  X,
} from 'lucide-react'

export type UiIconName =
  | 'agent'
  | 'backup'
  | 'thinking'
  | 'loading'
  | 'status-success'
  | 'status-error'
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
  | 'event-permission'
  | 'event-subagent'
  | 'event-context'
  | 'expand'
  | 'filter'
  | 'file'
  | 'file-code'
  | 'link'
  | 'folder-open'
  | 'info'
  | 'language'
  | 'menu'
  | 'moon'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'plus'
  | 'power'
  | 'preview'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'sliders-horizontal'
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
  backup: ArchiveRestore,
  thinking: Brain,
  loading: LoaderCircle,
  'status-success': CheckCircle2,
  'status-error': CircleX,
  alert: TriangleAlert,
  'arrow-big-down': ArrowBigDown,
  'arrow-big-up': ArrowBigUp,
  'arrow-down': ArrowDown,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
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
  'event-permission': Shield,
  'event-subagent': GitFork,
  'event-context': Layers,
  expand: Maximize2,
  filter: Filter,
  file: File,
  'file-code': FileCode2,
  link: Link2,
  'folder-open': FolderOpen,
  info: Info,
  language: Globe,
  menu: Menu,
  moon: Moon,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  plus: Plus,
  power: Power,
  preview: Eye,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  'sort-down': ChevronDown,
  'sort-up': ChevronUp,
  sun: Sun,
  task: ListTodo,
  'tool-edit': Pencil,
  'tool-generic': Wrench,
  'tool-mcp': Network,
  'tool-read': FileText,
  'tool-search': Search,
  'tool-shell': SquareTerminal,
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