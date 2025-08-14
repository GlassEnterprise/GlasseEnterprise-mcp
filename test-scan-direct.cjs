const { glob } = require("glob");
const path = require("path");

async function testGlob() {
  console.log("Testing glob patterns in:", process.cwd());
  
  // Test 1: Default patterns
  const defaultPatterns = [
    "**/*.js",
    "**/*.jsx",
    "**/*.ts",
    "**/*.tsx",
    "**/*.py",
    "**/*.java",
    "**/*.cs",
  ];
  
  const defaultExclude = [
    "node_modules/**",
    ".git/**",
    "build/**",
    "dist/**",
    "out/**",
  ];
  
  console.log("\nTest 1: Using default patterns");
  const files1 = await glob(defaultPatterns, {
    cwd: process.cwd(),
    ignore: defaultExclude,
    nodir: true,
  });
  console.log(`Found ${files1.length} files`);
  if (files1.length > 0) {
    console.log("Sample files:", files1.slice(0, 5));
  }
  
  // Test 2: Just TypeScript files in src
  console.log("\nTest 2: TypeScript files in src/");
  const files2 = await glob("src/**/*.ts", {
    cwd: process.cwd(),
    nodir: true,
  });
  console.log(`Found ${files2.length} TypeScript files in src/`);
  if (files2.length > 0) {
    console.log("Sample files:", files2.slice(0, 5));
  }
  
  // Test 3: All files in src
  console.log("\nTest 3: All files in src/");
  const files3 = await glob("src/**/*", {
    cwd: process.cwd(),
    nodir: true,
  });
  console.log(`Found ${files3.length} total files in src/`);
  
  // Test 4: Check specific directory
  console.log("\nTest 4: Files in src/scanner/");
  const files4 = await glob("src/scanner/*.ts", {
    cwd: process.cwd(),
    nodir: true,
  });
  console.log(`Found ${files4.length} TypeScript files in src/scanner/`);
  console.log("Files:", files4);
}

testGlob().catch(console.error);
