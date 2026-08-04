const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ANALYSIS_SCHEMA,
  WhatsAppInboxAnalysisService,
  exportTranscript,
  validateAnalysisResult
} = require("../services/whatsappInboxAnalysisService");

function message(id, direction, timestamp, text, type = "conversation") {
  return {
    id,
    direccion: direction,
    timestamp,
    fecha: new Date(timestamp * 1000).toISOString(),
    texto: text,
    tipo: type
  };
}

function report() {
  return {
    instancia: "VENTAS",
    desde: "2026-07-30",
    hasta: "2026-07-31",
    zonaHoraria: "America/Argentina/Buenos_Aires",
    estadisticas: {
      mensajesRecibidos: 2,
      mensajesEnviados: 1,
      tiempoPromedioRespuestaSegundos: 300,
      conversaciones: 2
    },
    conversaciones: [
      {
        chat: "222@s.whatsapp.net",
        numero: "222",
        recibidos: 1,
        enviados: 0,
        mensajes: [message("2", "recibido", 1785421400, null, "imageMessage")]
      },
      {
        chat: "111@s.whatsapp.net",
        numero: "111",
        recibidos: 1,
        enviados: 1,
        mensajes: [
          message("1", "recibido", 1785421200, "Hola\nNecesito precio"),
          message("3", "enviado", 1785421500, "Buen día")
        ]
      }
    ]
  };
}

function validResult() {
  return {
    resumenEjecutivo: "Resumen",
    tipificaciones: [
      {
        numero: "111",
        categoria: "consulta de precio",
        estado: "abierta esperando al cliente",
        requiereAccion: false,
        motivo: "Se respondió la consulta."
      },
      {
        numero: "222",
        categoria: "presupuesto/cotizacion",
        estado: "sin respuesta",
        requiereAccion: true,
        motivo: "La imagen quedó sin respuesta."
      }
    ],
    oportunidadesPerdidas: [
      { numero: "222", descripcion: "Lista en imagen sin procesar." }
    ],
    temasFrecuentes: [{ tema: "precios", menciones: 1 }],
    calidadAtencion: "Hay consultas pendientes.",
    recomendaciones: ["Responder las listas pendientes."]
  };
}

test("exporta el transcript ordenado por numero y sanitiza saltos", () => {
  const transcript = exportTranscript(report());
  const blocks = transcript.split("\n\n");

  assert.match(blocks[0], /^## 111 \| 1 recibidos, 1 enviados \|/);
  assert.match(blocks[0], /\[30\/7 \d{2}:\d{2} ←\] Hola Necesito precio/);
  assert.match(blocks[0], /→\] Buen día/);
  assert.match(blocks[1], /^## 222 /);
  assert.match(blocks[1], /←\] \[Imagen\]/);
});

test("envia metricas y transcript en una unica llamada con el esquema exacto", async () => {
  let payload;
  const service = new WhatsAppInboxAnalysisService({
    aiService: {
      process: async (input) => {
        payload = input;
        return { modelo: "gemini-test", resultado: validResult() };
      }
    }
  });

  const result = await service.analyze(report(), {
    model: "gemini-test",
    prompt: "Prompt editable"
  });

  assert.equal(payload.instrucciones, "Prompt editable");
  assert.equal(payload.formatoRespuesta, "json");
  assert.equal(payload.esquemaRespuesta, ANALYSIS_SCHEMA);
  assert.equal(payload.preferredModel, "gemini-test");
  assert.match(payload.contenido, /Rango de fechas: 30\/07\/2026 al 31\/07\/2026/);
  assert.match(payload.contenido, /Mensajes recibidos: 2/);
  assert.match(payload.contenido, /TRANSCRIPT COMPLETO/);
  assert.equal(result.tipificaciones[0].numero, "222");
  assert.equal(result.tipificaciones[0].requiereAccion, true);
});

test("descarta tipificaciones y oportunidades con numeros inexistentes", async () => {
  const invalidNumberResult = validResult();
  invalidNumberResult.tipificaciones.push({
    numero: "999",
    categoria: "seguimiento",
    estado: "cerrada",
    requiereAccion: false,
    motivo: "Inventada"
  });
  invalidNumberResult.oportunidadesPerdidas.push({
    numero: "999",
    descripcion: "Inventada"
  });
  const service = new WhatsAppInboxAnalysisService({
    aiService: {
      process: async () => ({ modelo: "gemini-test", resultado: invalidNumberResult })
    }
  });

  const result = await service.analyze(report(), { prompt: "Prompt" });

  assert.deepEqual(result.tipificaciones.map((item) => item.numero), ["222", "111"]);
  assert.deepEqual(result.oportunidadesPerdidas.map((item) => item.numero), ["222"]);
});

test("rechaza respuestas que no validan contra el esquema", async () => {
  const broken = validResult();
  broken.tipificaciones[0].categoria = "categoria inventada";
  assert.throws(() => validateAnalysisResult(broken), /categoria no es válida/);

  const service = new WhatsAppInboxAnalysisService({
    aiService: {
      process: async () => ({ modelo: "gemini-test", resultado: broken })
    }
  });
  await assert.rejects(
    service.analyze(report(), { prompt: "Prompt" }),
    (error) => error.statusCode === 502 && error.code === "RESPUESTA_IA_INVALIDA"
  );
});

test("lista para WhatsApp solo los modelos habilitados y en su prioridad", async () => {
  const service = new WhatsAppInboxAnalysisService({
    aiService: {
      listModels: async () => ({
        modelosConfigurados: ["gemini-3.5-flash", "gemini-3.6-flash"],
        modelos: [
          { id: "gemini-3.6-flash", nombre: "Gemini 3.6 Flash" },
          { id: "gemini-3.5-flash", nombre: "Gemini 3.5 Flash" }
        ]
      }),
      getStatus: () => ({ modelosConfigurados: [] })
    }
  });
  const result = await service.listModels();
  assert.deepEqual(result.modelos.map((model) => model.id), [
    "gemini-3.5-flash",
    "gemini-3.6-flash"
  ]);
});
