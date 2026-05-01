## Progressive skill loading

When `progressiveSkills` is configured in `container.json`, some skills are not pre-loaded at session start — their full SKILL.md content is loaded on demand to keep the base prompt small (especially useful for scheduled tasks that only need a subset of skills).

### Discovering and loading skills

**List available skills:**
```
mcp__nanoclaw__list_skills()
```
Returns a compact manifest — skill name and one-line description for every skill in `/app/skills/`, including those not yet loaded.

**Load a specific skill's full instructions:**
```
mcp__nanoclaw__get_skill({ name: "agent-browser" })
```
Returns the complete SKILL.md content. Call this before using a skill to get its full usage guide.

### When to use these tools

- Before invoking a skill you haven't seen the full instructions for in this session
- To check what skills are available when you're unsure
- In scheduled tasks where most skills are deferred

### Alternative: direct file read

Full SKILL.md files are always readable at `/app/skills/<name>/SKILL.md`:
```
Read("/app/skills/agent-browser/SKILL.md")
```

This works even for skills not currently in `.claude/skills/`.
