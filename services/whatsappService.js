const fs = require("fs");
const path = require("path");

const { normalizeArMobileNumber } = require("../utils/phone");
const { delay } = require("../utils/delay");

class WhatsAppService {
  constructor() {
    this.socket = null;
    this.status = "desconectado";
    this.qrCode = null;
    this.authDir = path.join(__dirname, "..", "wa_auth");
    this.jobs = new Map();
    this.isInitializing = false;
    this.reconnectTimer = null;
    this.baileys = null;
    this.pino = null;
    this.qrcode = null;
    this.logger = null;
  }

  async loadDependencies() {
    if (!this.pino) {
      const pinoModule = await import("pino");
      this.pino = pinoModule.default;
    }

    if (!this.qrcode) {
      const qrcodeModule = await import("qrcode");
      this.qrcode = qrcodeModule.default || qrcodeModule;
    }

    if (!this.baileys) {
      const baileys = await import("@whiskeysockets/baileys");
      this.baileys = {
        makeWASocket: baileys.default,
        useMultiFileAuthState: baileys.useMultiFileAuthState,
        fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
        DisconnectReason: baileys.DisconnectReason
      };
    }

    if (!this.logger) {
      this.logger = this.pino({
        level: process.env.LOG_LEVEL || "silent"
      });
    }

    return {
      ...this.baileys,
      QRCode: this.qrcode
    };
  }

  async init() {
    if (this.isInitializing || this.socket) {
      return;
    }

    this.isInitializing = true;
    this.status = "conectando";
    fs.mkdirSync(this.authDir, { recursive: true });

    try {
      const {
        makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason,
        QRCode
      } = await this.loadDependencies();

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      console.log(`[WA] Inicializando Baileys ${version.join(".")}`);

      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: this.logger,
        // Prevents retry receipt loops and session-error spam from other devices.
        maxMsgRetryCount: 0,
        getMessage: async () => undefined
      });

      this.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          this.status = "qr";
          this.qrCode = await QRCode.toDataURL(qr);
          console.log("[WA] QR generado. Entrá a /whatsapp/login para escanearlo.");
        }

        if (connection === "connecting") {
          this.status = "conectando";
          console.log("[WA] Conectando con WhatsApp...");
        }

        if (connection === "open") {
          this.status = "conectado";
          this.qrCode = null;
          console.log("[WA] WhatsApp conectado.");
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut =
            statusCode === DisconnectReason.loggedOut || statusCode === 401;

          this.socket = null;
          this.status = "desconectado";
          this.qrCode = null;

          if (loggedOut) {
            console.warn("[WA] La sesion se cerro. Hay que volver a escanear QR.");
            return;
          }

          console.warn("[WA] Conexion cerrada. Reintentando en 5 segundos...");
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      this.socket = null;
      this.status = "desconectado";
      console.error("[WA] Error al inicializar:", error.message);
      this.scheduleReconnect();
    } finally {
      this.isInitializing = false;
    }
  }

  async reset() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.socket = null;
    this.status = "desconectado";
    this.qrCode = null;
    this.isInitializing = false;

    if (fs.existsSync(this.authDir)) {
      for (const file of fs.readdirSync(this.authDir)) {
        if (file !== ".gitkeep") {
          fs.rmSync(path.join(this.authDir, file), { recursive: true, force: true });
        }
      }
    }

    console.log("[WA] Sesion borrada. Reiniciando para generar nuevo QR...");
    await this.init();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.init();
    }, 5000);
  }

  getStatus() {
    return {
      estado: this.status
    };
  }

  getQrCode() {
    return this.qrCode;
  }

  ensureConnected() {
    if (!this.socket || this.status !== "conectado") {
      const error = new Error(
        "WhatsApp no esta conectado. Revisá /whatsapp/estado o /whatsapp/login"
      );
      error.statusCode = 503;
      throw error;
    }
  }

  async getGroups() {
    this.ensureConnected();
    const grupos = await this.socket.groupFetchAllParticipating();
    return Object.values(grupos).map((g) => ({
      id: g.id,
      nombre: g.subject,
      participantes: g.participants?.length ?? 0
    }));
  }

  resolveJid(numero) {
    const s = String(numero || "").trim();
    if (s.endsWith("@g.us") || s.endsWith("@s.whatsapp.net")) {
      return s;
    }
    const digits = s.replace(/\D/g, "");
    // Group JIDs are 18 digits; phone numbers max out at 15 (E.164)
    if (digits.length > 15) {
      return `${digits}@g.us`;
    }
    return `${normalizeArMobileNumber(s)}@s.whatsapp.net`;
  }

  buildMessage(template, destino) {
    return template.replace(/\{nombre\}/g, destino.nombre || "");
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
        const resultado = {
          numero: jid,
          nombre: destino.nombre || "",
          estado: "enviado"
        };

        console.log(`[WA] Enviado a ${jid}`);

        if (eliminarCopia) {
          try {
            await this.deleteSentCopy(jid, sentMessage);
            resultado.copiaEliminada = true;
            console.log(`[WA] Copia local eliminada para ${jid}`);
          } catch (deleteError) {
            resultado.copiaEliminada = false;
            resultado.detalleEliminacion = deleteError.message;
            console.warn(
              `[WA] Mensaje enviado a ${jid}, pero no se pudo eliminar la copia local: ${deleteError.message}`
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
          `[WA] Error enviando a ${String(destino.numero || "")}: ${error.message}`
        );
      }

      if (!isLast) {
        await delay(pausa);
      }
    }

    const enviados = resultados.filter((item) => item.estado === "enviado").length;
    const errores = resultados.length - enviados;
    const copiasEliminadas = resultados.filter(
      (item) => item.copiaEliminada === true
    ).length;
    const erroresEliminacion = resultados.filter(
      (item) => item.copiaEliminada === false
    ).length;

    return {
      ok: true,
      canal: "whatsapp",
      enviados,
      errores,
      ...(eliminarCopia ? { copiasEliminadas, erroresEliminacion } : {}),
      resultados
    };
  }

  enqueueBatch(payload) {
    const jobId = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      estado: "pendiente"
    };

    this.jobs.set(jobId, job);

    setImmediate(async () => {
      job.estado = "procesando";
      console.log(`[WA][JOB ${jobId}] Procesando lote...`);

      try {
        const result = await this.sendBatch(payload);
        job.estado = "finalizado";
        job.resultado = result;
        console.log(
          `[WA][JOB ${jobId}] Finalizado. Enviados=${result.enviados}, Errores=${result.errores}`
        );
      } catch (error) {
        job.estado = "error";
        job.error = error.message;
        console.error(`[WA][JOB ${jobId}] Error: ${error.message}`);
      }
    });

    return job;
  }
}

module.exports = new WhatsAppService();
