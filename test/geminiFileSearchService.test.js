const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GeminiFileSearchService
} = require("../services/geminiFileSearchService");

function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase()
        )?.[1] || null
    },
    text: async () => JSON.stringify(data)
  };
}

test("lista todos los File Search Stores paginados", async () => {
  const service = new GeminiFileSearchService({
    apiKey: "clave-de-prueba",
    fetchImpl: async (url) => {
      if (url.includes("pageToken=segunda")) {
        return jsonResponse({
          fileSearchStores: [{ name: "fileSearchStores/dos" }]
        });
      }
      return jsonResponse({
        fileSearchStores: [{ name: "fileSearchStores/uno" }],
        nextPageToken: "segunda"
      });
    }
  });

  const stores = await service.listStores();
  assert.deepEqual(stores.map((store) => store.name), [
    "fileSearchStores/uno",
    "fileSearchStores/dos"
  ]);
});

test("sube e indexa un documento dentro de un store", async () => {
  const calls = [];
  const service = new GeminiFileSearchService({
    apiKey: "clave-de-prueba",
    pollIntervalMs: 0,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith(":uploadToFileSearchStore")) {
        return jsonResponse({}, 200, {
          "x-goog-upload-url": "https://upload.test/documento"
        });
      }
      if (url === "https://upload.test/documento") {
        return jsonResponse({
          name: "operations/indexar-documento",
          done: true,
          response: {}
        });
      }
      throw new Error(`URL inesperada: ${url}`);
    }
  });

  const result = await service.uploadDocument(
    "fileSearchStores/manuales",
    {
      originalname: "manual.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF-prueba")
    }
  );

  assert.equal(result.indexado, true);
  assert.equal(result.archivo, "manual.pdf");
  assert.ok(calls.some(({ url }) => url.endsWith(":uploadToFileSearchStore")));
  assert.ok(calls.some(({ url }) => url === "https://upload.test/documento"));
});
