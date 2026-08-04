const { geminiService } = require("./geminiService");

const DEFAULT_ANALYST_PROMPT = `Actuá como analista de atención al cliente y ventas de Basualdo, un
corralón de materiales de construcción. Vas a recibir la bandeja de
WhatsApp de un período: primero las métricas ya calculadas por el
sistema, y después el transcript completo de las conversaciones.

FORMATO DEL TRANSCRIPT
Cada conversación empieza con una línea "## " que indica el número de
teléfono, la cantidad de mensajes recibidos y enviados, y el rango
horario. Debajo, cada mensaje ocupa una línea con formato
[fecha hora →] o [fecha hora ←]: la flecha → es un mensaje ENVIADO por
el negocio y la flecha ← es un mensaje RECIBIDO del cliente. Los textos
[Audio], [Imagen], [Documento] indican mensajes multimedia cuyo
contenido no está disponible: considerálos en el análisis (por ejemplo,
un cliente que mandó una lista en foto y no recibió respuesta).

TU TAREA
1. Tipificá cada conversación en una de estas categorías:
   presupuesto/cotización, consulta de stock o disponibilidad,
   consulta de precio, reclamo o postventa, coordinación de entrega,
   seguimiento de pedido, conversacional/otros.
2. Asigná a cada conversación un estado: cerrada (el intercambio
   concluyó), abierta esperando al negocio (la última pregunta o pedido
   del cliente quedó sin responder), abierta esperando al cliente
   (el negocio respondió y falta devolución), o sin respuesta (el
   cliente escribió y el negocio nunca contestó).
3. Marcá requiereAccion = true en toda conversación donde el negocio
   deba hacer algo: responder algo pendiente, retomar un presupuesto,
   resolver un reclamo. Explicá el motivo en una frase.
4. Detectá oportunidades perdidas: ventas que se enfriaron, respuestas
   de "no tenemos" sin ofrecer alternativa, listas o pedidos en
   multimedia que nadie procesó, demoras notorias en conversaciones
   comerciales.
5. Identificá los temas y productos más consultados del período.
6. Evaluá en un párrafo la calidad de atención del equipo: tono,
   tiempos, cierres, con ejemplos concretos.
7. Cerrá con 3 a 5 recomendaciones accionables y priorizadas.

REGLAS
- Usá las métricas provistas por el sistema como dato: no las
  recalcules ni las contradigas.
- Referenciá las conversaciones siempre por su número de teléfono tal
  como figura en el transcript. Está prohibido mencionar un número que
  no esté en el transcript.
- No inventes contenido de mensajes multimedia: razoná solo sobre su
  existencia y contexto.
- Basá cada hallazgo en evidencia del transcript. Si algo es una
  interpretación, presentala como tal.
- Todo el reporte en español rioplatense, claro y profesional.
- El resumen ejecutivo debe poder leerse solo: qué pasó en el período,
  qué está bien, qué requiere atención ya.`;

const CATEGORIES = [
  "presupuesto/cotizacion",
  "consulta de stock",
  "consulta de precio",
  "reclamo/postventa",
  "coordinacion de entrega",
  "seguimiento",
  "conversacional/otros"
];

const STATES = [
  "cerrada",
  "abierta esperando al negocio",
  "abierta esperando al cliente",
  "sin respuesta"
];

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    resumenEjecutivo: { type: "string" },
    tipificaciones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          numero: { type: "string" },
          categoria: { type: "string", enum: CATEGORIES },
          estado: { type: "string", enum: STATES },
          requiereAccion: { type: "boolean" },
          motivo: { type: "string" }
        },
        required: [
          "numero",
          "categoria",
          "estado",
          "requiereAccion",
          "motivo"
        ],
        additionalProperties: false
      }
    },
    oportunidadesPerdidas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          numero: { type: "string" },
          descripcion: { type: "string" }
        },
        required: ["numero", "descripcion"],
        additionalProperties: false
      }
    },
    temasFrecuentes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tema: { type: "string" },
          menciones: { type: "integer" }
        },
        required: ["tema", "menciones"],
        additionalProperties: false
      }
    },
    calidadAtencion: { type: "string" },
    recomendaciones: { type: "array", items: { type: "string" } }
  },
  required: [
    "resumenEjecutivo",
    "tipificaciones",
    "oportunidadesPerdidas",
    "temasFrecuentes",
    "calidadAtencion",
    "recomendaciones"
  ],
  additionalProperties: false
};

function createHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function sanitizeLine(value) {
  return String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

function getMessagePlaceholder(message) {
  const labels = {
    audioMessage: "Audio",
    imageMessage: "Imagen",
    documentMessage: "Documento",
    videoMessage: "Video",
    stickerMessage: "Sticker",
    contactMessage: "Contacto",
    locationMessage: "Ubicación",
    reactionMessage: "Reacción"
  };
  return `[${labels[message.tipo] || "Mensaje"}]`;
}

function formatTranscriptDate(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone,
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(Number(timestamp) * 1000));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return `${values.day}/${values.month} ${values.hour}:${values.minute}`;
}

function exportTranscript(report) {
  const timeZone = report.zonaHoraria || "America/Argentina/Buenos_Aires";
  const conversations = [...(report.conversaciones || [])].sort((left, right) =>
    String(left.numero).localeCompare(String(right.numero), "es", { numeric: true })
  );

  return conversations
    .map((conversation) => {
      const messages = [...(conversation.mensajes || [])].sort(
        (left, right) => left.timestamp - right.timestamp || String(left.id).localeCompare(String(right.id))
      );
      const first = messages[0];
      const last = messages[messages.length - 1];
      const range = first && last
        ? `${formatTranscriptDate(first.timestamp, timeZone)} a ${formatTranscriptDate(last.timestamp, timeZone)}`
        : "sin mensajes";
      const header = `## ${conversation.numero} | ${conversation.recibidos} recibidos, ${conversation.enviados} enviados | ${range}`;
      const lines = messages.map((message) => {
        const arrow = message.direccion === "enviado" ? "→" : "←";
        const isMultimedia = [
          "audioMessage",
          "imageMessage",
          "documentMessage",
          "videoMessage",
          "stickerMessage"
        ].includes(message.tipo);
        const content = isMultimedia
          ? getMessagePlaceholder(message)
          : sanitizeLine(message.texto) || getMessagePlaceholder(message);
        return `[${formatTranscriptDate(message.timestamp, timeZone)} ${arrow}] ${content}`;
      });
      return [header, ...lines].join("\n");
    })
    .join("\n\n");
}

function formatDateDDMMYYYY(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
}

function buildAnalysisContent(report, transcript) {
  const metrics = report.estadisticas || {};
  const average = metrics.tiempoPromedioRespuestaSegundos;
  const averageText = average === null || average === undefined
    ? "Sin datos"
    : `${average} segundos`;
  return [
    "MÉTRICAS CALCULADAS POR EL SISTEMA",
    `Rango de fechas: ${formatDateDDMMYYYY(report.desde)} al ${formatDateDDMMYYYY(report.hasta)}`,
    `Mensajes recibidos: ${metrics.mensajesRecibidos ?? 0}`,
    `Mensajes enviados: ${metrics.mensajesEnviados ?? 0}`,
    `Promedio de respuesta: ${averageText}`,
    `Conversaciones: ${metrics.conversaciones ?? 0}`,
    "",
    "TRANSCRIPT COMPLETO",
    transcript
  ].join("\n");
}

function assertExactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} debe ser un objeto`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${path} contiene campos faltantes o no permitidos`);
  }
}

function requireString(value, path) {
  if (typeof value !== "string") throw new Error(`${path} debe ser texto`);
}

function validateAnalysisResult(result) {
  const rootKeys = [
    "resumenEjecutivo", "tipificaciones", "oportunidadesPerdidas",
    "temasFrecuentes", "calidadAtencion", "recomendaciones"
  ];
  assertExactKeys(result, rootKeys, "respuesta");
  requireString(result.resumenEjecutivo, "resumenEjecutivo");
  requireString(result.calidadAtencion, "calidadAtencion");

  for (const field of ["tipificaciones", "oportunidadesPerdidas", "temasFrecuentes", "recomendaciones"]) {
    if (!Array.isArray(result[field])) throw new Error(`${field} debe ser un array`);
  }

  result.tipificaciones.forEach((item, index) => {
    const path = `tipificaciones[${index}]`;
    assertExactKeys(item, ["numero", "categoria", "estado", "requiereAccion", "motivo"], path);
    requireString(item.numero, `${path}.numero`);
    requireString(item.categoria, `${path}.categoria`);
    requireString(item.estado, `${path}.estado`);
    requireString(item.motivo, `${path}.motivo`);
    if (!CATEGORIES.includes(item.categoria)) throw new Error(`${path}.categoria no es válida`);
    if (!STATES.includes(item.estado)) throw new Error(`${path}.estado no es válido`);
    if (typeof item.requiereAccion !== "boolean") throw new Error(`${path}.requiereAccion debe ser booleano`);
  });

  result.oportunidadesPerdidas.forEach((item, index) => {
    const path = `oportunidadesPerdidas[${index}]`;
    assertExactKeys(item, ["numero", "descripcion"], path);
    requireString(item.numero, `${path}.numero`);
    requireString(item.descripcion, `${path}.descripcion`);
  });

  result.temasFrecuentes.forEach((item, index) => {
    const path = `temasFrecuentes[${index}]`;
    assertExactKeys(item, ["tema", "menciones"], path);
    requireString(item.tema, `${path}.tema`);
    if (!Number.isInteger(item.menciones)) throw new Error(`${path}.menciones debe ser entero`);
  });
  result.recomendaciones.forEach((item, index) => requireString(item, `recomendaciones[${index}]`));
  return result;
}

function filterUnknownNumbers(result, validNumbers) {
  const valid = new Set(validNumbers.map(String));
  const seen = new Set();
  return {
    ...result,
    tipificaciones: result.tipificaciones
      .filter((item) => valid.has(item.numero) && !seen.has(item.numero) && seen.add(item.numero))
      .sort((left, right) => Number(right.requiereAccion) - Number(left.requiereAccion)),
    oportunidadesPerdidas: result.oportunidadesPerdidas.filter((item) => valid.has(item.numero))
  };
}

class WhatsAppInboxAnalysisService {
  constructor(options = {}) {
    this.aiService = options.aiService || geminiService;
  }

  async listModels() {
    const result = await this.aiService.listModels();
    const configured = Array.isArray(result.modelosConfigurados)
      ? result.modelosConfigurados
      : this.aiService.getStatus().modelosConfigurados || [];
    const modelsById = new Map((result.modelos || []).map((model) => [model.id, model]));
    const enabledModels = configured.map((id) => modelsById.get(id)).filter(Boolean);
    return {
      ...result,
      modeloPredeterminado: enabledModels[0]?.id || null,
      modelosConfigurados: enabledModels.map((model) => model.id),
      modelos: enabledModels
    };
  }

  async analyze(report, { model, prompt = DEFAULT_ANALYST_PROMPT } = {}) {
    if (!(report.conversaciones || []).length) {
      throw createHttpError("No hay conversaciones para analizar en el período elegido", 400, "BANDEJA_SIN_MENSAJES");
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw createHttpError("El prompt del analista no puede estar vacío", 400, "PROMPT_VACIO");
    }

    const transcript = exportTranscript(report);
    let response;
    try {
      response = await this.aiService.process({
        instrucciones: prompt.trim(),
        contenido: buildAnalysisContent(report, transcript),
        formatoRespuesta: "json",
        esquemaRespuesta: ANALYSIS_SCHEMA,
        preferredModel: model
      });
    } catch (error) {
      if (error.isOperational) throw error;
      throw createHttpError(`No se pudo analizar la bandeja: ${error.message}`, 502, "ANALISIS_IA_FALLIDO");
    }

    let validated;
    try {
      validated = validateAnalysisResult(response.resultado);
    } catch (error) {
      throw createHttpError(`La IA devolvió un JSON inválido: ${error.message}`, 502, "RESPUESTA_IA_INVALIDA");
    }

    const result = filterUnknownNumbers(
      validated,
      report.conversaciones.map((conversation) => conversation.numero)
    );
    return {
      instancia: report.instancia,
      desde: report.desde,
      hasta: report.hasta,
      generadoEn: new Date().toISOString(),
      modelo: response.modelo || model || null,
      ...result
    };
  }
}

const whatsappInboxAnalysisService = new WhatsAppInboxAnalysisService();

module.exports = {
  ANALYSIS_SCHEMA,
  CATEGORIES,
  DEFAULT_ANALYST_PROMPT,
  STATES,
  WhatsAppInboxAnalysisService,
  buildAnalysisContent,
  exportTranscript,
  filterUnknownNumbers,
  validateAnalysisResult,
  whatsappInboxAnalysisService
};
