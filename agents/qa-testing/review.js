#!/usr/bin/env node

/**
 * QA/Testing Review Agent
 * Reviews PR diff for testing and QA issues
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
  c.body && c.body.includes('## 🧪 QA/Testing Review')
);

if (alreadyReviewed) {
  console.log('ALREADY_REVIEWED');
  process.exit(0);
}

// Simulate review (in production, this would call Claude/LLM)
const reviewResult = performQAReview(diff, prContext);

// Post comment
const commentBody = generateQAComment(reviewResult);
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
  agent: 'qa-testing',
  approved: reviewResult.approved,
  issues: reviewResult.issues,
  commentBody: commentBody
}));

function performQAReview(diff, context) {
  const issues = [];
  let approved = true;

  const lines = diff.split('\n');
  
  // Check for new functionality without tests
  const newFiles = context.files.filter(f => f.status === 'added');
  const existingTestFiles = context.files.filter(f => 
    f.path.startsWith('test/') && f.path.endsWith('.test.js')
  );
  
  newFiles.forEach(file => {
    if (file.path.endsWith('.js') && !file.path.endsWith('.test.js')) {
      // Check if there's a corresponding test file
      const testPath = file.path.replace('.js', '.test.js');
      const hasTest = existingTestFiles.some(f => f.path === testPath);
      
      if (!hasTest) {
        issues.push({
          line: 0,
          severity: 'medium',
          message: `New file '${file.path}' has no corresponding test file`
        });
      }
    }
  });

  // Check for error handling in new code
  lines.forEach((line, idx) => {
    if (line.includes('async') && line.includes('await') && !line.includes('try') && !line.includes('catch')) {
      issues.push({
        line: idx + 1,
        severity: 'medium',
        message: 'Async/await without error handling - consider adding try/catch'
      });
    }
    
    // Check for TODO comments without issue links
    if (line.includes('TODO') && !line.includes('https://')) {
      issues.push({
        line: idx + 1,
        severity: 'low',
        message: 'TODO without issue link'
      });
    }
  });

  // Check for missing input validation
  if (diff.includes('process.argv') || diff.includes('req.body') || diff.includes('req.query')) {
    if (!diff.includes('validate') && !diff.includes('sanitize') && !diff.includes('check')) {
      issues.push({
        line: 0,
        severity: 'high',
        message: 'Input handling detected without validation'
      });
      approved = false;
    }
  }

  return { approved, issues };
}

function generateQAComment(result) {
  let comment = `## 🧪 QA/Testing Review\n\n`;
  
  if (result.approved) {
    comment += `✅ **APPROVED**\n\n`;
    comment += `No breaking QA/testing issues found.\n\n`;
    
    if (result.issues.length > 0) {
      comment += `### Non-Breaking Issues\n\n`;
      result.issues.forEach(issue => {
        comment += `- **Line ${issue.line || 'N/A'}**: ${issue.message}\n`;
      });
      comment += `\n`;
    }
  } else {
    comment += `❌ **NEEDS FIX**\n\n`;
    comment += `Breaking QA/testing issues found:\n\n`;
    
    result.issues.forEach(issue => {
      comment += `### 🔴 Line ${issue.line || 'N/A'}: ${issue.message}\n\n`;
    });
    
    comment += `\n---\n`;
    comment += `**QA/Testing Agent**\n`;
  }
  
  return comment;
}
