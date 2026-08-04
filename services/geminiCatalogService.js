const crypto = require("node:crypto");
const path = require("node:path");
const Database = require("better-sqlite3");

const { delay } = require("../utils/delay");

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE =
  "https://generativelanguage.googleapis.com/upload/v1beta";

function catalogError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function cleanField(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
}

function parseCatalogJson(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw catalogError(
      "El catalogo debe contener un JSON valido",
      400,
      "CATALOGO_JSON_INVALIDO"
    );
  }

  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.articulos)
      ? parsed.articulos
      : null;

  if (!source) {
    throw catalogError(
      "El catalogo debe ser un array de articulos",
      400,
      "CATALOGO_ESTRUCTURA_INVALIDA"
    );
  }

  const byCode = new Map();
  let discarded = 0;
  let duplicates = 0;

  for (const item of source) {
    const code = cleanField(
      item?.cod_art ?? item?.codigo ?? item?.code
    );
    const description = cleanField(
      item?.descripcion ?? item?.description
    );

    if (!code || !description) {
      discarded += 1;
      continue;
    }

    if (byCode.has(code)) {
      duplicates += 1;
    }

    byCode.set(code, {
      codigo: code,
      descripcion: description,
      cantidadVendida:
        Number.isFinite(Number(item?.cant_vendida))
          ? Number(item.cant_vendida)
          : null
    });
  }

  const items = [...byCode.values()];
  if (!items.length) {
    throw catalogError(
      "El catalogo no contiene articulos con codigo y descripcion",
      400,
      "CATALOGO_SIN_ARTICULOS"
    );
  }

  const text = [
    "CATALOGO PROPIO DE ARTICULOS",
    "Cada bloque ARTICULO representa un producto independiente.",
    "Usar CODIGO y DESCRIPCION exactamente como aparecen.",
    "",
    ...items.flatMap((item) => [
      "ARTICULO",
      `CODIGO: ${item.codigo}`,
      `DESCRIPCION: ${item.descripcion}`,
      ...(item.cantidadVendida === null
        ? []
        : [`CANTIDAD_VENDIDA_HISTORICA: ${item.cantidadVendida}`]),
      ""
    ])
  ].join("\n");

  return {
    items,
    textBuffer: Buffer.from(text, "utf8"),
    discarded,
    duplicates
  };
}

class GeminiCatalogService {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.databaseFile =
      options.databaseFile ||
      path.join(__dirname, "..", "data", "gemini-catalog.sqlite");
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.maxPollAttempts = options.maxPollAttempts ?? 150;
    this.activeUpload = null;

    this.database = new Database(this.databaseFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gemini_catalog (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        store_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_size_bytes INTEGER NOT NULL,
        indexed_size_bytes INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        discarded_count INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL,
        active_documents INTEGER,
        embedding_model TEXT,
        uploaded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gemini_catalog_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_store_name TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.selectCatalog = this.database.prepare(`
      SELECT * FROM gemini_catalog WHERE id = 1
    `);
    this.deleteCatalogRecord = this.database.prepare(`
      DELETE FROM gemini_catalog WHERE id = 1
    `);
    this.saveCatalog = this.database.prepare(`
      INSERT INTO gemini_catalog (
        id,
        store_name,
        display_name,
        source_filename,
        source_sha256,
        source_size_bytes,
        indexed_size_bytes,
        item_count,
        discarded_count,
        duplicate_count,
        active_documents,
        embedding_model,
        uploaded_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        store_name = excluded.store_name,
        display_name = excluded.display_name,
        source_filename = excluded.source_filename,
        source_sha256 = excluded.source_sha256,
        source_size_bytes = excluded.source_size_bytes,
        indexed_size_bytes = excluded.indexed_size_bytes,
        item_count = excluded.item_count,
        discarded_count = excluded.discarded_count,
        duplicate_count = excluded.duplicate_count,
        active_documents = excluded.active_documents,
        embedding_model = excluded.embedding_model,
        uploaded_at = excluded.uploaded_at
    `);
    this.selectCatalogSettings = this.database.prepare(`
      SELECT * FROM gemini_catalog_settings WHERE id = 1
    `);
    this.saveDefaultCatalog = this.database.prepare(`
      INSERT INTO gemini_catalog_settings (
        id,
        default_store_name,
        updated_at
      ) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        default_store_name = excluded.default_store_name,
        updated_at = excluded.updated_at
    `);
  }

  ensureConfigured() {
    if (!String(this.apiKey).trim()) {
      throw catalogError(
        "Gemini no esta configurado. Agrega GEMINI_API_KEY al archivo .env",
        503,
        "GEMINI_NO_CONFIGURADO"
      );
    }
  }

  getStatus() {
    const row = this.selectCatalog.get();
    const defaultStoreName = this.getDefaultStoreName();

    if (!row) {
      return {
        configurado: Boolean(String(this.apiKey).trim()),
        cargado: false,
        procesando: Boolean(this.activeUpload),
        catalogoPredeterminado: defaultStoreName
      };
    }

    return {
      configurado: Boolean(String(this.apiKey).trim()),
      cargado: true,
      procesando: Boolean(this.activeUpload),
      almacen: row.store_name,
      nombre: row.display_name,
      archivo: row.source_filename,
      sha256: row.source_sha256,
      bytesOriginales: row.source_size_bytes,
      bytesIndexados: row.indexed_size_bytes,
      articulos: row.item_count,
      descartados: row.discarded_count,
      duplicados: row.duplicate_count,
      documentosActivos: row.active_documents,
      modeloEmbeddings: row.embedding_model,
      cargadoEn: row.uploaded_at,
      catalogoPredeterminado: defaultStoreName
    };
  }

  getDefaultStoreName() {
    const settings = this.selectCatalogSettings.get();
    if (settings) {
      return settings.default_store_name || null;
    }
    return this.selectCatalog.get()?.store_name || null;
  }

  setDefaultStoreName(storeName) {
    const normalizedStoreName = storeName || null;
    this.saveDefaultCatalog.run(
      normalizedStoreName,
      new Date().toISOString()
    );
    return this.getDefaultStoreName();
  }

  async fetchWithRetry(url, options = {}) {
    let lastResponse;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        lastResponse = await this.fetchImpl(url, options);
      } catch (error) {
        if (attempt === 3) throw error;
        await delay(500 * 2 ** attempt);
        continue;
      }

      if (
        ![429, 500, 502, 503, 504].includes(lastResponse.status) ||
        attempt === 3
      ) {
        return lastResponse;
      }

      await delay(500 * 2 ** attempt);
    }

    return lastResponse;
  }

  async readJsonResponse(response, fallbackMessage, code) {
    let body;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw catalogError(
        `${fallbackMessage}: respuesta invalida`,
        502,
        code
      );
    }

    if (!response.ok) {
      throw catalogError(
        body.error?.message || fallbackMessage,
        502,
        code
      );
    }

    return body;
  }

  async createStore(displayName) {
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/fileSearchStores`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey
        },
        body: JSON.stringify({
          displayName,
          embeddingModel: "models/gemini-embedding-001"
        })
      }
    );

    return this.readJsonResponse(
      response,
      "No se pudo crear el catalogo en Gemini",
      "CATALOGO_CREACION_ERROR"
    );
  }

  async uploadToStore(storeName, buffer, displayName, itemCount) {
    const mimeType = "text/plain";
    const startResponse = await this.fetchWithRetry(
      `${GEMINI_UPLOAD_BASE}/${storeName}:uploadToFileSearchStore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(buffer.length),
          "X-Goog-Upload-Header-Content-Type": mimeType
        },
        body: JSON.stringify({
          displayName,
          customMetadata: [
            {
              key: "tipo",
              stringValue: "catalogo_articulos"
            },
            {
              key: "cantidad_articulos",
              numericValue: itemCount
            }
          ],
          chunkingConfig: {
            whiteSpaceConfig: {
              maxTokensPerChunk: 200,
              maxOverlapTokens: 20
            }
          }
        })
      }
    );

    if (!startResponse.ok) {
      await this.readJsonResponse(
        startResponse,
        "No se pudo iniciar la carga del catalogo",
        "CATALOGO_CARGA_ERROR"
      );
    }

    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw catalogError(
        "Gemini no devolvio la URL para cargar el catalogo",
        502,
        "CATALOGO_CARGA_SIN_URL"
      );
    }

    const uploadResponse = await this.fetchWithRetry(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(buffer.length),
        "Content-Type": mimeType,
        "x-goog-api-key": this.apiKey,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: buffer
    });

    return this.readJsonResponse(
      uploadResponse,
      "No se pudo cargar el catalogo en Gemini",
      "CATALOGO_CARGA_ERROR"
    );
  }

  async waitForOperation(initialOperation) {
    let operation = initialOperation;

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      if (operation.done) {
        if (operation.error) {
          throw catalogError(
            operation.error.message || "Gemini no pudo indexar el catalogo",
            502,
            "CATALOGO_INDEXACION_ERROR"
          );
        }
        return operation;
      }

      await delay(this.pollIntervalMs);
      const response = await this.fetchWithRetry(
        `${GEMINI_API_BASE}/${operation.name}`,
        {
          headers: {
            "x-goog-api-key": this.apiKey
          }
        }
      );
      operation = await this.readJsonResponse(
        response,
        "No se pudo consultar la indexacion del catalogo",
        "CATALOGO_OPERACION_ERROR"
      );
    }

    throw catalogError(
      "Gemini demoro demasiado en indexar el catalogo",
      504,
      "CATALOGO_INDEXACION_TIMEOUT"
    );
  }

  async getRemoteStore(storeName) {
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/${storeName}`,
      {
        headers: {
          "x-goog-api-key": this.apiKey
        }
      }
    );
    return this.readJsonResponse(
      response,
      "No se pudo consultar el catalogo de Gemini",
      "CATALOGO_ESTADO_ERROR"
    );
  }

  async deleteRemoteStore(storeName) {
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/${storeName}?force=true`,
      {
        method: "DELETE",
        headers: {
          "x-goog-api-key": this.apiKey
        }
      }
    );

    if (!response.ok) {
      await this.readJsonResponse(
        response,
        "No se pudo eliminar el catalogo anterior",
        "CATALOGO_ELIMINACION_ERROR"
      );
    }
  }

  async replaceCatalog(file) {
    this.ensureConfigured();

    if (this.activeUpload) {
      throw catalogError(
        "Ya hay un catalogo en proceso de carga",
        409,
        "CATALOGO_EN_PROCESO"
      );
    }

    this.activeUpload = this.performReplacement(file);
    try {
      return await this.activeUpload;
    } finally {
      this.activeUpload = null;
    }
  }

  async deleteCatalog() {
    this.ensureConfigured();
    if (this.activeUpload) {
      throw catalogError(
        "No se puede eliminar el catalogo mientras se esta indexando",
        409,
        "CATALOGO_EN_PROCESO"
      );
    }

    const current = this.selectCatalog.get();
    if (!current) {
      return this.getStatus();
    }

    const wasDefault = this.getDefaultStoreName() === current.store_name;
    await this.deleteRemoteStore(current.store_name);
    this.deleteCatalogRecord.run();
    if (wasDefault) {
      this.setDefaultStoreName(null);
    }
    return this.getStatus();
  }

  async performReplacement(file) {
    const parsed = parseCatalogJson(file.buffer);
    const previous = this.selectCatalog.get();
    const previousDefaultStoreName = this.getDefaultStoreName();
    const shouldFollowManagedCatalog =
      !previousDefaultStoreName ||
      previousDefaultStoreName === previous?.store_name;
    const timestamp = new Date().toISOString();
    const displayName = `catalogo-articulos-${Date.now()}`;
    const sourceHash = crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex");
    let newStore;

    try {
      newStore = await this.createStore(displayName);
      const operation = await this.uploadToStore(
        newStore.name,
        parsed.textBuffer,
        `${displayName}.txt`,
        parsed.items.length
      );
      await this.waitForOperation(operation);
      const remoteStore = await this.getRemoteStore(newStore.name);

      this.saveCatalog.run(
        remoteStore.name,
        remoteStore.displayName || displayName,
        file.originalname || "articulos.json",
        sourceHash,
        file.buffer.length,
        parsed.textBuffer.length,
        parsed.items.length,
        parsed.discarded,
        parsed.duplicates,
        Number(remoteStore.activeDocumentsCount || 0),
        remoteStore.embeddingModel || null,
        timestamp
      );
      if (shouldFollowManagedCatalog) {
        this.setDefaultStoreName(remoteStore.name);
      }
    } catch (error) {
      if (newStore?.name) {
        await this.deleteRemoteStore(newStore.name).catch(() => {});
      }
      throw error;
    }

    let warning = null;
    if (previous?.store_name && previous.store_name !== newStore.name) {
      try {
        await this.deleteRemoteStore(previous.store_name);
      } catch (error) {
        warning =
          `El catalogo nuevo quedo activo, pero no se pudo eliminar el anterior: ` +
          error.message;
      }
    }

    return {
      ...this.getStatus(),
      advertencia: warning
    };
  }

  close() {
    this.database.close();
  }
}

const geminiCatalogService = new GeminiCatalogService();

module.exports = {
  GeminiCatalogService,
  geminiCatalogService,
  parseCatalogJson
};
