const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GeminiModelConfigStore,
  normalizeConfiguredModels
} = require("../services/geminiModelConfigStore");

test("normaliza la prioridad sin duplicar modelos", () => {
  assert.deepEqual(
    normalizeConfiguredModels([
      "models/gemini-superior",
      "gemini-respaldo",
      "gemini-superior"
    ]),
    ["gemini-superior", "gemini-respaldo"]
  );
});

test("persiste y vuelve a cargar la prioridad de modelos", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-models-"));
  const file = path.join(directory, "models.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = new GeminiModelConfigStore({
    file,
    defaults: ["gemini-inicial"]
  });
  await store.saveModels(["gemini-superior", "gemini-respaldo"]);
  await store.saveModels(["gemini-respaldo", "gemini-superior"]);

  const reloaded = new GeminiModelConfigStore({ file });
  assert.deepEqual(reloaded.getModels(), [
    "gemini-respaldo",
    "gemini-superior"
  ]);
  assert.ok(reloaded.getStatus().actualizadoEn);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
    []
  );
});
