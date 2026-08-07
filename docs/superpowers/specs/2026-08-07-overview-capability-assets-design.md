# Overview Capability Assets Design

## Goal

Add an independent "概览" page that helps users understand each AI coding tool's capability assets and whether frequently used, valuable assets are also available in other tools.

## Product Decisions

- The page name is "概览".
- The page uses one card per AI tool as the primary structure.
- Global aggregate counts are not a primary feature because they do not help the user compare tool capability assets.
- Each tool card shows the tool identity and capability assets grouped by type.
- The first version treats frequently called assets as "优质资产".
- The page should help answer: "This asset is useful in one tool. Do other tools also have it?"

## Page Structure

The top navigation adds a first-level "概览" tab alongside the existing task replay and tool stack tabs.

Each tool card shows:

- Tool name and short description.
- Version when detectable.
- Configuration directory when known.
- Asset groups: Skills, MCP, Plugins, Extensions, Hooks, Adapters, and built-in capabilities.
- Frequently used assets highlighted as "高频".
- Cross-tool coverage for high-frequency assets: 已有, 等价, 缺失, or 未知.

## Data Model

The backend exposes an overview payload:

- `tools`: tool cards.
- `priority_assets`: frequently used assets across tools.
- `capability_matrix`: high-frequency capability names mapped to per-tool coverage status.

Each asset contains:

- `name`
- `type`
- `tool`
- `status`
- `path`
- `description`
- `call_count`
- `is_priority`
- `coverage`

## First Version Scope

The first implementation is read-only. It scans known local configuration locations and combines that inventory with existing timeline call counts. It does not install, uninstall, enable, disable, or mutate external tools.

## Non-Goals

- No one-click plugin installation.
- No destructive configuration edits.
- No authoritative online catalog lookup.
- No complete parity detection for every tool ecosystem.

## Validation

Backend tests should verify that assets are grouped by tool, high-frequency assets are marked, and the capability matrix shows whether other tools have the same capability name.
