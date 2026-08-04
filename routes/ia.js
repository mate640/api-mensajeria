const crypto = require("node:crypto");
const path = require("node:path");
const { Readable } = require("node:stream");
const express = require("express");

const {
  FILE_SEARCH_MODELS,
  geminiService,
  normalizeCatalogStoreName
} = require("../services/geminiService");
const {
  geminiCatalogService
} = require("../services/geminiCatalogService");
const {
  geminiFileSearchService
} = require("../services/geminiFileSearchService");
const {
  geminiConversationStore
} = require("../services/geminiConversationStore");
const {
  geminiModelConfigStore,
  normalizeConfiguredModels
} = require("../services/geminiModelConfigStore");
const firebirdPromptsService = require("../services/firebirdPromptsService");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_REQUEST_SIZE = 50 * 1024 * 1024;
const LOCAL_PANEL_COOKIE = "ia_local_panel";
const LOCAL_PANEL_SECRET = crypto.randomBytes(32);

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseJsonField(value, fieldName) {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw httpError(
      `${fieldName} debe contener JSON valido`,
      400,
      "JSON_INVALIDO"
    );
  }
}

function parseBooleanField(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  const normalizedValue =
    typeof value === "string" ? value.trim().toLowerCase() : value;

  if (normalizedValue === true || normalizedValue === "true" || normalizedValue === "1") {
    return true;
  }

  if (normalizedValue === false || normalizedValue === "false" || normalizedValue === "0") {
    return false;
  }

  throw httpError(
    `${fieldName} debe ser verdadero o falso`,
    400,
    "BOOLEANO_INVALIDO"
  );
}

function getDefaultCatalogStoreName(catalogService) {
  if (typeof catalogService.getDefaultStoreName === "function") {
    return catalogService.getDefaultStoreName() || undefined;
  }
  const status = catalogService.getStatus();
  return status.catalogoPredeterminado || status.almacen || undefined;
}

function parseStoreNamesField(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  let names = value;
  if (typeof value === "string") {
    try {
      names = JSON.parse(value);
    } catch {
      names = [value];
    }
  }

  if (!Array.isArray(names)) {
    throw httpError(
      "fileSearchStores debe ser un array",
      400,
      "FILE_SEARCH_STORES_INVALIDOS"
    );
  }

  if (names.length > 20) {
    throw httpError(
      "Solo se pueden consultar hasta 20 File Search Stores por solicitud",
      400,
      "FILE_SEARCH_DEMASIADOS_STORES"
    );
  }

  return [...new Set(names.map(normalizeCatalogStoreName))];
}

function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    throw httpError(
      `El archivo ${file.name} supera el limite de 10 MB`,
      413,
      "ARCHIVO_DEMASIADO_GRANDE"
    );
  }
}

async function parseMultipartRequest(req) {
  const contentLength = Number(req.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_SIZE) {
    throw httpError(
      "La solicitud supera el limite de 50 MB",
      413,
      "SOLICITUD_DEMASIADO_GRANDE"
    );
  }

  const webRequest = new Request("http://localhost/ia/procesar", {
    method: "POST",
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
  const form = await webRequest.formData();
  const uploadedFiles = [
    ...form.getAll("archivo"),
    ...form.getAll("archivos"),
    ...form.getAll("catalogo")
  ].filter((value) => typeof value !== "string");

  if (uploadedFiles.length > MAX_FILES) {
    throw httpError(
      `Solo se admiten hasta ${MAX_FILES} archivos`,
      400,
      "DEMASIADOS_ARCHIVOS"
    );
  }

  const files = [];
  for (const file of uploadedFiles) {
    validateFile(file);
    files.push({
      originalname: file.name,
      mimetype: file.type || "application/octet-stream",
      size: file.size,
      buffer: Buffer.from(await file.arrayBuffer())
    });
  }

  return {
    body: {
      instrucciones: form.get("instrucciones") || undefined,
      contenido: form.get("contenido") || undefined,
      datos: form.get("datos") || undefined,
      formatoRespuesta: form.get("formatoRespuesta") || undefined,
      esquemaRespuesta: form.get("esquemaRespuesta") || undefined,
      usarCatalogo: form.get("usarCatalogo") || undefined,
      catalogoStore: form.get("catalogoStore") || undefined,
      mantenerConversacion:
        form.get("mantenerConversacion") ||
        form.get("mantener_conversacion") ||
        undefined,
      chatId:
        form.get("chatId") || form.get("chat_id") || undefined,
      respuesta: form.get("respuesta") || undefined,
      fileSearchStores: form.get("fileSearchStores") || undefined
    },
    files
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isPrivateNetworkAddress(value) {
  const address = String(value || "")
    .toLowerCase()
    .replace(/^::ffff:/, "")
    .replace(/^\[|\]$/g, "");

  if (["localhost", "127.0.0.1", "::1"].includes(address)) {
    return true;
  }

  const octets = address.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }

  return /^(fc|fd)[0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
}

function isTrustedPanelRequest(req) {
  const hostname = String(req.hostname || "").toLowerCase();
  const remoteAddress = String(req.socket?.remoteAddress || "")
    .toLowerCase()
    .replace(/^::ffff:/, "");

  return (
    isPrivateNetworkAddress(hostname) &&
    isPrivateNetworkAddress(remoteAddress)
  );
}

function localPanelToken(configuredKey) {
  return crypto
    .createHmac("sha256", LOCAL_PANEL_SECRET)
    .update(configuredKey)
    .digest("base64url");
}

function readCookie(req, name) {
  const cookies = String(req.get("cookie") || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) {
      continue;
    }

    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function setLocalPanelSession(req, res) {
  const configuredKey = String(process.env.IA_API_KEY || "").trim();
  if (!configuredKey || !isTrustedPanelRequest(req)) {
    return;
  }

  res.cookie(LOCAL_PANEL_COOKIE, localPanelToken(configuredKey), {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    path: "/ia"
  });
}

function requireServiceKey(req, res, next) {
  const configuredKey = String(process.env.IA_API_KEY || "").trim();
  if (!configuredKey) {
    return next();
  }

  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  const receivedKey = String(req.get("x-api-key") || bearer);
  const localPanelAuthorized =
    isTrustedPanelRequest(req) &&
    safeEqual(
      readCookie(req, LOCAL_PANEL_COOKIE),
      localPanelToken(configuredKey)
    );
  const authorized =
    safeEqual(configuredKey, receivedKey) || localPanelAuthorized;

  if (!authorized) {
    return next(
      httpError("No autorizado", 401, "IA_NO_AUTORIZADO")
    );
  }

  next();
}

function createIaRouter(options = {}) {
  const router = express.Router();
  const service = options.service || geminiService;
  const catalogService =
    options.catalogService || geminiCatalogService;
  const fileSearchService =
    options.fileSearchService || geminiFileSearchService;
  const conversationStore =
    options.conversationStore || geminiConversationStore;
  const promptsService =
    options.promptsService || firebirdPromptsService;
  const modelConfigStore =
    options.modelConfigStore || geminiModelConfigStore;

  router.get("/panel", (req, res) => {
    setLocalPanelSession(req, res);
    res.sendFile(path.join(__dirname, "..", "public", "ia-admin.html"));
  });

  router.get("/estado", (req, res) => {
    res.json({
      ok: true,
      ...service.getStatus(),
      limites: {
        archivos: MAX_FILES,
        bytesPorArchivo: MAX_FILE_SIZE
      }
    });
  });

  router.use(requireServiceKey);

  router.get("/catalogo", (req, res) => {
    res.json({
      ok: true,
      ...catalogService.getStatus()
    });
  });

  router.get("/modelos", async (req, res, next) => {
    try {
      const result = await service.listModels();
      res.json({
        ok: true,
        ...result,
        ...modelConfigStore.getStatus(),
        modelos: result.modelos.map((model) => ({
          ...model,
          compatibleCatalogo: FILE_SEARCH_MODELS.includes(model.id)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/modelos", async (req, res, next) => {
    try {
      const modelos = normalizeConfiguredModels(req.body?.modelos);
      const disponibles = await service.listModels();
      const idsDisponibles = new Set(
        disponibles.modelos.map((model) => model.id)
      );
      const inexistentes = modelos.filter((model) => !idsDisponibles.has(model));
      if (inexistentes.length) {
        throw httpError(
          `Estos modelos no estan disponibles para generateContent: ${inexistentes.join(", ")}`,
          400,
          "MODELOS_NO_DISPONIBLES"
        );
      }
      const configuracion = await modelConfigStore.saveModels(modelos);
      res.json({ ok: true, ...configuracion });
    } catch (error) {
      next(error);
    }
  });

  router.get("/prompts", async (req, res, next) => {
    try {
      const prompts = await promptsService.listPrompts();
      res.json({ ok: true, prompts });
    } catch (error) {
      next(error);
    }
  });

  router.post("/catalogo", async (req, res, next) => {
    try {
      if (!req.is("multipart/form-data")) {
        throw httpError(
          "El catalogo debe enviarse como archivo multipart",
          400,
          "CATALOGO_ARCHIVO_REQUERIDO"
        );
      }

      const input = await parseMultipartRequest(req);
      if (input.files.length !== 1) {
        throw httpError(
          "Debes seleccionar un unico archivo JSON de catalogo",
          400,
          "CATALOGO_ARCHIVO_REQUERIDO"
        );
      }

      const result = await catalogService.replaceCatalog(input.files[0]);
      res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/catalogo", async (req, res, next) => {
    try {
      const result = await catalogService.deleteCatalog();
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get("/catalogos", async (req, res, next) => {
    try {
      const stores = await fileSearchService.listStores();
      const catalogoPredeterminado =
        getDefaultCatalogStoreName(catalogService) || null;
      const availableNames = new Set(stores.map((store) => store.name));
      res.json({
        ok: true,
        catalogoPredeterminado,
        predeterminadoDisponible:
          Boolean(catalogoPredeterminado) &&
          availableNames.has(catalogoPredeterminado),
        catalogos: stores.map((store) => ({
          ...store,
          predeterminado: store.name === catalogoPredeterminado
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/catalogos/predeterminado", async (req, res, next) => {
    try {
      const catalogoStore = normalizeCatalogStoreName(
        req.body?.catalogoStore
      );
      const stores = await fileSearchService.listStores();
      const selectedStore = stores.find(
        (store) => store.name === catalogoStore
      );
      if (!selectedStore) {
        throw httpError(
          "El catalogo indicado no esta disponible",
          404,
          "CATALOGO_NO_DISPONIBLE"
        );
      }
      if (typeof catalogService.setDefaultStoreName !== "function") {
        throw httpError(
          "El servicio no permite configurar el catalogo predeterminado",
          501,
          "CATALOGO_CONFIGURACION_NO_DISPONIBLE"
        );
      }
      catalogService.setDefaultStoreName(catalogoStore);
      res.json({
        ok: true,
        catalogoPredeterminado: catalogoStore,
        catalogo: {
          ...selectedStore,
          predeterminado: true
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/file-search/stores", async (req, res, next) => {
    try {
      const stores = await fileSearchService.listStores();
      res.json({ ok: true, stores });
    } catch (error) {
      next(error);
    }
  });

  router.post("/file-search/stores", async (req, res, next) => {
    try {
      const store = await fileSearchService.createStore(
        req.body?.nombre,
        req.body?.modeloEmbeddings
      );
      res.status(201).json({ ok: true, store });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/file-search/stores/:storeId", async (req, res, next) => {
    try {
      const storeName = `fileSearchStores/${req.params.storeId}`;
      if (catalogService.getStatus().almacen === storeName) {
        throw httpError(
          "Este store pertenece al catalogo activo. Eliminalo desde la seccion Catalogo propio",
          409,
          "FILE_SEARCH_STORE_ES_CATALOGO"
        );
      }
      await fileSearchService.deleteStore(storeName);
      if (
        getDefaultCatalogStoreName(catalogService) === storeName &&
        typeof catalogService.setDefaultStoreName === "function"
      ) {
        catalogService.setDefaultStoreName(null);
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/file-search/stores/:storeId/documentos",
    async (req, res, next) => {
      try {
        const storeName = `fileSearchStores/${req.params.storeId}`;
        const documentos = await fileSearchService.listDocuments(storeName);
        res.json({ ok: true, store: storeName, documentos });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/file-search/stores/:storeId/documentos",
    async (req, res, next) => {
      try {
        if (!req.is("multipart/form-data")) {
          throw httpError(
            "Los documentos deben enviarse como multipart/form-data",
            400,
            "FILE_SEARCH_ARCHIVOS_REQUERIDOS"
          );
        }

        const input = await parseMultipartRequest(req);
        if (!input.files.length) {
          throw httpError(
            "Selecciona al menos un documento",
            400,
            "FILE_SEARCH_ARCHIVOS_REQUERIDOS"
          );
        }

        const storeName = `fileSearchStores/${req.params.storeId}`;
        const resultados = await fileSearchService.uploadDocuments(
          storeName,
          input.files
        );
        const documentos = await fileSearchService.listDocuments(storeName);
        res.status(201).json({
          ok: true,
          store: storeName,
          resultados,
          documentos
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/file-search/stores/:storeId/documentos/:documentId",
    async (req, res, next) => {
      try {
        const storeName = `fileSearchStores/${req.params.storeId}`;
        if (catalogService.getStatus().almacen === storeName) {
          throw httpError(
            "Los documentos del catalogo activo se administran desde la seccion Catalogo propio",
            409,
            "FILE_SEARCH_STORE_ES_CATALOGO"
          );
        }
        await fileSearchService.deleteDocument(
          `${storeName}/documents/${req.params.documentId}`
        );
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete("/chats/:chatId", (req, res, next) => {
    try {
      const eliminado = conversationStore.delete(req.params.chatId);
      res.json({ ok: true, eliminado });
    } catch (error) {
      next(error);
    }
  });

  router.post("/procesar", async (req, res, next) => {
    try {
      const input = req.is("multipart/form-data")
        ? await parseMultipartRequest(req)
        : { body: req.body || {}, files: [] };
      const body = input.body;
      const usarCatalogo = parseBooleanField(
        body.usarCatalogo,
        "usarCatalogo"
      );
      const chatId =
        String(body.chatId || body.chat_id || "").trim() || undefined;
      const mantenerConversacion =
        Boolean(chatId) ||
        parseBooleanField(
          body.mantenerConversacion ?? body.mantener_conversacion,
          "mantenerConversacion"
        );
      const requestedCatalogStoreName = body.catalogoStore
        ? normalizeCatalogStoreName(body.catalogoStore)
        : undefined;
      let catalogStoreName;
      const fileSearchStoreNames = parseStoreNamesField(
        body.fileSearchStores
      );

      if (!chatId && usarCatalogo) {
        catalogStoreName =
          requestedCatalogStoreName ||
          getDefaultCatalogStoreName(catalogService);
        const catalogStatus = catalogService.getStatus();
        if (!catalogStoreName) {
          throw httpError(
            "No hay un catalogo predeterminado y no se indico catalogoStore",
            409,
            "CATALOGO_NO_DISPONIBLE"
          );
        }
        if (
          catalogStatus.procesando &&
          catalogStatus.almacen === catalogStoreName
        ) {
          throw httpError(
            "El catalogo todavia se esta indexando",
            409,
            "CATALOGO_EN_PROCESO"
          );
        }
      }

      const processInput = {
        instrucciones: body.instrucciones || (chatId ? body.respuesta : undefined),
        contenido: body.contenido,
        datos: parseJsonField(body.datos, "datos"),
        archivos: input.files,
        formatoRespuesta: body.formatoRespuesta,
        esquemaRespuesta: parseJsonField(
          body.esquemaRespuesta,
          "esquemaRespuesta"
        ),
        catalogStoreName,
        fileSearchStoreNames
      };
      const response = mantenerConversacion
        ? await service.processConversation({
            ...processInput,
            chatId,
            conversationStore
          })
        : await service.process(processInput);

      res.json({
        ok: true,
        id: crypto.randomUUID(),
        ...response,
        ...(response.chatId ? { chat_id: response.chatId } : {})
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createIaRouter();
module.exports.createIaRouter = createIaRouter;
module.exports.parseBooleanField = parseBooleanField;
module.exports.isPrivateNetworkAddress = isPrivateNetworkAddress;
module.exports.isTrustedPanelRequest = isTrustedPanelRequest;
module.exports.parseJsonField = parseJsonField;
module.exports.parseMultipartRequest = parseMultipartRequest;
module.exports.parseStoreNamesField = parseStoreNamesField;
