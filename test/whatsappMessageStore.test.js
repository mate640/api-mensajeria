const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const {
  WhatsAppMessageStore,
  getDateRangeWindow,
  getDayWindow
} = require("../services/whatsappMessageStore");

test("calcula el dia usando la zona horaria de Argentina", () => {
  const window = getDayWindow(
    new Date("2026-07-30T18:00:00.000Z"),
    "America/Argentina/Buenos_Aires"
  );

  assert.equal(window.date, "2026-07-30");
  assert.equal(
    new Date(window.startSeconds * 1000).toISOString(),
    "2026-07-30T03:00:00.000Z"
  );
  assert.equal(
    new Date(window.endSeconds * 1000).toISOString(),
    "2026-07-31T03:00:00.000Z"
  );
});

test("guarda enviados y recibidos, evita duplicados y consulta el dia", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-messages-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveMessage("VENTAS", {
    key: {
      id: "RECIBIDO-1",
      remoteJid: "5491111111111@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421200,
    message: {
      conversation: "Necesito una cotizacion"
    }
  });
  store.saveMessage("VENTAS", {
    key: {
      id: "ENVIADO-1",
      remoteJid: "5491111111111@s.whatsapp.net",
      fromMe: true
    },
    messageTimestamp: {
      toNumber: () => 1785421260
    },
    message: {
      extendedTextMessage: {
        text: "Te la envio enseguida"
      }
    }
  });

  // El mismo mensaje puede llegar por sendMessage y luego por messages.upsert.
  store.saveMessage("VENTAS", {
    key: {
      id: "ENVIADO-1",
      remoteJid: "5491111111111@s.whatsapp.net",
      fromMe: true
    },
    messageTimestamp: 1785421260,
    message: {
      extendedTextMessage: {
        text: "Te la envio enseguida"
      }
    }
  });
  store.saveMessage("OTRA", {
    key: {
      id: "OTRA-1",
      remoteJid: "5492222222222@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421300,
    message: {
      conversation: "No debe aparecer"
    }
  });
  const savedStatus = store.saveMessage("VENTAS", {
    key: {
      id: "ESTADO-1",
      remoteJid: "status@broadcast",
      fromMe: false
    },
    messageTimestamp: 1785421400,
    message: {
      imageMessage: {
        caption: "Esto es un Estado, no un chat"
      }
    }
  });

  const result = store.getMessagesToday("VENTAS", {
    now: new Date("2026-07-30T18:00:00.000Z")
  });

  assert.equal(result.fecha, "2026-07-30");
  assert.equal(result.zonaHoraria, "America/Argentina/Buenos_Aires");
  assert.equal(savedStatus, false);
  assert.equal(result.cantidad, 2);
  assert.deepEqual(
    result.mensajes.map((message) => message.direccion),
    ["recibido", "enviado"]
  );
  assert.equal(result.mensajes[0].texto, "Necesito una cotizacion");
  assert.equal(result.mensajes[1].texto, "Te la envio enseguida");
});

test("usa el telefono real de LID y deduplica history contra upsert", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-lid-history-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const historyMessage = {
    key: {
      id: "MISMO-MENSAJE",
      remoteJid: "232241967984720@lid",
      senderPn: "5492245559054@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421200,
    message: { conversation: "Mensaje sincronizado" }
  };

  store.saveMessage("PERSONAL", {
    key: {
      id: "RESPUESTA-ANTERIOR",
      remoteJid: "232241967984720@lid",
      fromMe: true
    },
    messageTimestamp: 1785421140,
    message: { conversation: "Respuesta anterior sincronizada" }
  });
  store.saveMessage("PERSONAL", historyMessage);
  store.saveMessage("PERSONAL", {
    ...historyMessage,
    key: {
      id: "MISMO-MENSAJE",
      remoteJid: "5492245559054@s.whatsapp.net",
      fromMe: false
    }
  });
  store.saveMessage("PERSONAL", {
    key: {
      id: "RESPUESTA",
      remoteJid: "232241967984720@lid",
      fromMe: true
    },
    messageTimestamp: 1785421260,
    message: { conversation: "Respuesta desde el telefono" }
  });

  const result = store.getMessages("PERSONAL", {
    from: "2026-07-30",
    to: "2026-07-30"
  });

  assert.equal(result.cantidad, 3);
  assert.equal(result.estadisticas.conversaciones, 1);
  assert.equal(result.conversaciones[0].numero, "5492245559054");
  assert.deepEqual(
    result.mensajes.map((message) => message.chat),
    [
      "5492245559054@s.whatsapp.net",
      "5492245559054@s.whatsapp.net",
      "5492245559054@s.whatsapp.net"
    ]
  );
});

test("guarda el telefono real del participante de un grupo", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-group-participant-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveMessage("PERSONAL", {
    key: {
      id: "GRUPO-1",
      remoteJid: "120363353261560649@g.us",
      participant: "126701703061694@lid",
      participantPn: "5492257639508@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421200,
    message: { conversation: "Hola grupo" }
  });

  const result = store.getMessages("PERSONAL", {
    from: "2026-07-30",
    to: "2026-07-30"
  });

  assert.equal(
    result.mensajes[0].participante,
    "5492257639508@s.whatsapp.net"
  );
});

test("migra conversaciones LID existentes al telefono conocido", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-lid-migration-")
  );
  const databaseFile = path.join(temporaryRoot, "messages.sqlite");
  const legacyDatabase = new Database(databaseFile);
  legacyDatabase.exec(`
    CREATE TABLE whatsapp_messages (
      instance_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      remote_jid TEXT NOT NULL,
      participant_jid TEXT,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      text TEXT,
      message_timestamp INTEGER NOT NULL,
      raw_message TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, remote_jid, message_id)
    );
  `);
  const insert = legacyDatabase.prepare(`
    INSERT INTO whatsapp_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const lid = "232241967984720@lid";
  insert.run(
    "PERSONAL",
    "RECIBIDO-LEGACY",
    lid,
    null,
    "recibido",
    "conversation",
    "Hola",
    1785421200,
    JSON.stringify({
      key: {
        id: "RECIBIDO-LEGACY",
        remoteJid: lid,
        senderPn: "5492245559054@s.whatsapp.net",
        fromMe: false
      },
      message: { conversation: "Hola" }
    }),
    "2026-07-30T15:00:00.000Z"
  );
  insert.run(
    "PERSONAL",
    "ENVIADO-LEGACY",
    lid,
    null,
    "enviado",
    "conversation",
    "Respuesta",
    1785421260,
    JSON.stringify({
      key: { id: "ENVIADO-LEGACY", remoteJid: lid, fromMe: true },
      message: { conversation: "Respuesta" }
    }),
    "2026-07-30T15:01:00.000Z"
  );
  legacyDatabase.close();

  const store = new WhatsAppMessageStore({ databaseFile });
  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const result = store.getMessages("PERSONAL", {
    from: "2026-07-30",
    to: "2026-07-30"
  });

  assert.equal(result.estadisticas.conversaciones, 1);
  assert.equal(result.conversaciones[0].numero, "5492245559054");
  assert.ok(
    result.mensajes.every(
      (message) => message.chat === "5492245559054@s.whatsapp.net"
    )
  );
});

test("agrupa conversaciones y calcula estadisticas para un rango", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-report-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const save = (id, chat, fromMe, timestamp, text) =>
    store.saveMessage("VENTAS", {
      key: { id, remoteJid: chat, fromMe },
      messageTimestamp: timestamp,
      message: { conversation: text }
    });

  save("R-1", "5491111111111@s.whatsapp.net", false, 1785421200, "Hola");
  save("E-1", "5491111111111@s.whatsapp.net", true, 1785421320, "Buen dia");
  save("R-2", "5492222222222@s.whatsapp.net", false, 1785421400, "Consulta");
  save("E-FUERA", "5492222222222@s.whatsapp.net", true, 1785509000, "Mañana");

  const result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });

  assert.equal(result.desde, "2026-07-30");
  assert.equal(result.hasta, "2026-07-30");
  assert.equal(result.cantidad, 3);
  assert.deepEqual(result.estadisticas, {
    mensajesRecibidos: 2,
    mensajesEnviados: 1,
    tiempoPromedioRespuestaSegundos: 120,
    respuestasMedidas: 1,
    conversaciones: 2
  });
  assert.equal(result.conversaciones[0].numero, "5492222222222");
  assert.equal(result.conversaciones[1].mensajes.length, 2);
});

test("valida las fechas del rango", () => {
  assert.throws(
    () => getDateRangeWindow("2026-07-31", "2026-07-30"),
    (error) =>
      error.statusCode === 400 &&
      error.message === "desde no puede ser posterior a hasta"
  );
  assert.throws(
    () => getDateRangeWindow("2026-02-30", "2026-03-01"),
    (error) =>
      error.statusCode === 400 && error.message === "desde no es una fecha valida"
  );
});

test("persiste prompt y sobrescribe etiquetas de conversaciones", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-labels-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveMessage("VENTAS", {
    key: { id: "R-1", remoteJid: "5491111111111@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1785421200,
    message: { conversation: "Necesito precio" }
  });
  store.saveAnalystPrompt("VENTAS", "Prompt personalizado");
  assert.equal(store.getAnalystPrompt("VENTAS"), "Prompt personalizado");

  const base = {
    chat: "5491111111111@s.whatsapp.net",
    numero: "5491111111111",
    estado: "sin respuesta",
    requiereAccion: true,
    motivo: "Pendiente"
  };
  store.saveConversationLabels("VENTAS", [
    { ...base, categoria: "consulta de precio" }
  ], "2026-08-01T12:00:00.000Z");
  store.saveConversationLabels("VENTAS", [
    { ...base, categoria: "presupuesto/cotizacion", motivo: "Revisar" }
  ], "2026-08-02T12:00:00.000Z");

  const result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].etiqueta.categoria, "presupuesto/cotizacion");
  assert.equal(result.conversaciones[0].etiqueta.motivo, "Revisar");
  assert.equal(result.conversaciones[0].etiqueta.analizadoEn, "2026-08-02T12:00:00.000Z");
});
