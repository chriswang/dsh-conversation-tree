/**
 * System-prompt guidance for the map tools.
 *
 * The tool schemas already reach the model automatically once registered; this
 * section only explains the map's role and the division of labor with other
 * planning surfaces (todo, plan mode). The numeric order sits between the goal
 * and workflow tool sections so the guidance reads next to the tool family.
 */
import type { HostContextLike, SystemPromptLike } from './context.js'

/** Prompt section text shown to every agent in profiles that load this plugin. */
export const MAP_GUIDANCE = [
  '## Conversation map (persistent node tree)',
  '- The conversation map is a node tree kept across sessions and app restarts. Its columns are named by depth: "L1", "L2", "L3", … The L1 column lists the Host workspaces, and a workspace is a registered local directory, so tools cannot create, rename or delete workspaces (L1 rows).',
  '- These tools create and manage L2+ topic nodes inside one existing workspace. By convention L2 holds a goal, L3 its strategies and L4 their tasks, but the labels are only depth: deeper levels are just L5, L6, … `map_plan_goal` makes a goal topic directly under a workspace (L2), strategy nodes under that goal (L3), and optional task nodes under each strategy (L4).',
  '- When the user asks to decompose a goal, lay out an implementation plan, or record a plan structure, persist it with `map_plan_goal` or `map_create_nodes` instead of only writing it in the reply. If no workspace exists yet, ask the user to create one from the map\'s first column (＋ needs a local directory).',
  '- Before creating nodes, call `map_list_workspaces` and `map_get_state` to see what already exists and avoid duplicate trees.',
  '- Node titles are at most 80 characters, descriptions at most 6000; a single call creates/updates at most 50 nodes.',
  '- Manage existing nodes with `map_update_nodes` / `map_move_nodes`; deletion requires an explicit mode and `confirm: true`.',
  '- File or re-file existing conversations with `map_attach_sessions` (files them under a node) and `map_move_session` (moves them between nodes of the workspace that owns them; omit `node_id` to put a conversation directly under its workspace row). A conversation can never change its workspace, and subagent children can never be filed.',
  '- Step lists for the current session stay in `todo_write`; the map is the cross-session persistent structure. Do not substitute one for the other.',
].join('\n')

/** Prompt section placement: between TOOL_GOAL (2400) and TOOL_WORKFLOW (2600). */
export const MAP_GUIDANCE_ORDER = 2500

/**
 * Register the map guidance section once `systemPrompt` is available.
 * @param ctx - Host plugin context.
 */
export function registerMapPromptSection(ctx: HostContextLike): void {
  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = scoped.get('systemPrompt') as SystemPromptLike | undefined
    if (systemPrompt?.section === undefined) return
    systemPrompt.section({
      name: 'conversation-map:guidance',
      order: MAP_GUIDANCE_ORDER,
      text: MAP_GUIDANCE,
    })
  })
}
