import { discover } from "./src/tool/typescript/index.ts"

console.log("=== Testing discover.help('libs') ===")
console.log(discover.help("libs"))
console.log("\n=== Testing discover.help('background') ===")
console.log(discover.help("background"))