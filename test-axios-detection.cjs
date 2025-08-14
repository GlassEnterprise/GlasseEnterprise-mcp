const fs = require("fs");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

// Test the exact file
const testFile =
  "/Users/ahman/Desktop/workspace/mcp test/ReactJS-Spring-Boot-Full-Stack-App/react-frontend/src/api/HomeService.js";

console.log("=== TESTING AXIOS AST DETECTION ===");

if (fs.existsSync(testFile)) {
  const content = fs.readFileSync(testFile, "utf8");
  console.log("File content:");
  console.log(content);
  console.log("\n=== AST ANALYSIS ===");

  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const tree = parser.parse(content);
  const root = tree.rootNode;

  function walk(node, cb) {
    cb(node);
    const count = node.namedChildCount ?? 0;
    for (let i = 0; i < count; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, cb);
    }
  }

  walk(root, (n) => {
    const type = n.type;

    if (type === "member_expression") {
      const obj = n.childForFieldName?.("object") || n.child(0);
      const prop = n.childForFieldName?.("property") || n.child(2);
      const objText = obj?.text ?? "";
      const propText = prop?.text ?? "";

      console.log(`\n--- MEMBER_EXPRESSION ---`);
      console.log(`Object: "${objText}"`);
      console.log(`Property: "${propText}"`);
      console.log(`Full text: "${n.text}"`);
      console.log(`Parent type: ${n.parent?.type}`);

      if (
        objText === "axios" &&
        ["get", "post", "put", "delete", "patch"].includes(propText)
      ) {
        console.log(`🔍 FOUND AXIOS CALL: ${objText}.${propText}`);
      }
    }

    if (type === "call_expression") {
      const fnNode = n.childForFieldName?.("function") || n.child(0);
      const fnText = fnNode?.text ?? "";

      if (fnText.includes("axios")) {
        console.log(`\n--- CALL_EXPRESSION with axios ---`);
        console.log(`Function: "${fnText}"`);
        console.log(`Full text: "${n.text}"`);
      }
    }
  });
} else {
  console.log(`File not found: ${testFile}`);
}
