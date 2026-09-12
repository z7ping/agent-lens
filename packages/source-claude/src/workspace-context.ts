export const CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY = 'claude:known-project-cwds:v1'
export const CLAUDE_KNOWN_PROJECT_DATA_ROOTS_CHECKPOINT_KEY = 'claude:known-project-data-roots:v1'

export interface ClaudeKnownProjectDataRoot {
  cwd: string
  projectDataRoot: string
}
