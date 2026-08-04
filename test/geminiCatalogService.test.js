const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GeminiCatalogService,
  parseCatalogJson
} = require("../services/geminiCatalogService");

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

test("convierte el JSON de articulos en fichas indexables", () => {
  const parsed = parseCatalogJson(
    Buffer.from(
      JSON.stringify([
        {
          cod_art: "TRI00012",
          descripcion: "PLACA YESO KNAUF STD 12,5 MM",
          cant_vendida: 38
        },
        {
          cod_art: "TRI00013",
          descripcion: "PLACA YESO KNAUF ANTIHUMEDAD",
          cant_vendida: 12
        }
      ])
    )
  );

  assert.equal(parsed.items.length, 2);
  assert.match(parsed.textBuffer.toString("utf8"), /CODIGO: TRI00012/);
  assert.match(
    parsed.textBuffer.toString("utf8"),
    /DESCRIPCION: PLACA YESO KNAUF STD 12,5 MM/
  );
});

test("crea, carga e indexa un catalogo en Gemini", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gemini-catalog-")
  );
  const calls = [];
  const service = new GeminiCatalogService({
    apiKey: "clave-prueba",
    databaseFile: path.join(temporaryRoot, "catalog.sqlite"),
    pollIntervalMs: 0,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });

      if (
        url.endsWith("/fileSearchStores") &&
        options.method === "POST"
      ) {
        return jsonResponse({
          name: "fileSearchStores/catalogo-nuevo",
          displayName: "catalogo-nuevo"
        });
      }

      if (url.endsWith(":uploadToFileSearchStore")) {
        return jsonResponse({}, 200, {
          "x-goog-upload-url": "https://upload.test/catalog"
        });
      }

      if (url === "https://upload.test/catalog") {
        return jsonResponse({
          name: "operations/indexar-catalogo",
          done: false
        });
      }

      if (url.endsWith("/operations/indexar-catalogo")) {
        return jsonResponse({
          name: "operations/indexar-catalogo",
          done: true,
          response: {}
        });
      }

      if (
        url.endsWith("/fileSearchStores/catalogo-nuevo?force=true") &&
        options.method === "DELETE"
      ) {
        return jsonResponse({});
      }

      if (url.endsWith("/fileSearchStores/catalogo-nuevo")) {
        return jsonResponse({
          name: "fileSearchStores/catalogo-nuevo",
          displayName: "catalogo-nuevo",
          activeDocumentsCount: "1",
          embeddingModel: "models/gemini-embedding-001"
        });
      }

      throw new Error(`Solicitud inesperada: ${url}`);
    }
  });

  t.after(() => {
    service.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const result = await service.replaceCatalog({
    originalname: "articulos.json",
    buffer: Buffer.from(
      JSON.stringify([
        {
          cod_art: "TRI00012",
          descripcion: "PLACA YESO KNAUF STD 12,5 MM",
          cant_vendida: 38
        }
      ])
    )
  });

  assert.equal(result.cargado, true);
  assert.equal(result.articulos, 1);
  assert.equal(result.documentosActivos, 1);
  assert.equal(result.almacen, "fileSearchStores/catalogo-nuevo");
  assert.equal(
    service.getDefaultStoreName(),
    "fileSearchStores/catalogo-nuevo"
  );
  assert.ok(
    calls.some(({ url }) => url.endsWith(":uploadToFileSearchStore"))
  );

  const deleted = await service.deleteCatalog();
  assert.equal(deleted.cargado, false);
  assert.equal(service.getDefaultStoreName(), null);
  assert.ok(
    calls.some(
      ({ url, options }) =>
        url.includes("fileSearchStores/catalogo-nuevo?force=true") &&
        options.method === "DELETE"
    )
  );
});
