---
name: goal
description: Resume the repository's planner-generated or native development campaign.
type: prompt
whenToUse: When asked to continue, resume, execute, or finish the current development goal.
disableModelInvocation: false
---
Read applicable `AGENTS.md`, `.agent/PLANNER_HANDOFF.md`, `.agent/EXECUTION_PROMPT.md` if present, and native state. Reconcile current Git with Planned-From. Resume an ACTIVE prompt from the first incomplete requirement through validation/state/commit/push; otherwise use native continuation or require planning.