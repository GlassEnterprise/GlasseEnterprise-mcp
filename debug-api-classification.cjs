const fs = require("fs");
const path = require("path");

// Test a specific file to see the AST classification
const testFile =
  "/Users/ahman/Desktop/workspace/mcp test/ReactJS-Spring-Boot-Full-Stack-App/react-frontend/src/api/HomeService.js";

console.log("=== TESTING API CLASSIFICATION ===");
console.log(`File: ${testFile}`);

if (fs.existsSync(testFile)) {
  const content = fs.readFileSync(testFile, "utf8");
  console.log("\n=== FILE CONTENT ===");
  console.log(content);

  // Simple regex tests
  console.log("\n=== REGEX TESTS ===");

  // Test for axios patterns
  const axiosPatterns = [
    /axios\.get\(/g,
    /axios\.post\(/g,
    /axios\.put\(/g,
    /axios\.delete\(/g,
    /axios\.patch\(/g,
  ];

  axiosPatterns.forEach((pattern) => {
    const matches = content.match(pattern);
    if (matches) {
      console.log(`Found ${pattern}: ${matches.length} matches`);
      matches.forEach((match) => console.log(`  - ${match}`));
    }
  });

  // Test for URL patterns
  const urlMatches = content.match(/"(https?:\/\/[^"]*)"|\/([\w\/\-\$\{\}]*)/g);
  if (urlMatches) {
    console.log("\nURL/Path patterns found:");
    urlMatches.forEach((match) => {
      const isFullURL = /^https?:\/\//.test(match.replace(/['"]/g, ""));
      console.log(`  - ${match} (isFullURL: ${isFullURL})`);
    });
  }
} else {
  console.log(`File not found: ${testFile}`);
}
