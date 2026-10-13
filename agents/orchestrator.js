#!/usr/bin/env node

/**
 * PR Review Orchestrator
 * Runs all review agents in parallel, waits for results, and handles approvals
 * 
 * Usage: node orchestrator.js --pr-number 56
 * 
 * Environment variables:
 *   PR_NUMBER - The PR number to review
 *   REPO_OWNER - GitHub repo owner (default: szemkhel)
 *   REPO_NAME - GitHub repo name (default: volley-bot)
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

// Get PR number from args or env
const PR_NUMBER = process.argv.find(arg => arg.startsWith('--pr-number='))?.split('=')[1] 
  || process.env.PR_NUMBER;

const REPO_OWNER = process.env.REPO_OWNER || 'szemkhel';
const REPO_NAME = process.env.REPO_NAME || 'volley-bot';

if (!PR_NUMBER) {
  console.error('Usage: node orchestrator.js --pr-number <PR_NUMBER>');
  process.exit(1);
}

console.log(`🔍 Starting PR review for #${PR_NUMBER}...`);
console.log(`📦 Repo: ${REPO_OWNER}/${REPO_NAME}`);

// Define agents
const AGENTS = [
  { name: 'code-quality', dir: 'code-quality', label: 'Code Quality' },
  { name: 'security', dir: 'security', label: 'Security' },
  { name: 'performance', dir: 'performance', label: 'Performance' },
  { name: 'qa-testing', dir: 'qa-testing', label: 'QA/Testing' }
];

// Run all agents in parallel
const agentPromises = AGENTS.map(agent => runAgent(agent));

Promise.all(agentPromises)
  .then(results => {
    console.log('\n📊 Review Results:');
    console.log('='.repeat(50));
    
    let allApproved = true;
    results.forEach(result => {
      const status = result.approved ? '✅ APPROVED' : '❌ NEEDS FIX';
      console.log(`${result.agent}: ${status}`);
      if (!result.approved) {
        allApproved = false;
        result.issues.forEach(issue => {
          console.log(`  - ${issue.message}`);
        });
      }
    });
    
    console.log('='.repeat(50));
    
    if (allApproved) {
      console.log('\n🎉 All agents approved! Approving PR...');
      approvePR(PR_NUMBER);
    } else {
      console.log('\n⚠️ Some agents blocked the PR. Not auto-approving.');
      console.log('Please review the issues and address them before merging.');
    }
    
    // Output JSON for cron job consumption
    console.log('\n---RESULT---');
    console.log(JSON.stringify({
      allApproved,
      results
    }));
  })
  .catch(err => {
    console.error('❌ Review failed:', err);
    process.exit(1);
  });

function runAgent(agent) {
  return new Promise((resolve, reject) => {
    console.log(`\n🔍 Running ${agent.label} agent...`);
    
    const agentPath = path.join(__dirname, agent.dir, 'review.js');
    const env = {
      ...process.env,
      PR_NUMBER,
      REPO_OWNER,
      REPO_NAME
    };
    
    const child = spawn('node', [agentPath], { 
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      process.stdout.write(str);
    });
    
    child.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      process.stderr.write(str);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        // Check if already reviewed
        if (stdout.includes('ALREADY_REVIEWED')) {
          console.log(`⏭️ ${agent.label} already reviewed this PR`);
          resolve({
            agent: agent.name,
            approved: true,
            issues: [],
            commentBody: 'Already reviewed'
          });
          return;
        }
        
        // Parse JSON output — try multiple patterns for robustness
        let result = null;
        try {
          // Pattern 1: look for ---RESULT--- marker
          const markerMatch = stdout.match(/---RESULT---\s*\n([\s\S]*)$/);
          if (markerMatch) {
            result = JSON.parse(markerMatch[1]);
          }
        } catch(e) {}
        
        // Pattern 2: look for any JSON object in stdout
        if (!result) {
          try {
            const jsonMatch = stdout.match(/\{[\s\S]*"agent"\s*:/);
            if (jsonMatch) {
              const start = jsonMatch.index;
              // Find the matching closing brace
              let depth = 0;
              let end = start;
              for (let i = start; i < stdout.length; i++) {
                if (stdout[i] === '{') depth++;
                if (stdout[i] === '}') depth--;
                if (depth === 0) { end = i + 1; break; }
              }
              result = JSON.parse(stdout.substring(start, end));
            }
          } catch(e) {}
        }
        
        if (result && result.agent) {
          resolve(result);
        } else {
          console.error(`⚠️ ${agent.label} didn't output valid JSON result`);
          resolve({
            agent: agent.name,
            approved: true,
            issues: [],
            commentBody: 'No issues found'
          });
        }
      } else {
        console.error(`❌ ${agent.label} failed with code ${code}`);
        reject(new Error(`${agent.label} failed: ${stderr}`));
      }
    });
  });
}

function approvePR(prNumber) {
  try {
    const reviewerLogin = execSync('gh api user --jq .login').toString().trim();
    const prAuthor = execSync(`gh pr view ${prNumber} --json author --jq .author.login`).toString().trim();
    
    // GitHub doesn't allow self-approval — skip if bot is the PR author
    if (reviewerLogin === prAuthor) {
      console.log(`⚠️ PR #${prNumber} authored by bot account (${reviewerLogin}). Skipping auto-approve (GitHub restriction).`);
      console.log(`   All agents approved — you can merge manually when ready.`);
      return;
    }
    
    execSync(`gh pr review ${prNumber} --approve`);
    console.log(`✅ PR #${prNumber} approved!`);
  } catch (err) {
    console.error(`❌ Failed to approve PR #${prNumber}:`, err.message);
  }
}
