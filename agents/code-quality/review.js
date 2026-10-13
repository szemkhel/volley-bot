#!/usr/bin/env node

/**
 * Code Quality Review Agent
 * Reviews PR diff for code quality issues (best practices, structure, maintainability)
 * Posts its own comment on the PR
 * Returns: { approved: boolean, commentBody: string, issues: [] }
 */

const { execSync } = require('child_process');

// PR context from stdin or args
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
  c.body && c.body.includes('## 📝 Code Quality Review')
);

if (alreadyReviewed) {
  console.log('ALREADY_REVIEWED');
  process.exit(0);
}

// Simulate review (in production, this would call Claude/LLM)
// For now, we'll do basic checks and generate a realistic review
const reviewResult = performCodeQualityReview(diff, prContext);

// Post comment
const commentBody = generateCodeQualityComment(reviewResult);
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
  agent: 'code-quality',
  approved: reviewResult.approved,
  issues: reviewResult.issues,
  commentBody: commentBody
}));

function performCodeQualityReview(diff, context) {
  const issues = [];
  let approved = true;

  const lines = diff.split('\n');
  
  lines.forEach((line, idx) => {
    const isAdded = line.startsWith('+') && !line.startsWith('+++');
    if (!isAdded) return;
    
    const content = line.substring(1);
    
    // Check for console.log (should use pino in production)
    if (content.includes('console.log') && !content.includes('//')) {
      issues.push({
        line: idx + 1,
        severity: 'medium',
        message: 'Use pino logger instead of console.log'
      });
    }
    
    // Check for TODO comments without issue links
    if (content.includes('TODO') && !content.includes('https://')) {
      issues.push({
        line: idx + 1,
        severity: 'low',
        message: 'TODO without issue link'
      });
    }
    
    // Check for eval() usage
    if (content.includes('eval(')) {
      issues.push({
        line: idx + 1,
        severity: 'high',
        message: 'eval() usage detected - security and maintainability risk'
      });
      approved = false;
    }
    
    // Check for with statements
    if (content.includes('with (')) {
      issues.push({
        line: idx + 1,
        severity: 'high',
        message: 'with statement detected - forbidden in strict mode'
      });
      approved = false;
    }
    
    // Check for magic numbers without constants
    if (content.match(/\b[0-9]{2,}\b/) && !content.match(/[A-Z_]+\s*=/) && !content.includes('0x') && !content.includes('1000') && !content.includes('1024')) {
      issues.push({
        line: idx + 1,
        severity: 'low',
        message: 'Magic number detected - consider using a named constant'
      });
    }
  });

  // Check for missing error handling in async code
  if (diff.includes('async') && diff.includes('await') && !diff.includes('try') && !diff.includes('catch')) {
    issues.push({
      line: 0,
      severity: 'medium',
      message: 'Async/await without try/catch - unhandled promise rejections'
    });
  }

  // Check for unused variables in added code
  const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.substring(1));
  const varDeclarations = addedLines.filter(l => l.match(/\blet\s+|var\s+|const\s+/)).map(l => l.replace(/\blet\s+|var\s+|const\s+/, '').split('=')[0].trim().split(',')[0].trim());
  const allAddedText = addedLines.join('\n');
  
  varDeclarations.forEach(varName => {
    if (varName && !allAddedText.includes(varName + '.') && !allAddedText.includes(' ' + varName + ' ') && !allAddedText.includes('(' + varName + ')') && !allAddedText.includes(varName + ';')) {
      issues.push({
        line: 0,
        severity: 'low',
        message: `Variable '${varName}' may be unused`
      });
    }
  });

  return { approved, issues };
}

function generateCodeQualityComment(result) {
  let comment = `## 📝 Code Quality Review\n\n`;
  
  if (result.approved) {
    comment += `✅ **APPROVED**\n\n`;
    comment += `No breaking code quality issues found.\n\n`;
    
    if (result.issues.length > 0) {
      comment += `### Non-Breaking Issues\n\n`;
      result.issues.forEach(issue => {
        comment += `- **Line ${issue.line || 'N/A'}**: ${issue.message}\n`;
      });
      comment += `\n`;
    }
  } else {
    comment += `❌ **NEEDS FIX**\n\n`;
    comment += `Breaking code quality issues found:\n\n`;
    
    result.issues.forEach(issue => {
      comment += `### 🔴 Line ${issue.line || 'N/A'}: ${issue.message}\n\n`;
    });
    
    comment += `\n---\n`;
    comment += `**Code Quality Agent**\n`;
  }
  
  return comment;
}
