import { Composio } from "@composio/core";
import { writeFile } from "fs/promises";

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
});

for (const toolkit of ["googlesuper", "github"]) {
  const tools = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: 1000,
  });
  await writeFile(
    `${toolkit}_tools.json`,
    JSON.stringify(tools, null, 2),
    "utf-8"
  );
  console.log(`${toolkit}: ${tools.length} tools → ${toolkit}_tools.json`);
}