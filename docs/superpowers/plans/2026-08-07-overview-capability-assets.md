# Overview Capability Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only "概览" page that shows each AI coding tool's capability assets and highlights frequently used assets across tools.

**Architecture:** Add a focused backend module that builds overview data from static tool metadata, local filesystem discovery, and timeline call counts. Add a route and frontend tab that renders one card per tool plus a compact high-frequency cross-tool matrix.

**Tech Stack:** Node.js CommonJS backend, better-sqlite3 timeline data, native browser JavaScript, existing CSS/Tailwind utility style.

---

### Task 1: Backend Overview Data

**Files:**
- Create: `server/overview.js`
- Test: `test/overview.test.js`

- [ ] Write failing tests for tool grouping, high-frequency asset marking, and matrix coverage.
- [ ] Run `node --test test/overview.test.js` and verify the tests fail because `server/overview.js` does not exist.
- [ ] Implement `buildOverview()` and `queryOverview()`.
- [ ] Run `node --test test/overview.test.js` and verify it passes.

### Task 2: API Route

**Files:**
- Modify: `server/routes.js`
- Modify: `server/server.js`
- Modify: `src/utils.js`

- [ ] Add `handleApiOverview`.
- [ ] Wire `/api/overview`.
- [ ] Add `fetchOverview()`.
- [ ] Run overview and route-related tests.

### Task 3: Frontend Page

**Files:**
- Create: `src/overview/index.js`
- Modify: `src/app.js`
- Modify: `index.html`
- Modify: `src/style.css`

- [ ] Add a top-level "概览" tab.
- [ ] Render tool cards and high-frequency cross-tool coverage.
- [ ] Load data when the tab is opened.
- [ ] Keep the existing source/project filter bar useful for replay and tool-stack pages without blocking overview.

### Task 4: Verification

**Files:**
- Existing test suite and production build.

- [ ] Run `node --test`.
- [ ] Run `npm run build`.
- [ ] Start a local dev server if needed and inspect the page.
