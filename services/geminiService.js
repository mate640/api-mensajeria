const {
  DEFAULT_GEMINI_MODELS,
  geminiModelConfigStore
} = require("./geminiModelConfigStore");

const DEFAULT_MODEL = DEFAULT_GEMINI_MODELS[0];
const FILE_SEARCH_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview"
];
const INTERACTIONS_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const CONVERSATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    estado: {
      type: "string",
      enum: ["requiere_respuesta", "completado"]
    },
    preguntas: {
      type: "array",
      items: { type: "string" }
    },
    resultado: { type: "string" },
    calidad_respuestas: {
      type: "string",
      enum: ["no_aplica", "suficientes", "parciales", "insuficientes"]
    },
    comentario_ia: { type: "string" },
    decisiones_tomadas: {
      type: "array",
      items: { type: "string" }
    },
    advertencias: {
      type: "array",
      items: { type: "string" }
    },
    requiere_revision_manual: { type: "boolean" }
  },
  required: [
    "estado",
    "preguntas",
    "resultado",
    "calidad_respuestas",
    "comentario_ia",
    "decisiones_tomadas",
    "advertencias",
    "requiere_revision_manual"
  ],
  additionalProperties: false
};

function buildConversationResponseSchema(esquemaRespuesta) {
  if (esquemaRespuesta === undefined) {
    return CONVERSATION_RESPONSE_SCHEMA;
  }

  const tipo = esquemaRespuesta?.type;
  if (typeof tipo !== "string" || !tipo.trim()) {
    throw httpError(
      "esquemaRespuesta debe declarar un type para usarlo en una conversacion",
      400,
      "ESQUEMA_INVALIDO"
    );
  }

  return {
    ...CONVERSATION_RESPONSE_SCHEMA,
    properties: {
      ...CONVERSATION_RESPONSE_SCHEMA.properties,
      resultado: {
        ...esquemaRespuesta,
        type: [...new Set([tipo.trim().toLowerCase(), "null"])]
      }
    }
  };
}

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function normalizeFormat(value) {
  const format = String(value || "texto").trim().toLowerCase();

  if (!["texto", "json"].includes(format)) {
    throw httpError(
      "formatoRespuesta debe ser texto o json",
      400,
      "FORMATO_INVALIDO"
    );
  }

  return format;
}

function validateSchema(schema) {
  if (
    schema !== undefined &&
    (schema === null || Array.isArray(schema) || typeof schema !== "object")
  ) {
    throw httpError(
      "esquemaRespuesta debe ser un objeto JSON",
      400,
      "ESQUEMA_INVALIDO"
    );
  }
}

function normalizeCatalogStoreName(value) {
  const storeName = String(value || "").trim();

  if (
    !/^fileSearchStores\/[a-zA-Z0-9_-]+$/.test(storeName)
  ) {
    throw httpError(
      "El identificador del catalogo no es valido",
      400,
      "CATALOGO_ID_INVALIDO"
    );
  }

  return storeName;
}

function normalizeFileSearchStoreNames(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) {
    throw httpError(
      "fileSearchStoreNames debe ser un array",
      400,
      "FILE_SEARCH_STORES_INVALIDOS"
    );
  }
  return [...new Set(values.map(normalizeCatalogStoreName))];
}

function normalizeModelName(value) {
  const model = String(value || "")
    .trim()
    .replace(/^models\//, "");

  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw httpError(
      "modelo no es valido",
      400,
      "MODELO_INVALIDO"
    );
  }

  return model;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const usage = { ...value };
  const total = Number(
    value.totalTokenCount ??
      value.total_tokens ??
      value.totalTokens
  );
  if (Number.isFinite(total) && total >= 0) {
    usage.totalTokenCount = Math.round(total);
  }

  return usage;
}

function isTextGenerationModel(model) {
  const name = [
    model.baseModelId,
    model.name,
    model.displayName
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const excludedVariants =
    /(embedding|imagen|image|banana|tts|speech|live|native[-_ ]?audio|audio[-_ ]?dialog|translate|computer[-_ ]?use|robotics|veo|lyria|video|omni|deep[-_ ]?research|antigravity)/;

  return (
    name.includes("gemini") &&
    !excludedVariants.test(name) &&
    model.supportedGenerationMethods?.includes("generateContent") &&
    Number(model.outputTokenLimit || 0) > 0
  );
}

function isRetryableModelError(statusCode, message) {
  const status = Number(statusCode);
  return (
    [404, 429, 500, 502, 503, 504].includes(status) ||
    /(?:quota|resource exhausted|rate.?limit|limit[^.]*exceed|high demand|temporar|overload|unavailable|model[^.]*not found|not supported)/i.test(
      String(message || "")
    )
  );
}

function isTextualInteractionFile(file) {
  const mimeType = String(
    file?.mimetype || "application/octet-stream"
  ).toLowerCase();
  const filename = String(file?.originalname || "").toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/javascript",
      "application/sql",
      "application/x-yaml"
    ].includes(mimeType) ||
    /\.(txt|csv|tsv|json|jsonl|xml|html?|md|yaml|yml|sql|log)$/i.test(
      filename
    )
  );
}

function interactionFileType(mimeType) {
  const normalized = String(mimeType || "application/octet-stream")
    .toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

function extractInteractionText(response) {
  return (response.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter(
      (content) =>
        content.type === "text" && typeof content.text === "string"
    )
    .map((content) => content.text)
    .join("");
}

function parseConversationEnvelope(text, { resultadoEstructurado = false } = {}) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let envelope;
  try {
    envelope = JSON.parse(cleaned);
  } catch {
    throw httpError(
      "Gemini no devolvio el protocolo conversacional esperado",
      502,
      "GEMINI_CHAT_RESPUESTA_INVALIDA"
    );
  }
  const questions = Array.isArray(envelope.preguntas)
    ? envelope.preguntas
        .map((question) => String(question || "").trim())
        .filter(Boolean)
    : [];
  const decisions = Array.isArray(envelope.decisiones_tomadas)
    ? envelope.decisiones_tomadas
        .map((decision) => String(decision || "").trim())
        .filter(Boolean)
    : [];
  const warnings = Array.isArray(envelope.advertencias)
    ? envelope.advertencias
        .map((warning) => String(warning || "").trim())
        .filter(Boolean)
    : [];
  const answerQuality = String(
    envelope.calidad_respuestas || "no_aplica"
  ).trim();
  const resultadoValido = resultadoEstructurado
    ? envelope.resultado === null ||
      ["object", "string", "number", "boolean"].includes(
        typeof envelope.resultado
      )
    : typeof envelope.resultado === "string";
  const resultadoCoherente = !resultadoEstructurado ||
    (envelope.estado === "requiere_respuesta"
      ? envelope.resultado === null
      : envelope.resultado !== null);
  if (
    !["requiere_respuesta", "completado"].includes(envelope.estado) ||
    !resultadoValido ||
    !resultadoCoherente ||
    ![
      "no_aplica",
      "suficientes",
      "parciales",
      "insuficientes"
    ].includes(answerQuality) ||
    typeof envelope.comentario_ia !== "string" ||
    typeof envelope.requiere_revision_manual !== "boolean" ||
    (envelope.estado === "requiere_respuesta" && !questions.length)
  ) {
    throw httpError(
      "Gemini devolvio un estado conversacional invalido",
      502,
      "GEMINI_CHAT_RESPUESTA_INVALIDA"
    );
  }
  return {
    estado: envelope.estado,
    preguntas: questions,
    resultado: envelope.resultado,
    calidadRespuestas: answerQuality,
    comentarioIa: envelope.comentario_ia.trim(),
    decisionesTomadas: decisions,
    advertencias: warnings,
    requiereRevisionManual:
      envelope.requiere_revision_manual ||
      ["parciales", "insuficientes"].includes(answerQuality) ||
      warnings.length > 0
  };
}

class GeminiService {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.modelConfigStore = options.modelConfigStore || (
      options.model
        ? { getModels: () => [normalizeModelName(options.model)] }
        : geminiModelConfigStore
    );
    this.fetchImpl = options.fetchImpl || global.fetch;
  }

  getConfiguredModels({ fileSearch = false, preferredModel } = {}) {
    const configured = [
      ...new Set(this.modelConfigStore.getModels().map(normalizeModelName))
    ];
    let candidates = fileSearch
      ? configured.filter((model) => FILE_SEARCH_MODELS.includes(model))
      : configured;
    if (!candidates.length) {
      throw httpError(
        fileSearch
          ? "No hay modelos configurados compatibles con File Search"
          : "No hay modelos de Gemini configurados",
        503,
        "GEMINI_MODELOS_NO_CONFIGURADOS"
      );
    }
    if (preferredModel) {
      const preferred = normalizeModelName(preferredModel);
      if (!configured.includes(preferred)) {
        throw httpError(
          "El modelo elegido no esta habilitado en el panel de IA",
          400,
          "GEMINI_MODELO_NO_HABILITADO"
        );
      }
      if (!candidates.includes(preferred)) {
        throw httpError(
          "El modelo elegido no es compatible con esta solicitud",
          400,
          "GEMINI_MODELO_NO_COMPATIBLE"
        );
      }
      candidates = [
        preferred,
        ...candidates.filter((model) => model !== preferred)
      ];
    }
    return candidates;
  }

  isConfigured() {
    return Boolean(String(this.apiKey).trim());
  }

  getStatus() {
    const modelos = this.getConfiguredModels();
    return {
      configurado: this.isConfigured(),
      modelo: modelos[0],
      modelosConfigurados: modelos
    };
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw httpError(
        "Gemini no esta configurado. Agrega GEMINI_API_KEY al archivo .env",
        503,
        "GEMINI_NO_CONFIGURADO"
      );
    }
  }

  async listModels() {
    this.ensureConfigured();
    const models = [];
    let pageToken;

    do {
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) {
        query.set("pageToken", pageToken);
      }

      let httpResponse;
      try {
        httpResponse = await this.fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models?${query}`,
          {
            headers: {
              "x-goog-api-key": this.apiKey
            }
          }
        );
      } catch (error) {
        const upstreamError = httpError(
          "Gemini no pudo consultar los modelos disponibles",
          502,
          "GEMINI_MODELOS_ERROR"
        );
        upstreamError.cause = error;
        throw upstreamError;
      }

      let response;
      try {
        response = JSON.parse(await httpResponse.text());
      } catch {
        throw httpError(
          "Gemini devolvio una lista de modelos invalida",
          502,
          "GEMINI_MODELOS_INVALIDOS"
        );
      }

      if (!httpResponse.ok) {
        throw httpError(
          response.error?.message ||
            "Gemini rechazo la consulta de modelos disponibles",
          502,
          "GEMINI_MODELOS_ERROR"
        );
      }

      models.push(...(response.models || []));
      pageToken = response.nextPageToken;
    } while (pageToken);

    const uniqueModels = new Map();
    for (const model of models.filter(isTextGenerationModel)) {
      const id = normalizeModelName(model.baseModelId || model.name);

      if (!uniqueModels.has(id)) {
        uniqueModels.set(id, {
          id,
          nombre: model.displayName || id,
          descripcion: model.description || "",
          tokensEntrada: model.inputTokenLimit || null,
          tokensSalida: model.outputTokenLimit || null
        });
      }
    }

    return {
      modeloPredeterminado: this.getConfiguredModels()[0],
      modelosConfigurados: this.getConfiguredModels(),
      modelos: [...uniqueModels.values()].sort((left, right) =>
        left.nombre.localeCompare(right.nombre)
      )
    };
  }

  buildContents({
    instrucciones,
    contenido,
    datos,
    archivos = [],
    catalogStoreName,
    fileSearchStoreNames = []
  }) {
    const hasFileSearch =
      Boolean(catalogStoreName) || fileSearchStoreNames.length > 0;
    const parts = [
      {
        text: [
          "Segui las instrucciones del sistema solicitante.",
          "No inventes datos que no esten presentes en el contenido recibido.",
          ...(hasFileSearch
            ? [
                "Tenes acceso a una biblioteca de documentos mediante File Search.",
                "Consulta los stores disponibles cuando las instrucciones requieran buscar informacion en ellos."
              ]
            : []),
          ...(catalogStoreName
            ? [
                "Consulta obligatoriamente ese catalogo cuando debas buscar, comparar o asociar articulos.",
                "Usa CODIGO y DESCRIPCION exactamente como aparecen en el catalogo.",
                "Si no existe una coincidencia razonable, indicalo en vez de inventar un codigo."
              ]
            : []),
          "",
          "INSTRUCCIONES:",
          instrucciones.trim()
        ].join("\n")
      }
    ];

    if (typeof contenido === "string" && contenido.trim()) {
      parts.push({
        text: [
          "CONTENIDO PROPORCIONADO POR EL SOLICITANTE:",
          contenido.trim()
        ].join("\n")
      });
    }

    if (datos !== undefined) {
      parts.push({
        text: [
          "DATOS ADICIONALES (JSON):",
          JSON.stringify(datos)
        ].join("\n")
      });
    }

    for (const archivo of archivos) {
      parts.push({
        inlineData: {
          mimeType: archivo.mimetype,
          data: archivo.buffer.toString("base64")
        }
      });
    }

    return parts;
  }

  buildConversationSystemInstruction({
    catalogStoreName,
    fileSearchStoreNames,
    formatoRespuesta,
    resultadoEstructurado = false
  }) {
    const hasFileSearch =
      Boolean(catalogStoreName) || fileSearchStoreNames.length > 0;
    return [
      "Segui las instrucciones del sistema solicitante y conserva el contexto de toda la conversacion.",
      "No inventes datos que no esten presentes en los archivos, mensajes o fuentes consultadas.",
      ...(hasFileSearch
        ? [
            "Tenes acceso a File Search. Consulta los stores configurados cuando sea necesario."
          ]
        : []),
      ...(catalogStoreName
        ? [
            "Consulta obligatoriamente el catalogo al buscar, comparar o asociar articulos.",
            "Usa CODIGO y DESCRIPCION exactamente como figuran en el catalogo."
          ]
        : []),
      "Antes de entregar la comparacion final, revisa si existe alguna ambiguedad relevante.",
      resultadoEstructurado
        ? "Si necesitas aclaraciones, responde con estado requiere_respuesta, incluye preguntas concretas y usa null en resultado."
        : "Si necesitas aclaraciones, responde con estado requiere_respuesta, incluye preguntas concretas y deja resultado vacio.",
      "Cuando ya tengas informacion suficiente, responde con estado completado, preguntas vacias y coloca la respuesta final en resultado.",
      "Evalua la calidad de las respuestas recibidas como suficientes, parciales o insuficientes; usa no_aplica si no fue necesario preguntar.",
      "En comentario_ia explica brevemente si la comparacion dependio de respuestas, supuestos o decisiones tomadas durante el chat.",
      "Registra en decisiones_tomadas las decisiones relevantes que afectaron la seleccion de articulos y en advertencias las limitaciones pendientes.",
      "Marca requiere_revision_manual cuando las respuestas sean parciales o insuficientes, existan supuestos relevantes o la comparacion no sea confiable.",
      "Si una ambiguedad critica todavia puede aclararse, pregunta antes de completar. Si el usuario indica que no dispone de mas datos, entrega la mejor comparacion posible con advertencias y revision manual.",
      formatoRespuesta === "json" && resultadoEstructurado
        ? "El campo resultado debe contener directamente el objeto JSON final que exige su esquema, no un JSON serializado como texto."
        : formatoRespuesta === "json"
          ? "El campo resultado debe contener el JSON final serializado como texto."
        : "El campo resultado debe contener el texto final solicitado.",
      "No mezcles preguntas pendientes con una comparacion presentada como definitiva."
    ].join("\n");
  }

  buildConversationInput({
    instrucciones,
    contenido,
    datos,
    archivos,
    isFollowUp
  }) {
    const input = [
      {
        type: "text",
        text: [
          isFollowUp
            ? "RESPUESTA DEL USUARIO / NUEVO TURNO:"
            : "INSTRUCCIONES DEL SOLICITANTE:",
          instrucciones.trim(),
          ...(typeof contenido === "string" && contenido.trim()
            ? [
                "",
                "CONTENIDO PROPORCIONADO POR EL SOLICITANTE:",
                contenido.trim()
              ]
            : []),
          ...(datos === undefined
            ? []
            : ["", "DATOS ADICIONALES (JSON):", JSON.stringify(datos)])
        ].join("\n")
      }
    ];
    for (const archivo of archivos || []) {
      if (isTextualInteractionFile(archivo)) {
        input.push({
          type: "text",
          text: [
            `CONTENIDO DEL ARCHIVO ${archivo.originalname || "de texto"}:`,
            archivo.buffer.toString("utf8")
          ].join("\n")
        });
        continue;
      }
      input.push({
        type: interactionFileType(archivo.mimetype),
        data: archivo.buffer.toString("base64"),
        mime_type: archivo.mimetype || "application/octet-stream"
      });
    }
    return input;
  }

  async createInteraction(request, modelCandidates) {
    let response;
    let successfulModelName;
    const attemptedModels = [];

    for (
      let candidateIndex = 0;
      candidateIndex < modelCandidates.length;
      candidateIndex += 1
    ) {
      const modelName = modelCandidates[candidateIndex];
      attemptedModels.push(modelName);
      let httpResponse;
      try {
        httpResponse = await this.fetchImpl(INTERACTIONS_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({ ...request, model: modelName })
        });
      } catch (error) {
        if (candidateIndex < modelCandidates.length - 1) continue;
        const upstreamError = httpError(
          "Gemini no pudo continuar la conversacion",
          502,
          "GEMINI_CHAT_ERROR"
        );
        upstreamError.cause = error;
        upstreamError.modelosIntentados = attemptedModels;
        throw upstreamError;
      }

      try {
        response = JSON.parse(await httpResponse.text());
      } catch {
        if (candidateIndex < modelCandidates.length - 1) continue;
        const upstreamError = httpError(
          "Gemini devolvio una interaccion invalida",
          502,
          "GEMINI_CHAT_RESPUESTA_INVALIDA"
        );
        upstreamError.modelosIntentados = attemptedModels;
        throw upstreamError;
      }
      if (httpResponse.ok) {
        successfulModelName = modelName;
        break;
      }

      const message =
        response.error?.message || "Gemini rechazo la conversacion";
      const canTryAnotherModel =
        candidateIndex < modelCandidates.length - 1 &&
        isRetryableModelError(httpResponse.status, message);
      if (canTryAnotherModel) continue;
      const upstreamError = httpError(
        message,
        httpResponse.status,
        "GEMINI_CHAT_ERROR"
      );
      upstreamError.geminiStatus = httpResponse.status;
      upstreamError.geminiResponse = response;
      upstreamError.modelosIntentados = attemptedModels;
      throw upstreamError;
    }

    if (!response?.id) {
      const upstreamError = httpError(
        "Gemini no devolvio el identificador de la conversacion",
        502,
        "GEMINI_CHAT_SIN_ID"
      );
      upstreamError.modelosIntentados = attemptedModels;
      throw upstreamError;
    }
    return { response, successfulModelName, attemptedModels };
  }

  async processConversation({
    instrucciones,
    contenido,
    datos,
    archivos = [],
    formatoRespuesta = "texto",
    esquemaRespuesta,
    catalogStoreName,
    fileSearchStoreNames = [],
    chatId,
    conversationStore
  }) {
    if (typeof instrucciones !== "string" || !instrucciones.trim()) {
      throw httpError(
        "instrucciones es obligatorio",
        400,
        "INSTRUCCIONES_REQUERIDAS"
      );
    }
    if (!conversationStore) {
      throw httpError(
        "El almacenamiento de conversaciones no esta disponible",
        503,
        "CHAT_STORE_NO_DISPONIBLE"
      );
    }
    this.ensureConfigured();

    const previousConversation = chatId
      ? conversationStore.get(chatId)
      : null;
    const format = previousConversation
      ? previousConversation.formatoRespuesta
      : normalizeFormat(formatoRespuesta);
    const responseSchema = previousConversation
      ? previousConversation.esquemaRespuesta
      : esquemaRespuesta;
    validateSchema(responseSchema);
    if (responseSchema !== undefined && format !== "json") {
      throw httpError(
        "esquemaRespuesta solo puede usarse con formatoRespuesta=json",
        400,
        "ESQUEMA_SIN_JSON"
      );
    }
    const conversationResponseSchema = buildConversationResponseSchema(
      responseSchema
    );
    const normalizedCatalogStoreName = previousConversation
      ? previousConversation.catalogStoreName
      : catalogStoreName
        ? normalizeCatalogStoreName(catalogStoreName)
        : null;
    const normalizedFileSearchStoreNames = previousConversation
      ? previousConversation.fileSearchStoreNames
      : normalizeFileSearchStoreNames(fileSearchStoreNames);
    const selectedFileSearchStoreNames = [
      ...new Set([
        ...(normalizedCatalogStoreName
          ? [normalizedCatalogStoreName]
          : []),
        ...normalizedFileSearchStoreNames
      ])
    ];
    const modelCandidates = this.getConfiguredModels({
      fileSearch: selectedFileSearchStoreNames.length > 0
    });
    const requestedModelName = modelCandidates[0];
    const request = {
      input: this.buildConversationInput({
        instrucciones,
        contenido,
        datos,
        archivos,
        isFollowUp: Boolean(previousConversation)
      }),
      store: true,
      system_instruction: this.buildConversationSystemInstruction({
        catalogStoreName: normalizedCatalogStoreName,
        fileSearchStoreNames: normalizedFileSearchStoreNames,
        formatoRespuesta: format,
        resultadoEstructurado: responseSchema !== undefined
      }),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: conversationResponseSchema
      }
    };
    if (previousConversation) {
      request.previous_interaction_id =
        previousConversation.latestInteractionId;
    }
    if (selectedFileSearchStoreNames.length) {
      request.tools = [
        {
          type: "file_search",
          file_search_store_names: selectedFileSearchStoreNames
        }
      ];
    }

    const { response, successfulModelName, attemptedModels } =
      await this.createInteraction(request, modelCandidates);
    const envelope = parseConversationEnvelope(extractInteractionText(response), {
      resultadoEstructurado: responseSchema !== undefined
    });
    const conversation = previousConversation
      ? conversationStore.advance(
          previousConversation.chatId,
          previousConversation.latestInteractionId,
          response.id,
          successfulModelName
        )
      : conversationStore.create({
          latestInteractionId: response.id,
          modelName: successfulModelName,
          requestedModelName,
          catalogStoreName: normalizedCatalogStoreName,
          fileSearchStoreNames: normalizedFileSearchStoreNames,
          formatoRespuesta: format,
          esquemaRespuesta: responseSchema
        });

    let result = envelope.resultado;
    if (envelope.estado === "requiere_respuesta") {
      result = envelope.preguntas.join("\n");
    } else if (format === "json" && responseSchema === undefined) {
      try {
        result = JSON.parse(envelope.resultado);
      } catch {
        throw httpError(
          "Gemini no devolvio un JSON final valido",
          502,
          "GEMINI_JSON_INVALIDO"
        );
      }
    }

    return {
      modelo: response.model || successfulModelName,
      modeloSolicitado: requestedModelName,
      modelosIntentados: attemptedModels,
      resultado: result,
      uso: normalizeUsage(response.usage),
      catalogoUsado: Boolean(normalizedCatalogStoreName),
      fileSearchStoresUsados: selectedFileSearchStoreNames,
      chatId: conversation.chatId,
      chatExpiraEn: conversation.expiraEn,
      requiereRespuesta: envelope.estado === "requiere_respuesta",
      estadoConversacion:
        envelope.estado === "requiere_respuesta"
          ? "esperando_respuesta"
          : "completado",
      preguntas: envelope.preguntas,
      calidadRespuestas: envelope.calidadRespuestas,
      comentarioIa: envelope.comentarioIa,
      decisionesTomadas: envelope.decisionesTomadas,
      advertencias: envelope.advertencias,
      requiereRevisionManual: envelope.requiereRevisionManual
    };
  }

  async process({
    instrucciones,
    contenido,
    datos,
    archivos = [],
    formatoRespuesta = "texto",
    esquemaRespuesta,
    catalogStoreName,
    fileSearchStoreNames = [],
    preferredModel
  }) {
    if (typeof instrucciones !== "string" || !instrucciones.trim()) {
      throw httpError(
        "instrucciones es obligatorio",
        400,
        "INSTRUCCIONES_REQUERIDAS"
      );
    }

    const format = normalizeFormat(formatoRespuesta);
    validateSchema(esquemaRespuesta);

    if (esquemaRespuesta !== undefined && format !== "json") {
      throw httpError(
        "esquemaRespuesta solo puede usarse con formatoRespuesta=json",
        400,
        "ESQUEMA_SIN_JSON"
      );
    }

    this.ensureConfigured();

    const normalizedCatalogStoreName = catalogStoreName
      ? normalizeCatalogStoreName(catalogStoreName)
      : null;
    const normalizedFileSearchStoreNames =
      normalizeFileSearchStoreNames(fileSearchStoreNames);
    const selectedFileSearchStoreNames = [
      ...new Set([
        ...(normalizedCatalogStoreName
          ? [normalizedCatalogStoreName]
          : []),
        ...normalizedFileSearchStoreNames
      ])
    ];
    const request = {
      contents: [
        {
          role: "user",
          parts: this.buildContents({
            instrucciones,
            contenido,
            datos,
            archivos,
            catalogStoreName: normalizedCatalogStoreName,
            fileSearchStoreNames: normalizedFileSearchStoreNames
          })
        }
      ]
    };

    if (selectedFileSearchStoreNames.length) {
      request.tools = [
        {
          fileSearch: {
            fileSearchStoreNames: selectedFileSearchStoreNames
          }
        }
      ];
    }

    if (format === "json") {
      request.generationConfig = {
        responseMimeType: "application/json"
      };

      if (esquemaRespuesta !== undefined) {
        request.generationConfig.responseJsonSchema = esquemaRespuesta;
      }
    }

    const modelCandidates = this.getConfiguredModels({
      fileSearch: selectedFileSearchStoreNames.length > 0,
      preferredModel
    });
    const requestedModelName = modelCandidates[0];
    let httpResponse;
    let response;
    let successfulModelName;
    const attemptedModels = [];

    for (
      let candidateIndex = 0;
      candidateIndex < modelCandidates.length;
      candidateIndex += 1
    ) {
      const modelName = modelCandidates[candidateIndex];
      attemptedModels.push(modelName);
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        `${encodeURIComponent(modelName)}:generateContent`;

      try {
        httpResponse = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify(request)
        });
      } catch (error) {
        if (candidateIndex < modelCandidates.length - 1) {
          continue;
        }

        const upstreamError = httpError(
          "Gemini no pudo procesar la solicitud",
          502,
          "GEMINI_ERROR"
        );
        upstreamError.cause = error;
        upstreamError.modelosIntentados = attemptedModels;
        throw upstreamError;
      }

      try {
        response = JSON.parse(await httpResponse.text());
      } catch {
        if (candidateIndex < modelCandidates.length - 1) continue;
        const upstreamError = httpError(
          "Gemini devolvio una respuesta que el servicio no pudo interpretar",
          502,
          "GEMINI_RESPUESTA_INVALIDA"
        );
        upstreamError.modelosIntentados = attemptedModels;
        throw upstreamError;
      }

      if (httpResponse.ok) {
        successfulModelName = modelName;
        break;
      }

      const message =
        response.error?.message || "Gemini rechazo la solicitud";
      const canTryAnotherModel =
        candidateIndex < modelCandidates.length - 1 &&
        isRetryableModelError(httpResponse.status, message);
      if (canTryAnotherModel) {
        continue;
      }

      const upstreamError = httpError(
        message,
        httpResponse.status,
        "GEMINI_ERROR"
      );
      upstreamError.geminiStatus = httpResponse.status;
      upstreamError.geminiResponse = response;
      upstreamError.modelosIntentados = attemptedModels;
      throw upstreamError;
    }

    const text = response.candidates?.[0]?.content?.parts
      ?.filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (typeof text !== "string" || !text.trim()) {
      throw httpError(
        "Gemini devolvio una respuesta vacia",
        502,
        "GEMINI_RESPUESTA_VACIA"
      );
    }

    let result = text;
    if (format === "json") {
      try {
        result = JSON.parse(text);
      } catch (error) {
        throw httpError(
          "Gemini no devolvio un JSON valido",
          502,
          "GEMINI_JSON_INVALIDO"
        );
      }
    }

    return {
      modelo: response.modelVersion || successfulModelName,
      modeloSolicitado: requestedModelName,
      modelosIntentados: attemptedModels,
      resultado: result,
      uso: normalizeUsage(response.usageMetadata),
      catalogoUsado: Boolean(normalizedCatalogStoreName),
      fileSearchStoresUsados: selectedFileSearchStoreNames
    };
  }
}

const geminiService = new GeminiService();

module.exports = {
  DEFAULT_MODEL,
  FILE_SEARCH_MODELS,
  GeminiService,
  geminiService,
  isTextGenerationModel,
  isRetryableModelError,
  normalizeCatalogStoreName,
  normalizeFileSearchStoreNames,
  normalizeModelName,
  normalizeFormat
};
