import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("capability artifact schema", () => {
  it("validates the prepare-savings example", async () => {
    const [schemaText, artifactText] = await Promise.all([
      readFile(`${projectRoot}schemas/capability-artifact.schema.json`, "utf8"),
      readFile(`${projectRoot}artifacts/prepare-savings-subaccount.example.json`, "utf8"),
    ]);
    const schema: unknown = JSON.parse(schemaText);
    const artifact: unknown = JSON.parse(artifactText);
    const ajv = new Ajv2020({ allowUnionTypes: true, strict: true });
    addFormatsModule.default(ajv);
    const validate = ajv.compile(schema as AnySchema);

    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
  });
});
