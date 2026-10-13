#!/usr/bin/env node

/**
 * Security Review Agent
 * Reviews PR diff for security vulnerabilities
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
  c.body && c.body.includes('## 🔒 Security Review')
);

if (alreadyReviewed) {
  console.log('ALREADY_REVIEWED');
  process.exit(0);
}

// Simulate review (in production, this would call Claude/LLM)
const reviewResult = performSecurityReview(diff, prContext);

// Post comment
const commentBody = generateSecurityComment(reviewResult);
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
  agent: 'security',
  approved: reviewResult.approved,
  issues: reviewResult.issues,
  commentBody: commentBody
}));

function performSecurityReview(diff, context) {
  const issues = [];
  let approved = true;

  const lines = diff.split('\n');
  
  // Check for hardcoded secrets
  const secretPatterns = [
    { pattern: /ghp_[A-Za-z0-9]{36}/, name: 'GitHub PAT' },
    { pattern: /sk-[A-Za-z0-9]{32,}/, name: 'API Key' },
    { pattern: /Bearer [A-Za-z0-9-._~+\/]+=*/, name: 'Bearer Token' },
    { pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: 'Private Key' },
    { pattern: /password\s*[:=]\s*["'][^"']+["']/i, name: 'Hardcoded Password' },
    { pattern: /api[_-]?key\s*[:=]\s*["'][^"']+["']/i, name: 'Hardcoded API Key' },
    { pattern: /secret\s*[:=]\s*["'][^"']+["']/i, name: 'Hardcoded Secret' },
  ];

  lines.forEach((line, idx) => {
    // Only check added lines (lines starting with +) or context lines
    const isAdded = line.startsWith('+') && !line.startsWith('+++');
    if (!isAdded) return;
    
    const content = line.substring(1); // strip the + prefix
    
    secretPatterns.forEach(({ pattern, name }) => {
      if (pattern.test(content)) {
        issues.push({
          line: idx + 1,
          severity: 'high',
          message: `Potential ${name} detected`
        });
        approved = false;
      }
    });
    
    // Check for SQL injection patterns
    if (content.includes('SELECT') && content.includes('+') && !content.includes('WHERE')) {
      issues.push({
        line: idx + 1,
        severity: 'high',
        message: 'Potential SQL injection vulnerability'
      });
      approved = false;
    }
    
    // Check for command injection
    if (content.includes('exec(') || content.includes('spawn(')) {
      issues.push({
        line: idx + 1,
        severity: 'medium',
        message: 'Command execution detected - ensure input is sanitized'
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
    
    // Check for hardcoded IPs
    if (content.match(/192\.168\.\d+\.\d+/)) {
      issues.push({
        line: idx + 1,
        severity: 'low',
        message: 'Hardcoded IP address detected'
      });
    }
  });

  // Check for unsafe dependencies
  if (diff.includes('npm install') || diff.includes('yarn add')) {
    issues.push({
      line: 0,
      severity: 'medium',
      message: 'Dependency change detected - verify package security'
    });
  }

  return { approved, issues };
}

function generateSecurityComment(result) {
  let comment = `## 🔒 Security Review\n\n`;
  
  if (result.approved) {
    comment += `✅ **APPROVED**\n\n`;
    comment += `No breaking security issues found.\n\n`;
    
    if (result.issues.length > 0) {
      comment += `### Non-Breaking Issues\n\n`;
      result.issues.forEach(issue => {
        comment += `- **Line ${issue.line || 'N/A'}**: ${issue.message}\n`;
      });
      comment += `\n`;
    }
  } else {
    comment += `❌ **NEEDS FIX**\n\n`;
    comment += `Breaking security issues found:\n\n`;
    
    result.issues.forEach(issue => {
      comment += `### 🔴 Line ${issue.line || 'N/A'}: ${issue.message}\n\n`;
    });
    
    comment += `\n---\n`;
    comment += `**Security Agent**\n`;
  }
  
  return comment;
}
