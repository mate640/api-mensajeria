const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");

process.env.WHATSAPP_MULTI_INSTANCE_ENABLED = "true";

const whatsappRoutes = require("../routes/whatsapp");
const whatsappManager = require("../services/whatsappManager");

async function startTestServer(t) {
  const app = express();
  app.use(express.json());
  app.use("/whatsapp", whatsappRoutes);
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("expone el modo multi y lista sin instancia predeterminada", async (t) => {
  const base = await startTestServer(t);
  const mode = await fetch(`${base}/whatsapp/modo`).then((response) =>
    response.json()
  );
  const status = await fetch(`${base}/whatsapp/estado`).then((response) =>
    response.json()
  );

  assert.equal(mode.modo, "multi");
  assert.equal(mode.multiInstanciaHabilitada, true);
  assert.deepEqual(status.instancias, []);
  assert.equal("estado" in status, false);
});

test("exige instancia en el endpoint de envio compartido", async (t) => {
  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/enviar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      destinos: [{ numero: "5491112345678", nombre: "Prueba" }],
      mensaje: "Este mensaje no se envia"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "instancia es obligatoria");
});

test("valida que eliminarCopia sea una bandera booleana", async (t) => {
  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/enviar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instancia: "LOGISTICA",
      destinos: [{ numero: "5491112345678", nombre: "Prueba" }],
      mensaje: "Este mensaje no se envia",
      eliminarCopia: "true"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "eliminarCopia debe ser true o false");
});

test("devuelve 404 para una instancia inexistente", async (t) => {
  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/enviar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instancia: "LOGISTICA",
      destinos: [{ numero: "5491112345678", nombre: "Prueba" }],
      mensaje: "Este mensaje no se envia"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.match(body.error, /LOGISTICA no existe/);
});

test("consulta los mensajes de hoy de una instancia", async (t) => {
  const instance = {
    record: { id: "VENTAS" },
    getMessagesToday: () => ({
      instancia: "VENTAS",
      fecha: "2026-07-30",
      zonaHoraria: "America/Argentina/Buenos_Aires",
      cantidad: 1,
      mensajes: [
        {
          id: "MENSAJE-1",
          direccion: "recibido",
          texto: "Hola"
        }
      ]
    })
  };
  whatsappManager.instances.set("VENTAS", instance);
  t.after(() => {
    whatsappManager.instances.delete("VENTAS");
  });

  const base = await startTestServer(t);
  const response = await fetch(
    `${base}/whatsapp/instancias/VENTAS/mensajes-hoy`
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.instancia, "VENTAS");
  assert.equal(body.cantidad, 1);
  assert.equal(body.mensajes[0].texto, "Hola");
});

test("consulta mensajes, conversaciones y estadisticas por fechas", async (t) => {
  let receivedOptions;
  const instance = {
    record: { id: "REPORTES" },
    getMessages: (options) => {
      receivedOptions = options;
      return {
        instancia: "REPORTES",
        desde: options.from,
        hasta: options.to,
        cantidad: 2,
        estadisticas: {
          mensajesRecibidos: 1,
          mensajesEnviados: 1,
          tiempoPromedioRespuestaSegundos: 90,
          conversaciones: 1
        },
        conversaciones: [
          {
            chat: "5491111111111@s.whatsapp.net",
            numero: "5491111111111",
            mensajes: [{ id: "M-1" }, { id: "M-2" }]
          }
        ],
        mensajes: [{ id: "M-1" }, { id: "M-2" }]
      };
    }
  };
  whatsappManager.instances.set("REPORTES", instance);
  t.after(() => {
    whatsappManager.instances.delete("REPORTES");
  });

  const base = await startTestServer(t);
  const response = await fetch(
    `${base}/whatsapp/instancias/REPORTES/mensajes?desde=2026-07-01&hasta=2026-07-30`
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions, {
    from: "2026-07-01",
    to: "2026-07-30",
    chatIds: []
  });
  assert.equal(body.estadisticas.mensajesRecibidos, 1);
  assert.equal(body.estadisticas.tiempoPromedioRespuestaSegundos, 90);
  assert.equal(body.conversaciones[0].mensajes.length, 2);
});

test("envia uno o varios filtros de chat al consultar mensajes", async (t) => {
  let receivedOptions;
  const instance = {
    record: { id: "REPORTES" },
    getMessages: (options) => {
      receivedOptions = options;
      return {
        instancia: "REPORTES",
        desde: options.from,
        hasta: options.to,
        cantidad: 0,
        estadisticas: { conversaciones: 0 },
        conversaciones: [],
        mensajes: []
      };
    }
  };
  whatsappManager.instances.set("REPORTES", instance);
  t.after(() => whatsappManager.instances.delete("REPORTES"));

  const base = await startTestServer(t);
  const query = new URLSearchParams({
    desde: "2026-08-01",
    hasta: "2026-08-05"
  });
  query.append("chatId", "120363111111111111@g.us");
  query.append("chatId", "5492244111111@s.whatsapp.net");
  const response = await fetch(
    `${base}/whatsapp/instancias/REPORTES/mensajes?${query}`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions.chatIds, [
    "120363111111111111@g.us",
    "5492244111111@s.whatsapp.net"
  ]);
});

test("lista contactos y grupos guardados para una instancia", async (t) => {
  const instance = {
    record: { id: "VENTAS" },
    getStoredChats: () => ({
      contactos: [
        {
          id: "5492244111111@s.whatsapp.net",
          tipo: "contacto",
          nombre: "Cliente"
        }
      ],
      grupos: [
        {
          id: "120363111111111111@g.us",
          tipo: "grupo",
          nombre: "Ventas"
        }
      ]
    })
  };
  whatsappManager.instances.set("VENTAS", instance);
  t.after(() => whatsappManager.instances.delete("VENTAS"));

  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/instancias/VENTAS/chats`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.contactos[0].nombre, "Cliente");
  assert.equal(body.grupos[0].nombre, "Ventas");
});

test("consulta y actualiza la configuracion de registro", async (t) => {
  const saved = [];
  const instance = {
    record: { id: "VENTAS" },
    getCaptureConfiguration: () => ({
      instancia: "VENTAS",
      modo: "todo",
      seleccionados: [],
      retencionDias: null,
      actualizadoEn: null,
      destinos: {
        contactos: [
          {
            id: "5491111111111@s.whatsapp.net",
            tipo: "contacto",
            nombre: "Cliente"
          }
        ],
        grupos: []
      }
    }),
    saveCaptureConfiguration: (options) => {
      saved.push(options);
      return {
        instancia: "VENTAS",
        modo: options.modo,
        seleccionados: options.seleccionados,
        actualizadoEn: "2026-08-05T12:00:00.000Z"
      };
    }
  };
  whatsappManager.instances.set("VENTAS", instance);
  t.after(() => whatsappManager.instances.delete("VENTAS"));

  const base = await startTestServer(t);
  const getResponse = await fetch(
    `${base}/whatsapp/instancias/VENTAS/configuracion-registro`
  );
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.equal(getBody.modo, "todo");
  assert.equal(getBody.destinos.contactos[0].nombre, "Cliente");

  const putResponse = await fetch(
    `${base}/whatsapp/instancias/VENTAS/configuracion-registro`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modo: "seleccionados",
        seleccionados: ["5491111111111@s.whatsapp.net"],
        retencionDias: 30
      })
    }
  );
  const putBody = await putResponse.json();
  assert.equal(putResponse.status, 200);
  assert.equal(putBody.modo, "seleccionados");
  assert.deepEqual(saved, [
    {
      modo: "seleccionados",
      seleccionados: ["5491111111111@s.whatsapp.net"],
      retencionDias: 30
    }
  ]);
});

test("vacia la bandeja solo con confirmacion exacta", async (t) => {
  let clearCalls = 0;
  const instance = {
    record: { id: "VENTAS" },
    clearInbox: () => {
      clearCalls += 1;
      return {
        instancia: "VENTAS",
        mensajesEliminados: 42,
        etiquetasEliminadas: 3
      };
    }
  };
  whatsappManager.instances.set("VENTAS", instance);
  t.after(() => whatsappManager.instances.delete("VENTAS"));

  const base = await startTestServer(t);
  const rejected = await fetch(
    `${base}/whatsapp/instancias/VENTAS/mensajes`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmacion: "INCORRECTA" })
    }
  );
  assert.equal(rejected.status, 400);
  assert.equal(clearCalls, 0);

  const accepted = await fetch(
    `${base}/whatsapp/instancias/VENTAS/mensajes`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmacion: "VENTAS" })
    }
  );
  const body = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(body.mensajesEliminados, 42);
  assert.equal(clearCalls, 1);
});

test("resincroniza los contactos de una instancia", async (t) => {
  let called = 0;
  const instance = {
    record: { id: "VENTAS" },
    resyncContacts: async () => {
      called += 1;
      return {
        instancia: "VENTAS",
        contactos: 20,
        nombresAgendados: 16,
        contactosConNombre: 18,
        contactosConTelefono: 17
      };
    }
  };
  whatsappManager.instances.set("VENTAS", instance);
  t.after(() => whatsappManager.instances.delete("VENTAS"));

  const base = await startTestServer(t);
  const response = await fetch(
    `${base}/whatsapp/instancias/VENTAS/resincronizar-contactos`,
    { method: "POST" }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.contactosConNombre, 18);
  assert.equal(called, 1);
});

test("analiza la bandeja de una instancia para el rango elegido", async (t) => {
  let receivedOptions;
  const instance = {
    record: { id: "ANALISIS" },
    analyzeInbox: async (options) => {
      receivedOptions = options;
      return {
        instancia: "ANALISIS",
        desde: options.from,
        hasta: options.to,
        resumenEjecutivo: "Se analizaron 2 conversaciones.",
        tipificaciones: [
          {
            numero: "5491111111111",
            categoria: "presupuesto/cotizacion",
            estado: "cerrada",
            requiereAccion: false,
            motivo: "Presupuesto respondido."
          }
        ],
        oportunidadesPerdidas: [],
        temasFrecuentes: [],
        calidadAtencion: "Buena.",
        recomendaciones: []
      };
    }
  };
  whatsappManager.instances.set("ANALISIS", instance);
  t.after(() => {
    whatsappManager.instances.delete("ANALISIS");
  });

  const base = await startTestServer(t);
  const response = await fetch(
    `${base}/whatsapp/instancias/ANALISIS/analizar-bandeja`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        desde: "2026-07-30",
        hasta: "2026-07-30",
        modelo: "gemini-2.5-flash"
      })
    }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions, {
    from: "2026-07-30",
    to: "2026-07-30",
    model: "gemini-2.5-flash"
  });
  assert.equal(body.ok, true);
  assert.equal(body.tipificaciones[0].estado, "cerrada");
  assert.equal(body.tipificaciones[0].categoria, "presupuesto/cotizacion");
});

test("consulta y guarda el prompt del analista por instancia", async (t) => {
  let savedPrompt;
  const instance = {
    record: { id: "PROMPT" },
    getInboxAnalystPrompt: () => ({ prompt: "Prompt actual" }),
    saveInboxAnalystPrompt: (prompt) => {
      savedPrompt = prompt;
      return { prompt, actualizadoEn: "2026-08-03T12:00:00.000Z" };
    }
  };
  whatsappManager.instances.set("PROMPT", instance);
  t.after(() => whatsappManager.instances.delete("PROMPT"));
  const base = await startTestServer(t);

  const current = await fetch(
    `${base}/whatsapp/instancias/PROMPT/prompt-analista`
  ).then((response) => response.json());
  const response = await fetch(
    `${base}/whatsapp/instancias/PROMPT/prompt-analista`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Prompt nuevo" })
    }
  );
  const updated = await response.json();

  assert.equal(current.prompt, "Prompt actual");
  assert.equal(response.status, 200);
  assert.equal(savedPrompt, "Prompt nuevo");
  assert.equal(updated.prompt, "Prompt nuevo");
});

test("lista los modelos de IA disponibles para la bandeja", async (t) => {
  const originalListAiModels = whatsappManager.listAiModels;
  whatsappManager.listAiModels = async () => ({
    modeloPredeterminado: "gemini-3.6-flash",
    modelos: [
      {
        id: "gemini-2.5-flash",
        nombre: "Gemini 2.5 Flash",
        tokensEntrada: 1048576
      }
    ]
  });
  t.after(() => {
    whatsappManager.listAiModels = originalListAiModels;
  });

  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/modelos-ia`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.modeloPredeterminado, "gemini-3.6-flash");
  assert.equal(body.modelos[0].id, "gemini-2.5-flash");
});
