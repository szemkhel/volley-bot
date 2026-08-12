// Test file with intentional issues for PR review demonstration
// This file has:
// - Security issue (hardcoded secret)
// - Code quality issue (complex function)
// - Performance issue (unoptimized loop)
// - QA issue (no tests)

const API_KEY = "sk-test-1234567890abcdef"; // Security: hardcoded secret

function processData(data) {
  // Code Quality: complex function with multiple responsibilities
  let result = [];
  let temp = [];
  let count = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (data[i].type === "A") {
      if (data[i].value > 0) {
        temp.push(data[i].value);
        count++;
        if (count > 100) {
          result.push(temp);
          temp = [];
          count = 0;
        }
      }
    }
  }
  
  // Performance: unoptimized operation
  for (let i = 0; i < temp.length; i++) {
    for (let j = 0; j < temp.length; j++) {
      if (temp[i] === temp[j] && i !== j) {
        result.push(temp[i]);
      }
    }
  }
  
  return result;
}

module.exports = { processData };
