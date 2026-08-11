import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
for (const directory of ["schemas", "examples", "profiles", "workflows"]) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    JSON.parse(await readFile(`${directory}/${file.name}`, "utf8"));
  }
}
console.log("schemas/examples: valid JSON");
