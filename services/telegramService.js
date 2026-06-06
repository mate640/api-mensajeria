const { delay } = require("../utils/delay");

class TelegramService {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN || "";
    this.bot = null;
    this.botInfo = null;
    this.Bot = null;
  }

  async loadGrammy() {
    if (this.Bot) {
      return this.Bot;
    }

    const grammy = await import("grammy");
    this.Bot = grammy.Bot;
    return this.Bot;
  }

  async init() {
    if (!this.token) {
      console.warn("[TG] TELEGRAM_BOT_TOKEN no configurado.");
      return;
    }

    if (this.bot) {
      return;
    }

    const Bot = await this.loadGrammy();
    this.bot = new Bot(this.token);

    try {
      this.botInfo = await this.bot.api.getMe();
      console.log(`[TG] Bot listo: @${this.botInfo.username}`);
    } catch (error) {
      console.error("[TG] No se pudo validar el bot:", error.message);
    }
  }

  async getStatus() {
    if (!this.token) {
      return {
        configurado: false,
        estado: "no_configurado"
      };
    }

    if (!this.bot) {
      await this.init();
    }

    if (this.botInfo) {
      return {
        configurado: true,
        estado: "configurado",
        bot: this.botInfo.username
      };
    }

    try {
      this.botInfo = await this.bot.api.getMe();

      return {
        configurado: true,
        estado: "configurado",
        bot: this.botInfo.username
      };
    } catch (error) {
      return {
        configurado: false,
        estado: "error_configuracion",
        detalle: error.message
      };
    }
  }

  ensureReady() {
    if (!this.token || !this.bot) {
      const error = new Error("Telegram no esta configurado correctamente");
      error.statusCode = 503;
      throw error;
    }
  }

  buildMessage(template, destino) {
    return template.replace(/\{nombre\}/g, destino.nombre || "");
  }

  async sendBatch({ destinos, mensaje, pausa = 1000 }) {
    await this.init();
    this.ensureReady();

    const resultados = [];

    for (let index = 0; index < destinos.length; index += 1) {
      const destino = destinos[index];
      const isLast = index === destinos.length - 1;
      const chatId = String(destino.chatId || "").trim();

      if (!chatId) {
        resultados.push({
          chatId: "",
          nombre: destino.nombre || "",
          estado: "error",
          detalle: "chatId es obligatorio"
        });
      } else {
        try {
          await this.bot.api.sendMessage(chatId, this.buildMessage(mensaje, destino));
          resultados.push({
            chatId,
            nombre: destino.nombre || "",
            estado: "enviado"
          });
          console.log(`[TG] Enviado a chat ${chatId}`);
        } catch (error) {
          resultados.push({
            chatId,
            nombre: destino.nombre || "",
            estado: "error",
            detalle: error.message
          });
          console.error(`[TG] Error enviando a ${chatId}: ${error.message}`);
        }
      }

      if (!isLast) {
        await delay(pausa);
      }
    }

    const enviados = resultados.filter((item) => item.estado === "enviado").length;
    const errores = resultados.length - enviados;

    return {
      ok: true,
      canal: "telegram",
      enviados,
      errores,
      resultados
    };
  }
}

module.exports = new TelegramService();
