# Skill: [Skill Name]

## Purpose
[One paragraph — what this skill does, when it runs, what it produces]

## Context
[What the agent needs to know about the domain — generic, no client specifics]

## Instructions

[Step by step instructions for Claude to follow]

1. [First step]
2. [Second step]
3. [Third step]

## Output Format

[Describe exactly what the output should look like]

## Error Handling

If [error condition], then [what to do].
If you cannot complete the task, explain why clearly and suggest next steps.

## Self-Reflection Protocol

If during this task you determine the current approach is insufficient
or a better method exists, output exactly this on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [One paragraph describing the improvement needed.
What capability is missing. What would solve it. Generic — no client names,
no specific data, no workspace-specific context. Must be universally applicable.]

Example of good SKILL_IMPROVEMENT_CANDIDATE:
"The current fetch-based verification cannot detect JavaScript rendering failures
or visual layout issues. Playwright screenshot verification would catch these
cases and reduce false positives significantly, benefiting any workspace
that builds web deliverables."

Example of bad SKILL_IMPROVEMENT_CANDIDATE (too specific — will be flagged):
"Fairway Chiropractic's website uses a custom CMS that requires login before
the page loads, so fetch returns empty."
