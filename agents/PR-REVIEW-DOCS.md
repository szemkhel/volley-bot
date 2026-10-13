# PR Review System Documentation

## Overview

The PR Review System uses 4 specialized AI agents to automatically review every Pull Request in the `szemkhel/volley-bot` repository. Each agent focuses on a specific area of expertise and provides inline comments on the PR.

## Architecture

```
PR Created → Cron Poll (every 5m) → 4 Agents (parallel) → Review Comments → Auto-approve/Block
```

## Components

### 1. Cron Job (Trigger)
- **Job ID**: `42bb45ced22c`
- **Schedule**: Every 5 minutes
- **Function**: Polls GitHub for new PRs and triggers the review agents
- **Status**: ✅ Active

### 2. Review Agents

| Agent | Focus | Blocking Issues |
|-------|-------|-----------------|
| **Code Quality** | Best practices, code structure, maintainability | Syntax errors, broken imports, logic bugs, missing error handling |
| **Security** | Vulnerabilities, secrets, unsafe patterns | Secret exposure, injection risks, unsafe dependencies, auth issues |
| **Performance** | Efficiency, optimization | Memory leaks, N+1 queries, unoptimized loops, large payloads |
| **QA/Testing** | Test coverage, edge cases | Missing tests, untested paths, broken error handling, flaky tests |

### 3. Agent Prompts
Located in `agents/` directory:
- `agents/code-quality/agent.md`
- `agents/security/agent.md`
- `agents/performance/agent.md`
- `agents/qa-testing/agent.md`

## How It Works

1. **Trigger**: Cron job polls GitHub every 5 minutes for new PRs
2. **Review**: 4 agents review the PR diff in parallel
3. **Output**: Each agent comments inline on specific lines with issues
4. **Decision**:
   - If all agents approve → PR is auto-approved
   - If any agent blocks → PR is blocked until issues are resolved

## Agent Output Format

Each agent provides:
1. **Inline Comments**: Specific line numbers with issues
2. **Summary Comment**: `✅ APPROVED` or `❌ NEEDS FIX`
3. **Fix Suggestions**: Code snippets for suggested fixes

## Testing

A test PR (#56) was created to verify the system works correctly. The agents successfully found:
- Hardcoded secret (Security)
- Complex function (Code Quality)
- Unoptimized loop (Performance)
- Missing tests (QA/Testing)

## Future Improvements

1. **Webhook Integration**: Replace polling with GitHub webhooks for real-time triggering
2. **Custom Review Rules**: Add repo-specific review criteria
3. **Agent Configuration**: Allow per-repo agent configuration
4. **Review History**: Track review trends over time
5. **Agent Metrics**: Monitor agent accuracy and performance

## Maintenance

### Adding a New Agent
1. Create `agents/{agent-name}/agent.md` with review criteria
2. Update the cron job prompt to include the new agent
3. Test with a sample PR

### Updating Agent Criteria
1. Edit the appropriate `agent.md` file
2. Test with existing PRs to verify behavior
3. Update this documentation if needed

### Troubleshooting

**Issue**: Agents not reviewing PRs
- Check cron job status: `cronjob action='list'`
- Verify GitHub API access: `gh auth status`
- Check cron job logs: `cronjob action='list'`

**Issue**: Incorrect reviews
- Review agent prompt for clarity
- Add more specific examples to agent.md
- Test with known good/bad PRs

## Related Files

- `agents/README.md` - Agent overview
- `agents/code-quality/agent.md` - Code quality criteria
- `agents/security/agent.md` - Security criteria
- `agents/performance/agent.md` - Performance criteria
- `agents/qa-testing/agent.md` - QA/Testing criteria
