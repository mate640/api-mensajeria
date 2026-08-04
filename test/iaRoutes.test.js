const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");

const {
  createIaRouter,
  isPrivateNetworkAddress,
  isTrustedPanelRequest
} = require("../routes/ia");

async function startTestServer(
  t,
  service,
  catalogService,
  fileSearchService,
  conversationStore,
  promptsService,
  modelConfigStore
) {
  const app = express();
  app.use(express.static(require("node:path").join(__dirname, "..", "public")));
  app.use(express.json());
  app.use(
    "/ia",
    createIaRouter({
      service,
      catalogService,
      fileSearchService,
      conversationStore,
      promptsService,
      modelConfigStore
    })
  );
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message,
      codigo: error.code || "ERROR_INTERNO"
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("sirve la consola de prueba de Gemini", async (t) => {
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async () => ({
      modelo: "gemini-test",
      resultado: "Listo",
      uso: null
    })
  });

  const response = await fetch(`${base}/ia/panel`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Consola Gemini/);
  assert.match(html, /Pegar listado/);
  assert.match(html, /Subir archivo/);
  assert.match(html, /Instrucciones para la IA/);
  assert.match(html, /id="content-list"/);
  assert.doesNotMatch(html, /Catálogo propio de artículos/);
  const generalFileInput = html.match(
    /<input\s+id="files"[\s\S]*?\/>/
  )?.[0];
  assert.ok(generalFileInput);
  assert.match(generalFileInput, /type="file"/);
  assert.match(generalFileInput, /\smultiple/);
  assert.doesNotMatch(generalFileInput, /\saccept=/);
  assert.match(html, /id="model-select"/);
  assert.match(html, /Prioridad de modelos Gemini/);
  assert.match(html, /id="model-priority-list"/);
  assert.match(html, /id="model-config-save"/);
  assert.match(html, /id="catalog-select"/);
  assert.doesNotMatch(html, /id="use-catalog"/);
  assert.match(html, /id="dictation-button"/);
  assert.match(html, /id="prompt-select"/);
  assert.match(html, /id="clear-content-list"/);
  assert.match(html, /id="clear-prompt"/);
  assert.match(html, /\/ia\/prompts/);
  assert.match(html, /SpeechRecognition/);
  assert.match(html, /Biblioteca File Search/);
  assert.match(html, /id="response-schema"/);
  assert.match(html, /id="conversation-banner"/);
  assert.match(html, /Respuesta o nuevo turno/);
  assert.match(html, /respuesta: prompt/);
  assert.match(html, /esquemaRespuesta/);
  assert.match(html, /id="file-search-create"/);
  assert.match(html, /\/ia\/file-search\/stores/);
  assert.match(html, /fileSearchStores/);
  assert.match(html, /\/ia\/modelos/);
  assert.match(html, /\/ia\/procesar/);
  assert.match(html, /formatElapsedTime/);
  assert.match(html, /demoró/);
  assert.match(html, /copy-message-button/);
  assert.match(html, /Copiar mensaje/);
  assert.match(html, /id="confirmation-dialog"/);
  assert.match(html, /requestDestructiveConfirmation/);
  assert.doesNotMatch(html, /window\.confirm\(/);
});

test("lista los prompts vigentes para el panel", async (t) => {
  const promptsService = {
    listPrompts: async () => [{
      id: 8,
      tipo: "COTIZADOR",
      version: 7,
      texto: "Compará los artículos.",
      actualizadoEn: "2026-08-03T13:49:41.708Z"
    }]
  };
  const base = await startTestServer(
    t,
    { getStatus: () => ({ configurado: true, modelo: "gemini-test" }) },
    undefined,
    undefined,
    undefined,
    promptsService
  );

  const response = await fetch(`${base}/ia/prompts`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.prompts.length, 1);
  assert.equal(body.prompts[0].tipo, "COTIZADOR");
  assert.equal(body.prompts[0].texto, "Compará los artículos.");
});

test("autoriza el panel local sin exponer IA_API_KEY", async (t) => {
  const previousKey = process.env.IA_API_KEY;
  const testKey = "clave-interna-local-de-prueba";
  process.env.IA_API_KEY = testKey;
  t.after(() => {
    if (previousKey === undefined) {
      delete process.env.IA_API_KEY;
    } else {
      process.env.IA_API_KEY = previousKey;
    }
  });

  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" })
  });
  const panelResponse = await fetch(`${base}/ia/panel`);
  const html = await panelResponse.text();
  const sessionCookie = panelResponse.headers.get("set-cookie");

  assert.equal(panelResponse.status, 200);
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /ia_local_panel=/);
  assert.match(sessionCookie, /HttpOnly/i);
  assert.doesNotMatch(html, new RegExp(testKey));

  const statusResponse = await fetch(`${base}/ia/estado`, {
    headers: {
      Cookie: sessionCookie.split(";", 1)[0]
    }
  });

  assert.equal(statusResponse.status, 200);
});

test("reconoce localhost y redes privadas como acceso confiable al panel", () => {
  for (const address of [
    "localhost",
    "127.0.0.1",
    "::1",
    "10.20.30.40",
    "172.16.0.10",
    "172.31.255.254",
    "192.168.1.33",
    "fd12:3456::1",
    "fe80::1"
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }

  for (const address of [
    "8.8.8.8",
    "172.32.0.1",
    "192.169.1.1",
    "example.com"
  ]) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }

  assert.equal(
    isTrustedPanelRequest({
      hostname: "192.168.1.33",
      socket: { remoteAddress: "::ffff:192.168.1.20" }
    }),
    true
  );
});

test("expone el estado sin clave pero protege el procesamiento", async (t) => {
  const previousKey = process.env.IA_API_KEY;
  process.env.IA_API_KEY = "clave-interna-local-de-prueba";
  t.after(() => {
    if (previousKey === undefined) {
      delete process.env.IA_API_KEY;
    } else {
      process.env.IA_API_KEY = previousKey;
    }
  });

  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" })
  });
  const statusResponse = await fetch(`${base}/ia/estado`);
  assert.equal(statusResponse.status, 200);

  const processResponse = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ instrucciones: "Prueba" })
  });
  assert.equal(processResponse.status, 401);
});

test("lista modelos e identifica los compatibles con catalogo", async (t) => {
  const modelConfigStore = {
    getStatus: () => ({
      modelosConfigurados: ["gemini-3.6-flash", "gemini-2.5-flash"],
      modeloPrincipal: "gemini-3.6-flash",
      actualizadoEn: "2026-08-03T12:00:00.000Z"
    })
  };
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({
        configurado: true,
        modelo: "gemini-3.6-flash"
      }),
      listModels: async () => ({
        modeloPredeterminado: "gemini-3.6-flash",
        modelos: [
          {
            id: "gemini-3.6-flash",
            nombre: "Gemini 3.6 Flash"
          },
          {
            id: "gemini-2.5-flash",
            nombre: "Gemini 2.5 Flash"
          }
        ]
      })
    },
    undefined,
    undefined,
    undefined,
    undefined,
    modelConfigStore
  );

  const response = await fetch(`${base}/ia/modelos`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.modeloPredeterminado, "gemini-3.6-flash");
  assert.deepEqual(body.modelosConfigurados, [
    "gemini-3.6-flash",
    "gemini-2.5-flash"
  ]);
  assert.equal(body.modelos[0].compatibleCatalogo, true);
  assert.equal(body.modelos[1].compatibleCatalogo, false);
});

test("guarda el orden de prioridad de los modelos", async (t) => {
  let modelosGuardados;
  const modelConfigStore = {
    getStatus: () => ({
      modelosConfigurados: ["gemini-3.6-flash"],
      modeloPrincipal: "gemini-3.6-flash",
      actualizadoEn: null
    }),
    saveModels: async (modelos) => {
      modelosGuardados = modelos;
      return {
        modelosConfigurados: modelos,
        modeloPrincipal: modelos[0],
        actualizadoEn: "2026-08-03T13:00:00.000Z"
      };
    }
  };
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({ configurado: true, modelo: "gemini-3.6-flash" }),
      listModels: async () => ({
        modeloPredeterminado: "gemini-3.6-flash",
        modelos: [
          { id: "gemini-3.6-flash", nombre: "Gemini 3.6 Flash" },
          { id: "gemini-3.5-flash", nombre: "Gemini 3.5 Flash" }
        ]
      })
    },
    undefined,
    undefined,
    undefined,
    undefined,
    modelConfigStore
  );

  const response = await fetch(`${base}/ia/modelos`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelos: ["gemini-3.5-flash", "models/gemini-3.6-flash"]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(modelosGuardados, [
    "gemini-3.5-flash",
    "gemini-3.6-flash"
  ]);
  assert.equal(body.modeloPrincipal, "gemini-3.5-flash");
});

test("procesa una solicitud JSON", async (t) => {
  let received;
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async (payload) => {
      received = payload;
      return {
        modelo: "gemini-test",
        resultado: { resumen: "Listo" },
        uso: null
      };
    }
  });

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrucciones: "Resume la conversacion",
      datos: { mensajes: ["Hola"] },
      formatoRespuesta: "json"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(received.instrucciones, "Resume la conversacion");
  assert.deepEqual(received.datos, { mensajes: ["Hola"] });
  assert.deepEqual(body.resultado, { resumen: "Listo" });
  assert.match(body.id, /^[0-9a-f-]{36}$/);
});

test("envia varios File Search Stores al servicio", async (t) => {
  let received;
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async (payload) => {
      received = payload;
      return {
        modelo: "gemini-test",
        resultado: "Listo",
        uso: null,
        fileSearchStoresUsados: payload.fileSearchStoreNames
      };
    }
  });

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrucciones: "Consulta la biblioteca",
      fileSearchStores: [
        "fileSearchStores/manuales",
        "fileSearchStores/contratos"
      ]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(received.fileSearchStoreNames, [
    "fileSearchStores/manuales",
    "fileSearchStores/contratos"
  ]);
  assert.equal(body.fileSearchStoresUsados.length, 2);
});

test("administra stores y documentos de File Search", async (t) => {
  const calls = [];
  const fileSearchService = {
    listStores: async () => [
      {
        name: "fileSearchStores/manuales",
        displayName: "Manuales"
      }
    ],
    createStore: async (name) => ({
      name: "fileSearchStores/nuevo",
      displayName: name
    }),
    listDocuments: async (storeName) => [
      {
        name: `${storeName}/documents/manual-pdf`,
        displayName: "manual.pdf"
      }
    ],
    uploadDocuments: async (storeName, files) => {
      calls.push({ type: "upload", storeName, files });
      return files.map((file) => ({
        archivo: file.originalname,
        indexado: true
      }));
    },
    deleteDocument: async (documentName) => {
      calls.push({ type: "deleteDocument", documentName });
    },
    deleteStore: async (storeName) => {
      calls.push({ type: "deleteStore", storeName });
    }
  };
  const base = await startTestServer(
    t,
    { getStatus: () => ({ configurado: true, modelo: "gemini-test" }) },
    undefined,
    fileSearchService
  );

  const storesResponse = await fetch(`${base}/ia/file-search/stores`);
  const storesBody = await storesResponse.json();
  assert.equal(storesResponse.status, 200);
  assert.equal(storesBody.stores[0].displayName, "Manuales");

  const createResponse = await fetch(`${base}/ia/file-search/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre: "Nuevo store" })
  });
  assert.equal(createResponse.status, 201);

  const form = new FormData();
  form.append(
    "archivos",
    new Blob([Buffer.from("contenido")], { type: "text/plain" }),
    "manual.txt"
  );
  const uploadResponse = await fetch(
    `${base}/ia/file-search/stores/manuales/documentos`,
    { method: "POST", body: form }
  );
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.equal(calls[0].storeName, "fileSearchStores/manuales");
  assert.equal(calls[0].files[0].originalname, "manual.txt");
  assert.equal(uploadBody.documentos[0].displayName, "manual.pdf");

  const deleteDocumentResponse = await fetch(
    `${base}/ia/file-search/stores/manuales/documentos/manual-pdf`,
    { method: "DELETE" }
  );
  assert.equal(deleteDocumentResponse.status, 200);
  assert.equal(
    calls.find((call) => call.type === "deleteDocument").documentName,
    "fileSearchStores/manuales/documents/manual-pdf"
  );

  const deleteStoreResponse = await fetch(
    `${base}/ia/file-search/stores/manuales`,
    { method: "DELETE" }
  );
  assert.equal(deleteStoreResponse.status, 200);
  assert.equal(
    calls.find((call) => call.type === "deleteStore").storeName,
    "fileSearchStores/manuales"
  );
});

test("lista catalogos y configura el predeterminado", async (t) => {
  let defaultStoreName = "fileSearchStores/manuales";
  const catalogService = {
    getStatus: () => ({ cargado: false, procesando: false }),
    getDefaultStoreName: () => defaultStoreName,
    setDefaultStoreName: (storeName) => {
      defaultStoreName = storeName;
    }
  };
  const fileSearchService = {
    listStores: async () => [
      { name: "fileSearchStores/manuales", displayName: "Manuales" },
      { name: "fileSearchStores/articulos", displayName: "Articulos" }
    ]
  };
  const base = await startTestServer(
    t,
    { getStatus: () => ({ configurado: true, modelo: "gemini-test" }) },
    catalogService,
    fileSearchService
  );

  const listResponse = await fetch(`${base}/ia/catalogos`);
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.catalogoPredeterminado,
    "fileSearchStores/manuales"
  );
  assert.equal(listBody.catalogos[0].predeterminado, true);

  const updateResponse = await fetch(
    `${base}/ia/catalogos/predeterminado`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogoStore: "fileSearchStores/articulos"
      })
    }
  );
  const updateBody = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(
    updateBody.catalogoPredeterminado,
    "fileSearchStores/articulos"
  );
  assert.equal(defaultStoreName, "fileSearchStores/articulos");
});

test("procesa un PDF enviado como multipart", async (t) => {
  let received;
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async (payload) => {
      received = payload;
      return {
        modelo: "gemini-test",
        resultado: "Listo",
        uso: null
      };
    }
  });
  const form = new FormData();
  form.set("instrucciones", "Extrae articulos");
  form.set("contenido", "2 reflectores\n5 cables");
  form.set("datos", '{"moneda":"ARS"}');
  form.set(
    "archivo",
    new Blob([Buffer.from("%PDF-prueba")], {
      type: "application/pdf"
    }),
    "presupuesto.pdf"
  );

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: form
  });

  assert.equal(response.status, 200);
  assert.equal(received.archivos.length, 1);
  assert.equal(received.archivos[0].mimetype, "application/pdf");
  assert.equal(received.contenido.replace(/\r\n/g, "\n"), "2 reflectores\n5 cables");
  assert.deepEqual(received.datos, { moneda: "ARS" });
});

test("procesa un PDF usando el catalogo activo", async (t) => {
  let received;
  const catalogService = {
    getStatus: () => ({
      configurado: true,
      cargado: true,
      procesando: false,
      almacen: "fileSearchStores/catalogo-prueba-123"
    })
  };
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({
        configurado: true,
        modelo: "gemini-3.6-flash"
      }),
      process: async (payload) => {
        received = payload;
        return {
          modelo: "gemini-3.6-flash",
          resultado: "Listo",
          catalogoUsado: true
        };
      }
    },
    catalogService
  );
  const form = new FormData();
  form.set("instrucciones", "Busca coincidencias");
  form.set("usarCatalogo", "true");
  form.set("modelo", "gemini-3.5-flash");
  form.set(
    "archivo",
    new Blob([Buffer.from("%PDF-prueba")], {
      type: "application/pdf"
    }),
    "pedido.pdf"
  );

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: form
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    received.catalogStoreName,
    "fileSearchStores/catalogo-prueba-123"
  );
  assert.equal(received.modelo, undefined);
  assert.equal(body.catalogoUsado, true);
});

test("procesa usando el catalogo seleccionado por su store", async (t) => {
  let received;
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
      process: async (payload) => {
        received = payload;
        return { resultado: "Listo", catalogoUsado: true };
      }
    },
    {
      getStatus: () => ({
        cargado: true,
        almacen: "fileSearchStores/catalogo-activo"
      })
    }
  );

  const form = new FormData();
  form.set("instrucciones", "Buscar articulos");
  form.set("usarCatalogo", "true");
  form.set("catalogoStore", "fileSearchStores/catalogo-nuevo");
  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: form
  });

  assert.equal(response.status, 200);
  assert.equal(
    received.catalogStoreName,
    "fileSearchStores/catalogo-nuevo"
  );
});

test("usarCatalogo true usa el catalogo predeterminado", async (t) => {
  let received;
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
      process: async (payload) => {
        received = payload;
        return { resultado: "Listo", catalogoUsado: true };
      }
    },
    {
      getStatus: () => ({ cargado: false, procesando: false }),
      getDefaultStoreName: () => "fileSearchStores/predeterminado"
    }
  );

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrucciones: "Usar el catalogo configurado",
      usarCatalogo: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(
    received.catalogStoreName,
    "fileSearchStores/predeterminado"
  );
});

test("usarCatalogo false ignora el catalogo enviado", async (t) => {
  let received;
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
      process: async (payload) => {
        received = payload;
        return { resultado: "Listo", catalogoUsado: false };
      }
    },
    {
      getStatus: () => ({ cargado: false, procesando: false }),
      getDefaultStoreName: () => "fileSearchStores/predeterminado"
    }
  );

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrucciones: "No consultar catalogos",
      usarCatalogo: false,
      catalogoStore: "fileSearchStores/otro"
    })
  });

  assert.equal(response.status, 200);
  assert.equal(received.catalogStoreName, undefined);
});

test("inicia y continua un chat mediante /procesar", async (t) => {
  const received = [];
  const chatId = "33333333-3333-4333-8333-333333333333";
  const service = {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    processConversation: async (payload) => {
      received.push(payload);
      return {
        modelo: "gemini-test",
        resultado: payload.chatId ? "Comparacion final" : "¿Que medida?",
        chatId,
        requiereRespuesta: !payload.chatId,
        preguntas: payload.chatId ? [] : ["¿Que medida?"]
      };
    }
  };
  const conversationStore = { delete: () => true };
  const base = await startTestServer(
    t,
    service,
    undefined,
    undefined,
    conversationStore
  );

  const firstForm = new FormData();
  firstForm.set("instrucciones", "Compara la imagen");
  firstForm.set("mantenerConversacion", "true");
  firstForm.set("formatoRespuesta", "json");
  firstForm.set(
    "esquemaRespuesta",
    JSON.stringify({
      type: "object",
      properties: { articulos: { type: "array", items: { type: "string" } } },
      required: ["articulos"]
    })
  );
  firstForm.set(
    "archivo",
    new Blob([Buffer.from("imagen")], { type: "image/png" }),
    "cotizacion.png"
  );
  const firstResponse = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: firstForm
  });
  const firstBody = await firstResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.chatId, chatId);
  assert.equal(firstBody.requiereRespuesta, true);
  assert.equal(received[0].archivos.length, 1);
  assert.equal(received[0].formatoRespuesta, "json");
  assert.deepEqual(received[0].esquemaRespuesta.required, ["articulos"]);

  const secondResponse = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      respuesta: "La medida es 2,5 mm"
    })
  });
  const secondBody = await secondResponse.json();

  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.requiereRespuesta, false);
  assert.equal(secondBody.chat_id, chatId);
  assert.equal(received[1].chatId, chatId);
  assert.equal(received[1].instrucciones, "La medida es 2,5 mm");
  assert.equal(received[1].archivos.length, 0);
});

test("procesa varios archivos sin restringir su tipo", async (t) => {
  let received;
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async (payload) => {
      received = payload;
      return {
        modelo: "gemini-test",
        resultado: "Listo",
        uso: null
      };
    }
  });
  const form = new FormData();
  form.set("instrucciones", "Analiza los adjuntos");
  form.append(
    "archivos",
    new Blob([Buffer.from("datos")], {
      type: "application/vnd.ms-excel"
    }),
    "reporte.xls"
  );
  form.append(
    "archivos",
    new Blob([Buffer.from([0, 1, 2])], {
      type: "application/octet-stream"
    }),
    "muestra.bin"
  );

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: form
  });

  assert.equal(response.status, 200);
  assert.equal(received.archivos.length, 2);
  assert.equal(
    received.archivos[0].mimetype,
    "application/vnd.ms-excel"
  );
  assert.equal(
    received.archivos[1].mimetype,
    "application/octet-stream"
  );
});

test("rechaza datos multipart que no sean JSON", async (t) => {
  const base = await startTestServer(t, {
    getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
    process: async () => {
      throw new Error("No deberia ejecutarse");
    }
  });
  const form = new FormData();
  form.set("instrucciones", "Prueba");
  form.set("datos", "{invalido");

  const response = await fetch(`${base}/ia/procesar`, {
    method: "POST",
    body: form
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.codigo, "JSON_INVALIDO");
});

test("carga y consulta el catalogo de articulos", async (t) => {
  let receivedFile;
  let deleted = false;
  const catalogService = {
    getStatus: () => ({
      configurado: true,
      cargado: !deleted,
      articulos: deleted ? 0 : 4171,
      archivo: deleted ? undefined : "articulos.json"
    }),
    replaceCatalog: async (file) => {
      receivedFile = file;
      return {
        configurado: true,
        cargado: true,
        articulos: 4171,
        archivo: file.originalname
      };
    },
    deleteCatalog: async () => {
      deleted = true;
      return catalogService.getStatus();
    }
  };
  const base = await startTestServer(
    t,
    {
      getStatus: () => ({ configurado: true, modelo: "gemini-test" }),
      process: async () => ({ resultado: "Listo" })
    },
    catalogService
  );
  const form = new FormData();
  form.set(
    "catalogo",
    new Blob(
      [
        JSON.stringify([
          {
            cod_art: "TRI00012",
            descripcion: "PLACA YESO"
          }
        ])
      ],
      { type: "application/json" }
    ),
    "articulos.json"
  );

  const uploadResponse = await fetch(`${base}/ia/catalogo`, {
    method: "POST",
    body: form
  });
  const uploadBody = await uploadResponse.json();
  const statusBody = await fetch(`${base}/ia/catalogo`).then((response) =>
    response.json()
  );

  assert.equal(uploadResponse.status, 200);
  assert.equal(receivedFile.originalname, "articulos.json");
  assert.equal(uploadBody.articulos, 4171);
  assert.equal(statusBody.cargado, true);
  assert.equal(statusBody.archivo, "articulos.json");

  const deleteResponse = await fetch(`${base}/ia/catalogo`, {
    method: "DELETE"
  });
  const deleteBody = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteBody.cargado, false);
});
