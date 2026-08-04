const { delay } = require("../utils/delay");

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE =
  "https://generativelanguage.googleapis.com/upload/v1beta";
const DEFAULT_EMBEDDING_MODEL = "models/gemini-embedding-001";

function fileSearchError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function normalizeResourceName(value, resource) {
  const name = String(value || "").trim();
  const patterns = {
    store: /^fileSearchStores\/[a-zA-Z0-9_-]+$/,
    document:
      /^fileSearchStores\/[a-zA-Z0-9_-]+\/documents\/[a-zA-Z0-9_-]+$/
  };

  if (!patterns[resource]?.test(name)) {
    throw fileSearchError(
      `El identificador de ${resource === "store" ? "store" : "documento"} no es valido`,
      400,
      "FILE_SEARCH_ID_INVALIDO"
    );
  }

  return name;
}

function normalizeDisplayName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) {
    throw fileSearchError(
      "El nombre del store es obligatorio",
      400,
      "FILE_SEARCH_NOMBRE_REQUERIDO"
    );
  }
  if (name.length > 128) {
    throw fileSearchError(
      "El nombre del store no puede superar 128 caracteres",
      400,
      "FILE_SEARCH_NOMBRE_INVALIDO"
    );
  }
  return name;
}

class GeminiFileSearchService {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.maxPollAttempts = options.maxPollAttempts ?? 150;
  }

  ensureConfigured() {
    if (!String(this.apiKey).trim()) {
      throw fileSearchError(
        "Gemini no esta configurado. Agrega GEMINI_API_KEY al archivo .env",
        503,
        "GEMINI_NO_CONFIGURADO"
      );
    }
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
      const text = await response.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      throw fileSearchError(
        `${fallbackMessage}: respuesta invalida`,
        502,
        code
      );
    }

    if (!response.ok) {
      throw fileSearchError(
        body.error?.message || fallbackMessage,
        502,
        code
      );
    }

    return body;
  }

  async listPaginated(url, resultField, fallbackMessage, code) {
    const results = [];
    let pageToken;

    do {
      const query = new URLSearchParams({ pageSize: "20" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.fetchWithRetry(`${url}?${query}`, {
        headers: { "x-goog-api-key": this.apiKey }
      });
      const body = await this.readJsonResponse(
        response,
        fallbackMessage,
        code
      );
      results.push(...(body[resultField] || []));
      pageToken = body.nextPageToken;
    } while (pageToken);

    return results;
  }

  async listStores() {
    this.ensureConfigured();
    return this.listPaginated(
      `${GEMINI_API_BASE}/fileSearchStores`,
      "fileSearchStores",
      "No se pudieron consultar los File Search Stores",
      "FILE_SEARCH_LISTA_ERROR"
    );
  }

  async createStore(displayName, embeddingModel = DEFAULT_EMBEDDING_MODEL) {
    this.ensureConfigured();
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/fileSearchStores`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey
        },
        body: JSON.stringify({
          displayName: normalizeDisplayName(displayName),
          embeddingModel
        })
      }
    );
    return this.readJsonResponse(
      response,
      "No se pudo crear el File Search Store",
      "FILE_SEARCH_CREACION_ERROR"
    );
  }

  async listDocuments(storeName) {
    this.ensureConfigured();
    const normalizedStore = normalizeResourceName(storeName, "store");
    return this.listPaginated(
      `${GEMINI_API_BASE}/${normalizedStore}/documents`,
      "documents",
      "No se pudieron consultar los documentos del store",
      "FILE_SEARCH_DOCUMENTOS_ERROR"
    );
  }

  async waitForOperation(initialOperation) {
    let operation = initialOperation;

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      if (operation.done) {
        if (operation.error) {
          throw fileSearchError(
            operation.error.message || "Gemini no pudo indexar el archivo",
            502,
            "FILE_SEARCH_INDEXACION_ERROR"
          );
        }
        return operation;
      }

      await delay(this.pollIntervalMs);
      const response = await this.fetchWithRetry(
        `${GEMINI_API_BASE}/${operation.name}`,
        { headers: { "x-goog-api-key": this.apiKey } }
      );
      operation = await this.readJsonResponse(
        response,
        "No se pudo consultar la indexacion",
        "FILE_SEARCH_OPERACION_ERROR"
      );
    }

    throw fileSearchError(
      "Gemini demoro demasiado en indexar el archivo",
      504,
      "FILE_SEARCH_INDEXACION_TIMEOUT"
    );
  }

  async uploadDocument(storeName, file) {
    this.ensureConfigured();
    const normalizedStore = normalizeResourceName(storeName, "store");
    if (!file?.buffer?.length) {
      throw fileSearchError(
        "El archivo esta vacio",
        400,
        "FILE_SEARCH_ARCHIVO_VACIO"
      );
    }

    const mimeType = file.mimetype || "application/octet-stream";
    const displayName = String(file.originalname || "documento").slice(0, 128);
    const startResponse = await this.fetchWithRetry(
      `${GEMINI_UPLOAD_BASE}/${normalizedStore}:uploadToFileSearchStore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(file.buffer.length),
          "X-Goog-Upload-Header-Content-Type": mimeType
        },
        body: JSON.stringify({ displayName })
      }
    );

    if (!startResponse.ok) {
      await this.readJsonResponse(
        startResponse,
        "No se pudo iniciar la carga del archivo",
        "FILE_SEARCH_CARGA_ERROR"
      );
    }

    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw fileSearchError(
        "Gemini no devolvio la URL de carga",
        502,
        "FILE_SEARCH_CARGA_SIN_URL"
      );
    }

    const uploadResponse = await this.fetchWithRetry(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(file.buffer.length),
        "Content-Type": mimeType,
        "x-goog-api-key": this.apiKey,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: file.buffer
    });
    const operation = await this.readJsonResponse(
      uploadResponse,
      "No se pudo cargar el archivo",
      "FILE_SEARCH_CARGA_ERROR"
    );
    await this.waitForOperation(operation);
    return { archivo: displayName, indexado: true };
  }

  async uploadDocuments(storeName, files) {
    const results = [];
    for (const file of files) {
      results.push(await this.uploadDocument(storeName, file));
    }
    return results;
  }

  async deleteDocument(documentName) {
    this.ensureConfigured();
    const normalizedDocument = normalizeResourceName(
      documentName,
      "document"
    );
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/${normalizedDocument}?force=true`,
      {
        method: "DELETE",
        headers: { "x-goog-api-key": this.apiKey }
      }
    );
    return this.readJsonResponse(
      response,
      "No se pudo eliminar el documento",
      "FILE_SEARCH_DOCUMENTO_ELIMINACION_ERROR"
    );
  }

  async deleteStore(storeName) {
    this.ensureConfigured();
    const normalizedStore = normalizeResourceName(storeName, "store");
    const response = await this.fetchWithRetry(
      `${GEMINI_API_BASE}/${normalizedStore}?force=true`,
      {
        method: "DELETE",
        headers: { "x-goog-api-key": this.apiKey }
      }
    );
    return this.readJsonResponse(
      response,
      "No se pudo eliminar el File Search Store",
      "FILE_SEARCH_ELIMINACION_ERROR"
    );
  }
}

const geminiFileSearchService = new GeminiFileSearchService();

module.exports = {
  DEFAULT_EMBEDDING_MODEL,
  GeminiFileSearchService,
  geminiFileSearchService,
  normalizeDisplayName,
  normalizeResourceName
};
