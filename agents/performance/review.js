#!/usr/bin/env node

/**
 * Performance Review Agent
 * Reviews PR diff for performance issues
 * Posts its own comment on the PR
 * Returns: { approved: boolean, commentBody: string, issues: [] }
 */

const { execSync } = require('child_process');

const PR_NUMBER = process.env.PR_NUMBER;
const REPO_OWNER = process.env.REPO_OWNER || 'szemkhel';
const REPO_NAME = process.env.REPO_NAME || 'volley-bot';

if (!PR_NUMBER) {
  console.error('PR_NUMBER environment variable is required');
  process.exit(1);
}

// Get PR diff
let diff;
try {
  diff = execSync(`gh pr diff ${PR_NUMBER}`, { encoding: 'utf8' });
} catch (err) {
  console.error('Failed to get PR diff:', err.message);
  process.exit(1);
}

// Get PR context
let prContext;
try {
  prContext = JSON.parse(execSync(`gh pr view ${PR_NUMBER} --json title,body,headRefName,baseRefName,files`, { encoding: 'utf8' }));
} catch (err) {
  console.error('Failed to get PR context:', err.message);
  process.exit(1);
}

// Get PR comments to check if already reviewed
let comments;
try {
  comments = JSON.parse(execSync(`gh pr view ${PR_NUMBER} --json comments`, { encoding: 'utf8' })).comments;
} catch (err) {
  console.error('Failed to get PR comments:', err.message);
  process.exit(1);
}

// Check if already reviewed by this agent
const alreadyReviewed = comments.some(c => 
  c.body && c.body.includes('## ⚡ Performance Review')
);

if (alreadyReviewed) {
  console.log('ALREADY_REVIEWED');
  process.exit(0);
}

// Simulate review (in production, this would call Claude/LLM)
const reviewResult = performPerformanceReview(diff, prContext);

// Post comment
const commentBody = generatePerformanceComment(reviewResult);
const tmpFile = require('os').tmpdir() + '/pr-comment-' + process.pid + '.md';
require('fs').writeFileSync(tmpFile, commentBody);
try {
  execSync(`gh pr comment ${PR_NUMBER} --body-file ${tmpFile}`);
} catch (err) {
  console.error('Failed to post comment:', err.message);
  process.exit(1);
} finally {
  try { require('fs').unlinkSync(tmpFile); } catch(e) {}
}

// Output result for orchestrator
console.log(JSON.stringify({
  agent: 'performance',
  approved: reviewResult.approved,
  issues: reviewResult.issues,
  commentBody: commentBody
}));

function performPerformanceReview(diff, context) {
  const issues = [];
  let approved = true;

  const lines = diff.split('\n');
  const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.substring(1));
  const addedText = addedLines.join('\n');

  // Check for nested loops (O(n²) patterns)
  let inLoop = 0;
  let maxLoopDepth = 0;
  addedLines.forEach((line) => {
    if (line.match(/\bfor\s*\(/) || line.match(/\bwhile\s*\(/)) inLoop++;
    if (inLoop > maxLoopDepth) maxLoopDepth = inLoop;
    if (line.trim().startsWith('}') && inLoop > 0) inLoop = Math.max(0, inLoop - 1);
  });
  
  if (maxLoopDepth >= 2) {
    issues.push({
      line: 0,
      severity: 'high',
      message: `Nested loops detected (depth ${maxLoopDepth}) - potential O(n²) or worse performance issue`
    });
    approved = false;
  }

  // Check for synchronous file operations
  if (addedText.includes('readFileSync') || addedText.includes('writeFileSync') || addedText.includes('existsSync')) {
    issues.push({
      line: 0,
      severity: 'high',
      message: 'Synchronous file operations detected - blocks event loop'
    });
    approved = false;
  }

  // Check for large array/object creation in loops
  if (addedText.includes('.push(') && addedText.match(/\bfor\s*\(/)) {
    issues.push({
      line: 0,
      severity: 'medium',
      message: 'Array push in loop detected - consider pre-allocating or using a more efficient pattern'
    });
  }

  // Check for JSON.stringify in loops
  if (addedText.includes('JSON.stringify') && addedText.match(/\bfor\s*\(/)) {
    issues.push({
      line: 0,
      severity: 'medium',
      message: 'JSON.stringify in loop detected - potential performance bottleneck'
    });
  }

  // Check for N+1 query patterns
  if (addedText.includes('.forEach') && addedText.includes('.query') && addedText.includes('await')) {
    issues.push({
      line: 0,
      severity: 'high',
      message: 'Potential N+1 query pattern detected'
    });
    approved = false;
  }

  return { approved, issues };
}

function generatePerformanceComment(result) {
  let comment = `## ⚡ Performance Review\n\n`;
  
  if (result.approved) {
    comment += `✅ **APPROVED**\n\n`;
    comment += `No breaking performance issues found.\n\n`;
    
    if (result.issues.length > 0) {
      comment += `### Non-Breaking Issues\n\n`;
      result.issues.forEach(issue => {
        comment += `- **Line ${issue.line || 'N/A'}**: ${issue.message}\n`;
      });
      comment += `\n`;
    }
  } else {
    comment += `❌ **NEEDS FIX**\n\n`;
    comment += `Breaking performance issues found:\n\n`;
    
    result.issues.forEach(issue => {
      comment += `### 🔴 Line ${issue.line || 'N/A'}: ${issue.message}\n\n`;
    });
    
    comment += `\n---\n`;
    comment += `**Performance Agent**\n`;
  }
  
  return comment;
}
