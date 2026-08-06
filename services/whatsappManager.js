const fs = require("fs");
const path = require("path");

const { normalizeArMobileNumber } = require("../utils/phone");
const { delay } = require("../utils/delay");
const {
  WhatsAppMessageStore
} = require("./whatsappMessageStore");
const {
  DEFAULT_ANALYST_PROMPT,
  whatsappInboxAnalysisService
} = require("./whatsappInboxAnalysisService");

const RETRYABLE_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EPERM"
]);

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function replaceFile(
  temporaryFile,
  destinationFile,
  {
    rename = fs.promises.rename,
    copyFile = fs.promises.copyFile,
    unlink = fs.promises.unlink,
    wait = delay,
    attempts = 6
  } = {}
) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(temporaryFile, destinationFile);
      return;
    } catch (renameError) {
      if (!RETRYABLE_FILE_ERROR_CODES.has(renameError.code)) {
        throw renameError;
      }

      lastError = renameError;
    }

    try {
      await copyFile(temporaryFile, destinationFile);
      await unlink(temporaryFile).catch(() => {});
      return;
    } catch (copyError) {
      if (!RETRYABLE_FILE_ERROR_CODES.has(copyError.code)) {
        throw copyError;
      }

      lastError = copyError;
    }

    if (attempt < attempts - 1) {
      await wait(50 * 2 ** attempt);
    }
  }

  throw lastError;
}

function normalizeInstanceId(value) {
  const id = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");

  if (!id) {
    throw createHttpError("nombre de instancia invalido", 400);
  }

  if (id.length > 40) {
    throw createHttpError("nombre de instancia demasiado largo", 400);
  }

  return id;
}

function normalizeAccountNumber(value) {
  const numero = normalizeArMobileNumber(value);

  if (numero.length < 8 || numero.length > 15) {
    throw createHttpError("numero de WhatsApp invalido", 400);
  }

  return numero;
}

function extractPhoneNumber(jid) {
  const value = String(jid || "").trim();
  if (!value) {
    return null;
  }

  const localPart = value.split("@")[0].split(":")[0];
  const digits = localPart.replace(/\D/g, "");
  return digits || null;
}

function unixTimestampToIso(value) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

function normalizeGroupId(value) {
  const groupId = String(value || "").trim();

  if (!/^[0-9-]+@g\.us$/.test(groupId)) {
    throw createHttpError("Group ID invalido", 400);
  }

  return groupId;
}

class WhatsAppInstance {
  constructor(manager, record) {
    this.manager = manager;
    this.record = record;
    this.rootDir = path.join(manager.instancesDir, record.id);
    this.authDir = path.join(this.rootDir, "auth");
    this.socket = null;
    this.authState = null;
    this.status = "creada";
    this.pairingCode = null;
    this.connectedNumber = null;
    this.lastError = null;
    this.lastChangedAt = new Date().toISOString();
    this.isInitializing = false;
    this.initPromise = null;
    this.reconnectTimer = null;
    this.contactSyncPromise = null;
    this.generation = 0;
    this.jobs = new Map();
  }

  setStatus(status, error = null) {
    this.status = status;
    this.lastError = error ? String(error.message || error) : null;
    this.lastChangedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.record.id,
      nombre: this.record.nombre,
      numero: this.record.numero,
      numeroConectado: this.connectedNumber,
      numeroVerificado: Boolean(
        this.connectedNumber && this.connectedNumber === this.record.numero
      ),
      estado: this.status,
      codigoVinculacionDisponible: Boolean(this.pairingCode),
      creadoEn: this.record.createdAt,
      verificadoEn: this.record.verifiedAt || null,
      ultimoCambio: this.lastChangedAt,
      ultimoError: this.lastError
    };
  }

  async init({ requestPairing = false } = {}) {
    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.socket && !requestPairing) {
      return;
    }

    this.initPromise = this.initialize({ requestPairing }).finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async initialize({ requestPairing }) {
    this.isInitializing = true;
    this.setStatus("inicializando");
    fs.mkdirSync(this.authDir, { recursive: true });
    let createdSocket = null;

    try {
      const {
        makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        version,
        logger
      } = await this.manager.loadDependencies();

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      this.authState = state;

      if (!state.creds.registered && !requestPairing) {
        this.socket = null;
        this.setStatus("pendiente_vinculacion");
        return;
      }

      const currentGeneration = ++this.generation;
      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        maxMsgRetryCount: 0,
        syncFullHistory: true,
        getMessage: async () => undefined
      });

      createdSocket = socket;
      this.socket = socket;
      this.setStatus(requestPairing ? "generando_codigo" : "conectando");

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("messages.upsert", ({ messages }) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        for (const message of messages || []) {
          this.captureMessageSafely(message);
        }
      });

      socket.ev.on("contacts.upsert", (contacts) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        this.captureContactsSafely(contacts);
      });

      socket.ev.on("contacts.update", (contacts) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        this.captureContactsSafely(contacts);
      });

      socket.ev.on("chats.phoneNumberShare", (mapping) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        this.capturePhoneNumberShareSafely(mapping);
      });

      socket.ev.on("groups.update", (groups) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        this.captureGroupsSafely(groups);
      });

      socket.ev.on("messaging-history.set", ({ messages, contacts }) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        this.captureContactsSafely(contacts);

        let processed = 0;
        for (const message of messages || []) {
          if (this.captureMessageSafely(message)) {
            processed += 1;
          }
        }

        if (processed > 0) {
          console.log(
            `[WA][${this.record.id}] Historial procesado: ${processed} mensaje(s).`
          );
        }
      });

      socket.ev.on("connection.update", async (update) => {
        if (currentGeneration !== this.generation) {
          return;
        }

        await this.handleConnectionUpdate(update, DisconnectReason);
      });

      if (requestPairing && !state.creds.registered) {
        await this.waitForPairingTransport(socket, currentGeneration);

        if (currentGeneration !== this.generation || this.socket !== socket) {
          throw createHttpError("La vinculacion fue cancelada", 409);
        }

        const code = await socket.requestPairingCode(this.record.numero);
        this.pairingCode = code;
        this.setStatus("esperando_vinculacion");
        console.log(
          `[WA][${this.record.id}] Codigo de vinculacion generado para ${this.record.numero}`
        );
      }
    } catch (error) {
      this.generation += 1;
      this.socket = null;
      this.setStatus("error", error);
      console.error(`[WA][${this.record.id}] Error al inicializar:`, error.message);

      if (createdSocket) {
        try {
          createdSocket.end(error);
        } catch {
          // The socket may already be closed.
        }
      }

      if (!requestPairing) {
        this.scheduleReconnect();
      } else if (!error.statusCode) {
        error.statusCode = 503;
      }

      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  waitForPairingTransport(socket, generation, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.ev.off("connection.update", onConnectionUpdate);
        callback(value);
      };

      const onConnectionUpdate = (update) => {
        if (generation !== this.generation || this.socket !== socket) {
          finish(
            reject,
            createHttpError("La vinculacion fue cancelada", 409)
          );
          return;
        }

        if (update.qr) {
          finish(resolve);
          return;
        }

        if (update.connection === "close") {
          const error =
            update.lastDisconnect?.error ||
            createHttpError("WhatsApp cerro la conexion", 503);
          finish(reject, error);
        }
      };

      const timer = setTimeout(() => {
        finish(
          reject,
          createHttpError(
            "WhatsApp no preparo la vinculacion dentro del tiempo esperado",
            503
          )
        );
      }, timeoutMs);

      socket.ev.on("connection.update", onConnectionUpdate);
    });
  }

  async handleConnectionUpdate(update, DisconnectReason) {
    const { connection, lastDisconnect } = update;

    if (connection === "connecting" && this.status !== "esperando_vinculacion") {
      this.setStatus("conectando");
    }

    if (connection === "open") {
      const connectedNumber = extractPhoneNumber(this.socket?.user?.id);

      if (!connectedNumber || connectedNumber !== this.record.numero) {
        const received = connectedNumber || "no identificado";
        const error = new Error(
          `Numero conectado ${received} no coincide con ${this.record.numero}`
        );

        this.connectedNumber = connectedNumber;
        this.pairingCode = null;
        this.setStatus("numero_incorrecto", error);
        console.error(`[WA][${this.record.id}] ${error.message}`);
        await this.rejectCurrentSession();
        return;
      }

      this.connectedNumber = connectedNumber;
      this.pairingCode = null;
      this.record.verifiedAt = new Date().toISOString();
      this.record.verifiedNumber = connectedNumber;
      this.setStatus("conectado");
      try {
        await this.manager.saveRegistry();
      } catch (error) {
        console.error(
          `[WA][${this.record.id}] No se pudo actualizar el registro de ` +
            `instancias, pero WhatsApp seguira conectado: ${error.message}`
        );
      }
      try {
        const groups = await this.getGroups();
        console.log(
          `[WA][${this.record.id}] Grupos sincronizados: ${groups.length}.`
        );
      } catch (error) {
        console.error(
          `[WA][${this.record.id}] No se pudieron sincronizar los grupos: ` +
            error.message
        );
      }
      console.log(`[WA][${this.record.id}] WhatsApp conectado y verificado.`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 401;

      this.socket = null;
      this.connectedNumber = null;
      this.pairingCode = null;

      if (this.status === "numero_incorrecto") {
        return;
      }

      if (loggedOut) {
        this.setStatus("pendiente_vinculacion");
        console.warn(`[WA][${this.record.id}] La sesion fue desvinculada.`);
        return;
      }

      this.setStatus("desconectado", lastDisconnect?.error);
      console.warn(`[WA][${this.record.id}] Conexion cerrada. Reintentando...`);
      this.scheduleReconnect();
    }
  }

  async rejectCurrentSession() {
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;

    if (!socket) {
      return;
    }

    try {
      await socket.logout("Numero de WhatsApp incorrecto");
    } catch {
      socket.end(new Error("Numero de WhatsApp incorrecto"));
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.status === "numero_incorrecto") {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.init();
      } catch {
        // init() already records the error and schedules the next attempt.
      }
    }, 5000);
  }

  async stop({ logout = false } = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.connectedNumber = null;
    this.pairingCode = null;

    if (!socket) {
      return;
    }

    try {
      if (logout) {
        await socket.logout("Desvinculacion solicitada desde mensajeria-service");
      } else {
        socket.end(undefined);
      }
    } catch (error) {
      console.warn(`[WA][${this.record.id}] Error cerrando socket: ${error.message}`);
    }
  }

  clearAuthFiles() {
    this.manager.assertSafeInstancePath(this.authDir);
    fs.mkdirSync(this.authDir, { recursive: true });

    for (const entry of fs.readdirSync(this.authDir)) {
      fs.rmSync(path.join(this.authDir, entry), {
        recursive: true,
        force: true
      });
    }
  }

  async startPairing() {
    if (this.status === "conectado") {
      throw createHttpError(
        `La instancia ${this.record.id} ya esta conectada`,
        409
      );
    }

    await this.stop({ logout: true });
    this.clearAuthFiles();
    this.setStatus("inicializando");
    await this.init({ requestPairing: true });

    if (!this.pairingCode) {
      throw createHttpError("No se pudo generar el codigo de vinculacion", 503);
    }

    return {
      instancia: this.record.id,
      numero: this.record.numero,
      codigo: this.pairingCode,
      estado: this.status
    };
  }

  ensureConnected() {
    if (
      !this.socket ||
      this.status !== "conectado" ||
      this.connectedNumber !== this.record.numero
    ) {
      throw createHttpError(
        `La instancia ${this.record.id} no esta conectada`,
        503
      );
    }
  }

  async getGroups() {
    this.ensureConnected();
    const grupos = await this.socket.groupFetchAllParticipating();
    const metadata = Object.values(grupos);
    this.captureGroupsSafely(metadata);
    return metadata
      .map((group) => ({
        id: group.id,
        groupId: group.id,
        nombre: group.subject || "Grupo sin nombre",
        descripcion: group.desc || "",
        participantes: group.participants?.length ?? group.size ?? 0,
        esComunidad: Boolean(group.isCommunity),
        soloAdministradores: Boolean(group.announce)
      }))
      .sort((left, right) => left.nombre.localeCompare(right.nombre));
  }

  async getGroupDetails(groupId) {
    this.ensureConnected();
    const normalizedGroupId = normalizeGroupId(groupId);
    const metadata = await this.socket.groupMetadata(normalizedGroupId);
    const rawMetadata = JSON.parse(JSON.stringify(metadata));
    this.captureGroupsSafely([rawMetadata]);

    return {
      groupId: rawMetadata.id,
      id: rawMetadata.id,
      nombre: rawMetadata.subject,
      descripcion: rawMetadata.desc || "",
      participantes:
        rawMetadata.participants?.length ?? rawMetadata.size ?? 0,
      creadoEn: unixTimestampToIso(rawMetadata.creation),
      nombreActualizadoEn: unixTimestampToIso(rawMetadata.subjectTime),
      descripcionActualizadaEn: unixTimestampToIso(rawMetadata.descTime),
      metadata: rawMetadata
    };
  }

  resolveJid(numero) {
    const value = String(numero || "").trim();

    if (value.endsWith("@g.us") || value.endsWith("@s.whatsapp.net")) {
      return value;
    }

    const digits = value.replace(/\D/g, "");
    if (digits.length > 15) {
      return `${digits}@g.us`;
    }

    return `${normalizeArMobileNumber(value)}@s.whatsapp.net`;
  }

  buildMessage(template, destino) {
    return template.replace(/\{nombre\}/g, destino.nombre || "");
  }

  captureMessageSafely(message, overrides = {}) {
    if (typeof this.manager.saveMessage !== "function") {
      return false;
    }

    try {
      return this.manager.saveMessage(this.record.id, message, overrides);
    } catch (error) {
      console.error(
        `[WA][${this.record.id}] No se pudo guardar el mensaje: ${error.message}`
      );
      return false;
    }
  }

  captureContactsSafely(contacts) {
    if (typeof this.manager.saveContacts !== "function") {
      return 0;
    }

    try {
      return this.manager.saveContacts(this.record.id, contacts);
    } catch (error) {
      console.error(
        `[WA][${this.record.id}] No se pudieron guardar los contactos: ${error.message}`
      );
      return 0;
    }
  }

  capturePhoneNumberShareSafely(mapping) {
    if (typeof this.manager.savePhoneNumberShare !== "function") {
      return false;
    }

    try {
      return this.manager.savePhoneNumberShare(this.record.id, mapping);
    } catch (error) {
      console.error(
        `[WA][${this.record.id}] No se pudo asociar el LID al teléfono: ${error.message}`
      );
      return false;
    }
  }

  captureGroupsSafely(groups) {
    if (typeof this.manager.saveGroups !== "function") {
      return 0;
    }

    try {
      return this.manager.saveGroups(this.record.id, groups);
    } catch (error) {
      console.error(
        `[WA][${this.record.id}] No se pudieron guardar los grupos: ${error.message}`
      );
      return 0;
    }
  }

  async resyncContacts() {
    this.ensureConnected();

    if (this.contactSyncPromise) {
      return this.contactSyncPromise;
    }

    this.contactSyncPromise = this.performContactResync().finally(() => {
      this.contactSyncPromise = null;
    });
    return this.contactSyncPromise;
  }

  async performContactResync() {
    const collection = "critical_unblock_low";
    const keys = this.authState?.keys;

    if (!keys || typeof this.socket?.resyncAppState !== "function") {
      throw createHttpError(
        "Baileys no tiene disponible la resincronizacion de contactos",
        503
      );
    }

    const previousState = (
      await keys.get("app-state-sync-version", [collection])
    )[collection];

    await keys.set({
      "app-state-sync-version": { [collection]: null }
    });

    try {
      await this.socket.resyncAppState([collection], true);
      if (typeof this.socket.ev?.flush === "function") {
        this.socket.ev.flush();
      }
    } catch (error) {
      await keys.set({
        "app-state-sync-version": { [collection]: previousState || null }
      });
      throw createHttpError(
        `WhatsApp no pudo resincronizar los contactos: ${error.message}`,
        503
      );
    }

    const stats = this.manager.getContactStats(this.record.id);
    console.log(
      `[WA][${this.record.id}] Contactos resincronizados: ` +
        `${stats.contactosConNombre}/${stats.contactos} con nombre.`
    );
    return {
      instancia: this.record.id,
      ...stats
    };
  }

  getMessagesToday() {
    return this.manager.getMessagesToday(this.record.id);
  }

  getMessages(options) {
    return this.manager.getMessages(this.record.id, options);
  }

  getStoredChats() {
    return this.manager.getStoredChats(this.record.id);
  }

  getCaptureConfiguration() {
    return this.manager.getCaptureConfiguration(this.record.id);
  }

  saveCaptureConfiguration(options) {
    return this.manager.saveCaptureConfiguration(this.record.id, options);
  }

  clearInbox() {
    return this.manager.clearInbox(this.record.id);
  }

  analyzeInbox(options) {
    return this.manager.analyzeInbox(this.record.id, options);
  }

  getInboxAnalystPrompt() {
    return this.manager.getInboxAnalystPrompt(this.record.id);
  }

  saveInboxAnalystPrompt(prompt) {
    return this.manager.saveInboxAnalystPrompt(this.record.id, prompt);
  }

  async deleteSentCopy(jid, sentMessage) {
    if (!sentMessage?.key?.id) {
      throw new Error("WhatsApp no devolvio la referencia del mensaje enviado");
    }

    const rawTimestamp = sentMessage.messageTimestamp;
    const timestamp =
      typeof rawTimestamp?.toNumber === "function"
        ? rawTimestamp.toNumber()
        : Number(rawTimestamp);

    await this.socket.chatModify(
      {
        deleteForMe: {
          deleteMedia: false,
          key: {
            ...sentMessage.key,
            remoteJid: sentMessage.key.remoteJid || jid,
            fromMe: true
          },
          timestamp:
            Number.isFinite(timestamp) && timestamp > 0
              ? timestamp
              : Math.floor(Date.now() / 1000)
        }
      },
      jid
    );
  }

  async sendBatch({
    destinos,
    mensaje,
    pausa = 3500,
    eliminarCopia = false
  }) {
    this.ensureConnected();
    const resultados = [];

    for (let index = 0; index < destinos.length; index += 1) {
      const destino = destinos[index];
      const isLast = index === destinos.length - 1;

      try {
        const jid = this.resolveJid(destino.numero);
        const texto = this.buildMessage(mensaje, destino);
        const sentMessage = await this.socket.sendMessage(jid, { text: texto });
        this.captureMessageSafely(sentMessage, {
          direction: "enviado",
          remoteJid: jid,
          text: texto
        });
        const resultado = {
          numero: jid,
          nombre: destino.nombre || "",
          estado: "enviado"
        };

        console.log(`[WA][${this.record.id}] Enviado a ${jid}`);

        if (eliminarCopia) {
          try {
            await this.deleteSentCopy(jid, sentMessage);
            resultado.copiaEliminada = true;
            console.log(
              `[WA][${this.record.id}] Copia local eliminada para ${jid}`
            );
          } catch (deleteError) {
            resultado.copiaEliminada = false;
            resultado.detalleEliminacion = deleteError.message;
            console.warn(
              `[WA][${this.record.id}] Mensaje enviado a ${jid}, pero no se pudo eliminar la copia local: ${deleteError.message}`
            );
          }
        }

        resultados.push(resultado);
      } catch (error) {
        resultados.push({
          numero: String(destino.numero || ""),
          nombre: destino.nombre || "",
          estado: "error",
          detalle: error.message
        });

        console.error(
          `[WA][${this.record.id}] Error enviando a ${String(
            destino.numero || ""
          )}: ${error.message}`
        );
      }

      if (!isLast) {
        await delay(pausa);
      }
    }

    const enviados = resultados.filter((item) => item.estado === "enviado").length;
    const copiasEliminadas = resultados.filter(
      (item) => item.copiaEliminada === true
    ).length;
    const erroresEliminacion = resultados.filter(
      (item) => item.copiaEliminada === false
    ).length;

    return {
      ok: true,
      canal: "whatsapp",
      instancia: this.record.id,
      enviados,
      errores: resultados.length - enviados,
      ...(eliminarCopia ? { copiasEliminadas, erroresEliminacion } : {}),
      resultados
    };
  }

  enqueueBatch(payload) {
    const jobId = `wa-${this.record.id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const job = {
      jobId,
      instancia: this.record.id,
      estado: "pendiente"
    };

    this.jobs.set(jobId, job);

    setImmediate(async () => {
      job.estado = "procesando";

      try {
        job.resultado = await this.sendBatch(payload);
        job.estado = "finalizado";
      } catch (error) {
        job.estado = "error";
        job.error = error.message;
      }
    });

    return job;
  }
}

class WhatsAppManager {
  constructor(options = {}) {
    this.instancesDir =
      options.instancesDir ||
      path.join(__dirname, "..", "wa_instances");
    this.dataFile =
      options.dataFile ||
      path.join(__dirname, "..", "data", "whatsapp-instances.json");
    this.instances = new Map();
    this.records = [];
    this.initialized = false;
    this.dependencies = null;
    this.writeChain = Promise.resolve();
    this.messagesDbFile =
      options.messagesDbFile ||
      path.join(__dirname, "..", "data", "whatsapp-messages.sqlite");
    this.messageStore = options.messageStore || null;
    this.cleanupIntervalMs =
      options.cleanupIntervalMs || 24 * 60 * 60 * 1000;
    this.cleanupTimer = null;
    this.cleanupInitialized = false;
    this.inboxAnalysisService =
      options.inboxAnalysisService || whatsappInboxAnalysisService;
  }

  getMessageStore() {
    if (!this.messageStore) {
      this.messageStore = new WhatsAppMessageStore({
        databaseFile: this.messagesDbFile
      });
    }

    if (!this.cleanupInitialized) {
      this.cleanupInitialized = true;
      this.runRetentionCleanup();
    }

    return this.messageStore;
  }

  runRetentionCleanup() {
    if (!this.messageStore) {
      return { mensajesEliminados: 0, instancias: [] };
    }
    const result = this.messageStore.deleteExpiredMessages();
    if (result.mensajesEliminados > 0) {
      console.log(
        `[WA][MULTI] Limpieza de retencion: ` +
          `${result.mensajesEliminados} mensaje(s) eliminado(s).`
      );
    }
    return result;
  }

  startRetentionCleanup() {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      try {
        this.runRetentionCleanup();
      } catch (error) {
        console.error(
          `[WA][MULTI] Error en limpieza de retencion: ${error.message}`
        );
      }
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  saveMessage(instanceId, message, overrides) {
    return this.getMessageStore().saveMessage(instanceId, message, overrides);
  }

  saveContacts(instanceId, contacts) {
    return this.getMessageStore().saveContacts(instanceId, contacts);
  }

  savePhoneNumberShare(instanceId, mapping) {
    return this.getMessageStore().savePhoneNumberShare(instanceId, mapping);
  }

  saveGroups(instanceId, groups) {
    return this.getMessageStore().saveGroups(instanceId, groups);
  }

  getContactStats(instanceId) {
    return this.getMessageStore().getContactStats(instanceId);
  }

  getMessagesToday(instanceId, options) {
    return this.getMessageStore().getMessagesToday(instanceId, options);
  }

  getMessages(instanceId, options) {
    return this.getMessageStore().getMessages(instanceId, options);
  }

  getStoredChats(instanceId) {
    return this.getMessageStore().getCaptureTargets(instanceId);
  }

  getCaptureConfiguration(instanceId) {
    return {
      instancia: instanceId,
      ...this.getMessageStore().getCaptureSettings(instanceId),
      destinos: this.getMessageStore().getCaptureTargets(instanceId)
    };
  }

  saveCaptureConfiguration(instanceId, options = {}) {
    return {
      instancia: instanceId,
      ...this.getMessageStore().saveCaptureSettings(
        instanceId,
        options.modo,
        options.seleccionados,
        options.retencionDias
      )
    };
  }

  clearInbox(instanceId) {
    return this.getMessageStore().clearInbox(instanceId);
  }

  async analyzeInbox(instanceId, options) {
    const report = this.getMessages(instanceId, options);
    const analysis = await this.inboxAnalysisService.analyze(report, {
      model: options?.model,
      prompt: this.getMessageStore().getAnalystPrompt(instanceId) || DEFAULT_ANALYST_PROMPT
    });
    const chatByNumber = new Map(
      report.conversaciones.map((conversation) => [conversation.numero, conversation.chat])
    );
    this.getMessageStore().saveConversationLabels(
      instanceId,
      analysis.tipificaciones.map((label) => ({
        ...label,
        chat: chatByNumber.get(label.numero)
      })),
      analysis.generadoEn
    );
    return analysis;
  }

  getInboxAnalystPrompt(instanceId) {
    return {
      prompt: this.getMessageStore().getAnalystPrompt(instanceId) || DEFAULT_ANALYST_PROMPT
    };
  }

  saveInboxAnalystPrompt(instanceId, prompt) {
    const normalized = typeof prompt === "string" ? prompt.trim() : "";
    if (!normalized) {
      throw createHttpError("El prompt del analista no puede estar vacío", 400);
    }
    const updatedAt = this.getMessageStore().saveAnalystPrompt(instanceId, normalized);
    return { prompt: normalized, actualizadoEn: updatedAt };
  }

  listAiModels() {
    return this.inboxAnalysisService.listModels();
  }

  async loadDependencies() {
    if (this.dependencies) {
      return this.dependencies;
    }

    const [pinoModule, baileys] = await Promise.all([
      import("pino"),
      import("@whiskeysockets/baileys")
    ]);
    const pino = pinoModule.default;
    const { version } = await baileys.fetchLatestBaileysVersion();

    this.dependencies = {
      makeWASocket: baileys.default,
      useMultiFileAuthState: baileys.useMultiFileAuthState,
      DisconnectReason: baileys.DisconnectReason,
      version,
      logger: pino({
        level: process.env.LOG_LEVEL || "silent"
      })
    };

    console.log(`[WA][MULTI] Usando Baileys ${version.join(".")}`);
    return this.dependencies;
  }

  assertSafeInstancePath(targetPath) {
    const root = `${path.resolve(this.instancesDir)}${path.sep}`;
    const resolved = path.resolve(targetPath);

    if (!resolved.startsWith(root)) {
      throw new Error("Ruta de instancia insegura");
    }
  }

  loadRegistry() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.mkdirSync(this.instancesDir, { recursive: true });

    if (!fs.existsSync(this.dataFile)) {
      this.records = [];
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
    const records = Array.isArray(parsed) ? parsed : parsed.instancias;

    if (!Array.isArray(records)) {
      throw new Error("Registro de instancias de WhatsApp invalido");
    }

    this.records = records.map((record) => ({
      id: normalizeInstanceId(record.id || record.nombre),
      nombre: normalizeInstanceId(record.nombre || record.id),
      numero: normalizeAccountNumber(record.numero),
      createdAt: record.createdAt || new Date().toISOString(),
      verifiedAt: record.verifiedAt || null,
      verifiedNumber: record.verifiedNumber || null
    }));
  }

  async init() {
    if (this.initialized) {
      return;
    }

    this.loadRegistry();

    const instancesToInitialize = [];

    for (const record of this.records) {
      const instance = new WhatsAppInstance(this, record);
      this.instances.set(record.id, instance);
      instancesToInitialize.push(instance);
    }

    for (const instance of instancesToInitialize) {
      try {
        await instance.init();
      } catch {
        // Each instance exposes its own initialization error.
      }
    }

    this.startRetentionCleanup();
    this.initialized = true;
    console.log(`[WA][MULTI] ${this.instances.size} instancia(s) cargada(s).`);
  }

  saveRegistry() {
    const payload = JSON.stringify(
      {
        version: 1,
        instancias: this.records
      },
      null,
      2
    );

    this.writeChain = this.writeChain
      .catch(() => {
        // Una escritura fallida no debe impedir todos los guardados siguientes.
      })
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.dataFile), {
          recursive: true
        });
        const temporaryFile =
          `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(temporaryFile, `${payload}\n`, "utf8");
        await replaceFile(temporaryFile, this.dataFile);
      });

    return this.writeChain;
  }

  listInstances() {
    return [...this.instances.values()]
      .map((instance) => instance.toJSON())
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getInstance(id) {
    let normalizedId;

    try {
      normalizedId = normalizeInstanceId(id);
    } catch {
      return null;
    }

    return this.instances.get(normalizedId) || null;
  }

  requireInstance(id) {
    const normalizedId = normalizeInstanceId(id);
    const instance = this.instances.get(normalizedId);

    if (!instance) {
      throw createHttpError(`La instancia ${normalizedId} no existe`, 404);
    }

    return instance;
  }

  async createInstance({ nombre, numero }) {
    const id = normalizeInstanceId(nombre);
    const normalizedNumber = normalizeAccountNumber(numero);

    if (this.instances.has(id)) {
      throw createHttpError(`La instancia ${id} ya existe`, 409);
    }

    const duplicateNumber = this.records.find(
      (record) => record.numero === normalizedNumber
    );

    if (duplicateNumber) {
      throw createHttpError(
        `El numero ya pertenece a la instancia ${duplicateNumber.id}`,
        409
      );
    }

    const record = {
      id,
      nombre: id,
      numero: normalizedNumber,
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      verifiedNumber: null
    };
    const instance = new WhatsAppInstance(this, record);

    this.records.push(record);
    this.instances.set(id, instance);
    await this.saveRegistry();

    return instance;
  }

  async deleteInstance(id) {
    const instance = this.requireInstance(id);
    await instance.stop({ logout: true });

    this.assertSafeInstancePath(instance.rootDir);
    if (fs.existsSync(instance.rootDir)) {
      fs.rmSync(instance.rootDir, { recursive: true, force: true });
    }

    this.instances.delete(instance.record.id);
    this.records = this.records.filter(
      (record) => record.id !== instance.record.id
    );
    await this.saveRegistry();
  }
}

const whatsappManager = new WhatsAppManager();

module.exports = whatsappManager;
module.exports.WhatsAppManager = WhatsAppManager;
module.exports.WhatsAppInstance = WhatsAppInstance;
module.exports.normalizeInstanceId = normalizeInstanceId;
module.exports.normalizeAccountNumber = normalizeAccountNumber;
module.exports.extractPhoneNumber = extractPhoneNumber;
module.exports.normalizeGroupId = normalizeGroupId;
module.exports.unixTimestampToIso = unixTimestampToIso;
module.exports.replaceFile = replaceFile;
