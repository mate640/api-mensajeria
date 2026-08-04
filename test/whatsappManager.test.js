const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WhatsAppManager,
  WhatsAppInstance,
  extractPhoneNumber,
  normalizeAccountNumber,
  normalizeGroupId,
  normalizeInstanceId,
  replaceFile
} = require("../services/whatsappManager");

test("normaliza alias y numeros sin depender de Baileys", () => {
  assert.equal(normalizeInstanceId(" logística "), "LOGISTICA");
  assert.equal(normalizeInstanceId("Ventas CABA"), "VENTAS_CABA");
  assert.equal(normalizeAccountNumber("+54 9 224 555-8702"), "5492245558702");
  assert.equal(
    extractPhoneNumber("5492245558702:12@s.whatsapp.net"),
    "5492245558702"
  );
});

test("rechaza alias y numeros invalidos", () => {
  assert.throws(() => normalizeInstanceId("!!!"), /invalido/);
  assert.throws(() => normalizeAccountNumber("123"), /invalido/);
  assert.throws(() => normalizeGroupId("grupo-invalido"), /Group ID invalido/);
});

test("reemplaza el registro aunque Windows bloquee el rename", async () => {
  const calls = [];
  const lockedError = new Error("archivo bloqueado");
  lockedError.code = "EPERM";

  await replaceFile("registro.tmp", "registro.json", {
    rename: async () => {
      calls.push("rename");
      throw lockedError;
    },
    copyFile: async (source, destination) => {
      calls.push(`copy:${source}:${destination}`);
    },
    unlink: async (file) => {
      calls.push(`unlink:${file}`);
    },
    wait: async () => {}
  });

  assert.deepEqual(calls, [
    "rename",
    "copy:registro.tmp:registro.json",
    "unlink:registro.tmp"
  ]);
});

test("registra instancias unicas y persiste solo configuracion", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-manager-")
  );
  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const manager = new WhatsAppManager({
    instancesDir: path.join(temporaryRoot, "instances"),
    dataFile: path.join(temporaryRoot, "data", "instances.json")
  });

  const logistics = await manager.createInstance({
    nombre: "Logística",
    numero: "+5492245558702"
  });
  await manager.createInstance({
    nombre: "Ventas",
    numero: "+5492212345678"
  });

  assert.equal(logistics.record.id, "LOGISTICA");
  assert.deepEqual(
    manager.listInstances().map((instance) => instance.id),
    ["LOGISTICA", "VENTAS"]
  );

  await assert.rejects(
    manager.createInstance({
      nombre: "LOGISTICA",
      numero: "+5492299999999"
    }),
    (error) => error.statusCode === 409
  );

  await assert.rejects(
    manager.createInstance({
      nombre: "OTRA",
      numero: "+5492245558702"
    }),
    (error) => error.statusCode === 409
  );

  const registry = JSON.parse(
    fs.readFileSync(path.join(temporaryRoot, "data", "instances.json"), "utf8")
  );
  assert.equal(registry.version, 1);
  assert.equal(registry.instancias.length, 2);
  assert.equal(registry.instancias[0].numero, "5492245558702");
});

test("registra todas las instancias antes de iniciar sus conexiones", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-boot-")
  );
  const dataFile = path.join(temporaryRoot, "data", "instances.json");
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      instancias: [
        {
          id: "PERSONAL",
          nombre: "PERSONAL",
          numero: "5492245558701"
        },
        {
          id: "LOGISTICA",
          nombre: "LOGISTICA",
          numero: "5492245420450"
        }
      ]
    }),
    "utf8"
  );

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const manager = new WhatsAppManager({
    instancesDir: path.join(temporaryRoot, "instances"),
    dataFile
  });
  const originalInit = WhatsAppInstance.prototype.init;
  let releaseFirstConnection;
  const firstConnection = new Promise((resolve) => {
    releaseFirstConnection = resolve;
  });
  WhatsAppInstance.prototype.init = async () => firstConnection;

  try {
    const initialization = manager.init();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(manager.getInstance("PERSONAL"));
    assert.ok(manager.getInstance("LOGISTICA"));

    releaseFirstConnection();
    await initialization;
  } finally {
    WhatsAppInstance.prototype.init = originalInit;
  }
});

test("espera a que el transporte entregue QR antes de pedir el codigo", async () => {
  const emitter = new EventEmitter();
  const socket = {
    ev: {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener)
    }
  };
  const instance = new WhatsAppInstance(
    { instancesDir: "unused" },
    {
      id: "PERSONAL",
      nombre: "PERSONAL",
      numero: "5492245558701",
      createdAt: new Date().toISOString()
    }
  );
  instance.socket = socket;
  instance.generation = 7;

  const ready = instance.waitForPairingTransport(socket, 7, 1000);
  emitter.emit("connection.update", { connection: "connecting" });
  emitter.emit("connection.update", { qr: "qr-interno-no-expuesto" });

  await ready;
  assert.equal(emitter.listenerCount("connection.update"), 0);
});

test("cancela la espera si WhatsApp cierra el transporte", async () => {
  const emitter = new EventEmitter();
  const socket = {
    ev: {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener)
    }
  };
  const instance = new WhatsAppInstance(
    { instancesDir: "unused" },
    {
      id: "PERSONAL",
      nombre: "PERSONAL",
      numero: "5492245558701",
      createdAt: new Date().toISOString()
    }
  );
  instance.socket = socket;
  instance.generation = 3;

  const ready = instance.waitForPairingTransport(socket, 3, 1000);
  emitter.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: new Error("cierre de prueba")
    }
  });

  await assert.rejects(ready, /cierre de prueba/);
  assert.equal(emitter.listenerCount("connection.update"), 0);
});

test("activa history y procesa sus mensajes ademas de messages.upsert", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-wa-history-listener-")
  );
  const emitter = new EventEmitter();
  const captured = [];
  let socketOptions;
  const socket = {
    ev: {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener)
    },
    end: () => {}
  };
  const manager = {
    instancesDir: temporaryRoot,
    loadDependencies: async () => ({
      makeWASocket: (options) => {
        socketOptions = options;
        return socket;
      },
      useMultiFileAuthState: async () => ({
        state: { creds: { registered: true } },
        saveCreds: () => {}
      }),
      DisconnectReason: { loggedOut: 401 },
      version: [6, 7, 20],
      logger: {}
    }),
    saveMessage: (instanceId, message) => {
      captured.push({ instanceId, id: message.key.id });
      return true;
    }
  };
  const instance = new WhatsAppInstance(manager, {
    id: "PERSONAL",
    nombre: "PERSONAL",
    numero: "5492245558701",
    createdAt: new Date().toISOString()
  });

  t.after(async () => {
    await instance.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  await instance.init();
  assert.equal(socketOptions.syncFullHistory, true);
  assert.equal(emitter.listenerCount("messaging-history.set"), 1);
  assert.equal(emitter.listenerCount("messages.upsert"), 1);

  const message = {
    key: { id: "MENSAJE-1", remoteJid: "123@lid", fromMe: false },
    message: { conversation: "Hola" }
  };
  emitter.emit("messaging-history.set", { messages: [message] });
  emitter.emit("messages.upsert", { messages: [message], type: "notify" });

  assert.deepEqual(captured, [
    { instanceId: "PERSONAL", id: "MENSAJE-1" },
    { instanceId: "PERSONAL", id: "MENSAJE-1" }
  ]);
});

test("devuelve el Group ID y todos los metadatos disponibles", async () => {
  const groupId = "120363123456789012@g.us";
  const metadata = {
    id: groupId,
    addressingMode: "pn",
    owner: "5492200000000@s.whatsapp.net",
    subject: "Alertas",
    subjectTime: 1700000000,
    creation: 1600000000,
    desc: "Notificaciones operativas",
    restrict: true,
    announce: true,
    joinApprovalMode: true,
    participants: [
      {
        id: "5492211111111@s.whatsapp.net",
        admin: "superadmin",
        isAdmin: true,
        isSuperAdmin: true
      }
    ]
  };
  const instance = new WhatsAppInstance(
    { instancesDir: "unused" },
    {
      id: "PERSONAL",
      nombre: "PERSONAL",
      numero: "5492245558701",
      createdAt: new Date().toISOString()
    }
  );
  instance.socket = {
    groupMetadata: async (receivedId) => {
      assert.equal(receivedId, groupId);
      return metadata;
    }
  };
  instance.status = "conectado";
  instance.connectedNumber = "5492245558701";

  const result = await instance.getGroupDetails(groupId);

  assert.equal(result.groupId, groupId);
  assert.equal(result.nombre, "Alertas");
  assert.equal(result.participantes, 1);
  assert.equal(result.metadata.owner, metadata.owner);
  assert.equal(result.metadata.participants[0].admin, "superadmin");
  assert.equal(result.creadoEn, "2020-09-13T12:26:40.000Z");
});

test("elimina solo la copia local despues de enviar", async () => {
  const jid = "5491112345678@s.whatsapp.net";
  const sentMessage = {
    key: {
      id: "MENSAJE-123",
      remoteJid: jid,
      fromMe: true
    },
    messageTimestamp: 1753884000
  };
  let receivedModification = null;
  const instance = new WhatsAppInstance(
    { instancesDir: "unused" },
    {
      id: "LOGISTICA",
      nombre: "LOGISTICA",
      numero: "5492245558701",
      createdAt: new Date().toISOString()
    }
  );
  instance.socket = {
    sendMessage: async (receivedJid, content) => {
      assert.equal(receivedJid, jid);
      assert.deepEqual(content, { text: "Hola Juan" });
      return sentMessage;
    },
    chatModify: async (modification, receivedJid) => {
      assert.equal(receivedJid, jid);
      receivedModification = modification;
    }
  };
  instance.status = "conectado";
  instance.connectedNumber = "5492245558701";

  const result = await instance.sendBatch({
    destinos: [{ numero: "5491112345678", nombre: "Juan" }],
    mensaje: "Hola {nombre}",
    eliminarCopia: true
  });

  assert.deepEqual(receivedModification, {
    deleteForMe: {
      deleteMedia: false,
      key: sentMessage.key,
      timestamp: 1753884000
    }
  });
  assert.equal(result.enviados, 1);
  assert.equal(result.errores, 0);
  assert.equal(result.copiasEliminadas, 1);
  assert.equal(result.erroresEliminacion, 0);
  assert.equal(result.resultados[0].copiaEliminada, true);
});

test("no marca como fallido un envio si solo falla la eliminacion local", async () => {
  const instance = new WhatsAppInstance(
    { instancesDir: "unused" },
    {
      id: "LOGISTICA",
      nombre: "LOGISTICA",
      numero: "5492245558701",
      createdAt: new Date().toISOString()
    }
  );
  instance.socket = {
    sendMessage: async (jid) => ({
      key: {
        id: "MENSAJE-456",
        remoteJid: jid,
        fromMe: true
      },
      messageTimestamp: 1753884001
    }),
    chatModify: async () => {
      throw new Error("fallo de sincronizacion");
    }
  };
  instance.status = "conectado";
  instance.connectedNumber = "5492245558701";

  const result = await instance.sendBatch({
    destinos: [{ numero: "5491112345678", nombre: "Juan" }],
    mensaje: "Hola {nombre}",
    eliminarCopia: true
  });

  assert.equal(result.enviados, 1);
  assert.equal(result.errores, 0);
  assert.equal(result.copiasEliminadas, 0);
  assert.equal(result.erroresEliminacion, 1);
  assert.equal(result.resultados[0].estado, "enviado");
  assert.equal(result.resultados[0].copiaEliminada, false);
  assert.match(
    result.resultados[0].detalleEliminacion,
    /fallo de sincronizacion/
  );
});
