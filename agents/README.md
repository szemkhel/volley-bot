# PR Review System

This directory contains the specialized review agents for the volley-bot repository.

## Architecture

Each agent runs as a **separate Node.js app** that:
1. Reviews the PR diff independently
2. Posts its own comment on the PR
3. Returns a verdict (APPROVED or NEEDS FIX)

The orchestrator runs all agents in parallel and handles the final decision.

## Agents

### 1. Code Quality Agent
- **Location**: `agents/code-quality/review.js`
- **Prompt**: `agents/code-quality/agent.md`
- **Focus**: Best practices, code structure, maintainability
- **Checks**: Syntax errors, broken imports, logic bugs, missing error handling, code style

### 2. Security Agent
- **Location**: `agents/security/review.js`
- **Prompt**: `agents/security/agent.md`
- **Focus**: Vulnerabilities, secrets, unsafe patterns
- **Checks**: Secret exposure, injection risks, unsafe dependencies, auth issues

### 3. Performance Agent
- **Location**: `agents/performance/review.js`
- **Prompt**: `agents/performance/agent.md`
- **Focus**: Efficiency, optimization
- **Checks**: Memory leaks, N+1 queries, unoptimized loops, large payloads

### 4. QA/Testing Agent
- **Location**: `agents/qa-testing/review.js`
- **Prompt**: `agents/qa-testing/agent.md`
- **Focus**: Test coverage, edge cases
- **Checks**: Missing tests, untested paths, broken error handling

## How It Works

1. **Trigger**: Cron job polls GitHub every 5 minutes for new PRs
2. **Orchestrator**: `agents/orchestrator.js` launches all 4 agents in parallel
3. **Review**: Each agent posts its own comment on the PR with its own verdict
4. **Decision**:
   - If ALL agents approve → PR is auto-approved
   - If ANY agent blocks → PR is NOT auto-approved

## Agent Comments

Each agent posts a comment with this format:

```markdown
## 📝 Code Quality Review

### ✅ APPROVED
No breaking issues found.

### ❌ NEEDS FIX
Breaking issues found:
- {issue 1}
- {issue 2}
```

## Running Manually

```bash
# Run all agents on a PR
cd /c/Users/patry/volley-bot
node agents/orchestrator.js --pr-number 56

# Run a single agent
cd agents/code-quality
node review.js
```

## Auto-Approval Logic

- **All Agents Approve** → PR is auto-approved via `gh pr review --approve`
- **Any Agent Blocks** → PR is NOT auto-approved, issues are listed for the author
- **Already Reviewed** → Agent skips (no duplicate comments)

## Adding a New Agent

1. Create directory: `agents/{agent-name}/`
2. Create prompt: `agents/{agent-name}/agent.md`
3. Create review script: `agents/{agent-name}/review.js`
4. Add to orchestrator: Update `AGENTS` array in `orchestrator.js`
5. Test with: `node agents/orchestrator.js --pr-number {PR_NUMBER}`

## Testing

A test PR (#56) was created to verify the system works correctly. The agents successfully found all intentional issues.
