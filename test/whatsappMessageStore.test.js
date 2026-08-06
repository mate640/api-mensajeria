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

test("expone el nombre de perfil incluido en el mensaje", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-push-name-")
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
      id: "PERFIL-1",
      remoteJid: "5491111111111@s.whatsapp.net",
      fromMe: false
    },
    pushName: "Nombre configurado en WhatsApp",
    messageTimestamp: 1785421200,
    message: { conversation: "Hola" }
  });

  const result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(
    result.conversaciones[0].nombrePerfil,
    "Nombre configurado en WhatsApp"
  );
  assert.equal(
    result.conversaciones[0].nombre,
    "Nombre configurado en WhatsApp"
  );
});

test("filtra mensajes por chats y recalcula las estadisticas", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-chat-filter-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const selectedGroup = "120363111111111111@g.us";
  store.saveMessage("VENTAS", {
    key: {
      id: "GRUPO-RECIBIDO",
      remoteJid: selectedGroup,
      participant: "5492244111111@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421200,
    message: { conversation: "Mensaje del grupo" }
  });
  store.saveMessage("VENTAS", {
    key: {
      id: "CONTACTO-RECIBIDO",
      remoteJid: "5492244222222@s.whatsapp.net",
      fromMe: false
    },
    messageTimestamp: 1785421260,
    message: { conversation: "Mensaje de otro chat" }
  });

  const result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30",
    chatIds: [selectedGroup]
  });

  assert.equal(result.cantidad, 1);
  assert.equal(result.estadisticas.conversaciones, 1);
  assert.equal(result.estadisticas.mensajesRecibidos, 1);
  assert.equal(result.conversaciones[0].chat, selectedGroup);
  assert.equal(result.mensajes[0].texto, "Mensaje del grupo");
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

test("guarda contactos, prioriza el nombre agendado y resuelve su LID", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-contacts-")
  );
  const databaseFile = path.join(temporaryRoot, "messages.sqlite");
  let store = new WhatsAppMessageStore({ databaseFile });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const lid = "158256760623138@lid";
  const phone = "5492245559054@s.whatsapp.net";
  store.saveMessage("VENTAS", {
    key: { id: "LID-1", remoteJid: lid, fromMe: false },
    pushName: "Nombre de perfil",
    messageTimestamp: 1785421200,
    message: { conversation: "Hola" }
  });

  let result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].esLid, true);
  assert.equal(result.conversaciones[0].telefono, null);
  assert.equal(result.conversaciones[0].nombre, "Nombre de perfil");

  store.saveContacts("VENTAS", [
    {
      id: phone,
      jid: phone,
      lid,
      name: "Cliente agendado",
      notify: "Nombre de perfil"
    }
  ]);

  result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].chat, phone);
  assert.equal(result.conversaciones[0].numero, "5492245559054");
  assert.equal(result.conversaciones[0].telefono, "5492245559054");
  assert.equal(result.conversaciones[0].esLid, false);
  assert.equal(result.conversaciones[0].nombre, "Cliente agendado");
  assert.equal(result.conversaciones[0].nombreAgendado, "Cliente agendado");
  assert.equal(result.conversaciones[0].nombrePerfil, "Nombre de perfil");
  assert.deepEqual(store.getContactStats("VENTAS"), {
    contactos: 1,
    nombresAgendados: 1,
    contactosConNombre: 1,
    contactosConTelefono: 1
  });

  store.close();
  store = new WhatsAppMessageStore({ databaseFile });
  result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].numero, "5492245559054");
  assert.equal(result.conversaciones[0].nombre, "Cliente agendado");
});

test("asocia un LID cuando Baileys comparte luego el telefono", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-phone-share-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const lid = "140978090467529@lid";
  const phone = "5491112345678@s.whatsapp.net";
  store.saveContacts("VENTAS", [{ id: lid, name: "Corralón Centro" }]);
  store.saveMessage("VENTAS", {
    key: { id: "LID-2", remoteJid: lid, fromMe: true },
    messageTimestamp: 1785421200,
    message: { conversation: "Buen día" }
  });
  assert.equal(store.savePhoneNumberShare("VENTAS", { lid, jid: phone }), true);

  const result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].chat, phone);
  assert.equal(result.conversaciones[0].numero, "5491112345678");
  assert.equal(result.conversaciones[0].nombre, "Corralón Centro");
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
    pushName: "María Vendedora",
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
  assert.equal(result.mensajes[0].telefonoParticipante, "5492257639508");
  assert.equal(result.mensajes[0].nombreParticipante, "María Vendedora");
});

test("guarda y expone el nombre del grupo en la bandeja", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-groups-")
  );
  const databaseFile = path.join(temporaryRoot, "messages.sqlite");
  let store = new WhatsAppMessageStore({ databaseFile });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const groupId = "120363123456789012@g.us";
  store.saveMessage("VENTAS", {
    key: { id: "GRUPO-1", remoteJid: groupId, fromMe: false },
    messageTimestamp: 1785421200,
    message: { conversation: "Buen día" }
  });
  store.saveGroups("VENTAS", [
    { id: groupId, subject: "Clientes mayoristas", desc: "Pedidos" }
  ]);

  let result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].nombre, "Clientes mayoristas");
  assert.equal(result.conversaciones[0].nombreGrupo, "Clientes mayoristas");

  store.close();
  store = new WhatsAppMessageStore({ databaseFile });
  result = store.getMessages("VENTAS", {
    from: "2026-07-30",
    to: "2026-07-30"
  });
  assert.equal(result.conversaciones[0].nombre, "Clientes mayoristas");
});

test("aplica por instancia los modos de captura todo, seleccionados y nada", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-capture-settings-")
  );
  const databaseFile = path.join(temporaryRoot, "messages.sqlite");
  let store = new WhatsAppMessageStore({ databaseFile });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const contactId = "5491111111111@s.whatsapp.net";
  const otherContactId = "5492222222222@s.whatsapp.net";
  const groupId = "120363123456789012@g.us";
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const message = (id, remoteJid) => ({
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: currentTimestamp,
    message: { conversation: id }
  });

  assert.equal(store.getCaptureSettings("VENTAS").modo, "todo");
  assert.equal(store.saveMessage("VENTAS", message("TODO-1", otherContactId)), true);

  store.saveCaptureSettings("VENTAS", "nada", []);
  assert.equal(store.getCaptureSettings("OTRA").modo, "todo");
  assert.equal(store.saveMessage("VENTAS", message("NADA-1", contactId)), false);

  assert.throws(
    () => store.saveCaptureSettings("VENTAS", "seleccionados", []),
    /al menos un contacto o grupo/
  );
  store.saveCaptureSettings("VENTAS", "seleccionados", [contactId, groupId]);
  assert.equal(
    store.saveMessage("VENTAS", {
      ...message("SEL-HISTORICO", contactId),
      messageTimestamp: currentTimestamp - 60
    }),
    false
  );
  assert.equal(store.saveMessage("VENTAS", message("SEL-1", contactId)), true);
  assert.equal(store.saveMessage("VENTAS", message("SEL-2", groupId)), true);
  assert.equal(store.saveMessage("VENTAS", message("SEL-3", otherContactId)), false);

  store.saveContacts("VENTAS", [
    { id: contactId, name: "Cliente seleccionado" }
  ]);
  store.saveGroups("VENTAS", [
    { id: groupId, subject: "Grupo seleccionado" }
  ]);
  const targets = store.getCaptureTargets("VENTAS");
  assert.equal(targets.contactos[0].nombre, "Cliente seleccionado");
  assert.equal(targets.grupos[0].nombre, "Grupo seleccionado");

  store.close();
  store = new WhatsAppMessageStore({ databaseFile });
  assert.deepEqual(store.getCaptureSettings("VENTAS").seleccionados, [
    groupId,
    contactId
  ]);
});

test("elimina por retencion y permite vaciar una bandeja completa", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-retention-")
  );
  const store = new WhatsAppMessageStore({
    databaseFile: path.join(temporaryRoot, "messages.sqlite")
  });

  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const now = new Date("2026-08-05T12:00:00.000Z");
  const chat = "5491111111111@s.whatsapp.net";
  const otherChat = "5492222222222@s.whatsapp.net";
  const createMessage = (id, remoteJid, daysAgo) => ({
    key: { id, remoteJid, fromMe: false },
    messageTimestamp:
      Math.floor(now.getTime() / 1000) - daysAgo * 24 * 60 * 60,
    message: { conversation: id }
  });

  store.saveMessage("VENTAS", createMessage("ANTIGUO", chat, 40));
  store.saveMessage("VENTAS", createMessage("RECIENTE", chat, 10));
  store.saveMessage("OTRA", createMessage("OTRA-ANTIGUO", otherChat, 60));
  store.saveConversationLabels("VENTAS", [
    {
      chat,
      numero: "5491111111111",
      categoria: "Consulta",
      estado: "pendiente",
      requiereAccion: true,
      motivo: "Prueba"
    }
  ]);
  store.saveCaptureSettings("VENTAS", "todo", [], 30);

  const cleanup = store.deleteExpiredMessages(now);
  assert.equal(cleanup.mensajesEliminados, 1);
  assert.equal(cleanup.instancias[0].retencionDias, 30);
  assert.equal(
    store.getMessages("VENTAS", { from: "2026-06-01", to: "2026-08-05" })
      .cantidad,
    1
  );
  assert.equal(
    store.getMessages("OTRA", { from: "2026-06-01", to: "2026-08-05" })
      .cantidad,
    1
  );

  const cleared = store.clearInbox("VENTAS");
  assert.equal(cleared.mensajesEliminados, 1);
  assert.equal(cleared.etiquetasEliminadas, 1);
  assert.equal(
    store.getMessages("VENTAS", { from: "2026-06-01", to: "2026-08-05" })
      .cantidad,
    0
  );
});

test("agrega retencion a una configuracion de captura existente", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-retention-migration-")
  );
  const databaseFile = path.join(temporaryRoot, "messages.sqlite");
  const legacyDatabase = new Database(databaseFile);
  legacyDatabase.exec(`
    CREATE TABLE whatsapp_capture_settings (
      instance_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO whatsapp_capture_settings (instance_id, mode, updated_at)
    VALUES ('VENTAS', 'todo', '2026-08-01T12:00:00.000Z');
  `);
  legacyDatabase.close();

  const store = new WhatsAppMessageStore({ databaseFile });
  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  assert.equal(store.getCaptureSettings("VENTAS").retencionDias, null);
  store.saveCaptureSettings("VENTAS", "todo", [], 90);
  assert.equal(store.getCaptureSettings("VENTAS").retencionDias, 90);
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
