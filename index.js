const path = require("path");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const healthRoutes = require("./routes/health");
const whatsappRoutes = require("./routes/whatsapp");
const telegramRoutes = require("./routes/telegram");
const gmailRoutes = require("./routes/gmail");
const iaRoutes = require("./routes/ia");
const whatsappService = require("./services/whatsappService");
const whatsappManager = require("./services/whatsappManager");
const telegramService = require("./services/telegramService");
const { gmailService } = require("./services/gmailService");

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const multiInstanceEnabled =
  String(process.env.WHATSAPP_MULTI_INSTANCE_ENABLED).toLowerCase() === "true";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
});

app.get("/", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      service: "mensajeria-service",
      estado: {
        whatsapp: multiInstanceEnabled
          ? whatsappManager.listInstances()
          : whatsappService.getStatus().estado,
        telegram: await telegramService.getStatus(),
        gmail: gmailService.getStatus()
      },
      endpoints: {
        health: "/health",
        whatsapp: {
          estado: "/whatsapp/estado",
          qr: "/whatsapp/qr",
          login: "/whatsapp/login",
          enviarSync: "/whatsapp/enviar-sync",
          enviar: "/whatsapp/enviar",
          grupos: "/whatsapp/grupos",
          mensajesHoy:
            "/whatsapp/instancias/:id/mensajes-hoy",
          modelosIa: "/whatsapp/modelos-ia",
          analizarBandeja:
            "/whatsapp/instancias/:id/analizar-bandeja",
          promptAnalista:
            "/whatsapp/instancias/:id/prompt-analista"
        },
        telegram: {
          estado: "/telegram/estado",
          enviarSync: "/telegram/enviar-sync"
        },
        gmail: {
          estado: "/gmail/estado",
          panel: "/gmail/panel",
          cuentas: "/gmail/cuentas",
          iniciarOAuth:
            "/gmail/oauth/iniciar?identificacion=VENTAS",
          enviar: "/gmail/enviar"
        },
        ia: {
          estado: "/ia/estado",
          panel: "/ia/panel",
          catalogo: "/ia/catalogo",
          modelos: "/ia/modelos",
          prompts: "/ia/prompts",
          procesar: "/ia/procesar",
          cerrarChat: "/ia/chats/:chatId",
          catalogos: "/ia/catalogos",
          catalogoPredeterminado: "/ia/catalogos/predeterminado",
          fileSearchStores: "/ia/file-search/stores",
          fileSearchDocumentos:
            "/ia/file-search/stores/:storeId/documentos"
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use("/health", healthRoutes);
app.use("/whatsapp", whatsappRoutes);
app.use("/telegram", telegramRoutes);
app.use("/gmail", gmailRoutes);
app.use("/ia", iaRoutes);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada"
  });
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  const message = error.message || "Error interno del servidor";
  const errorCode = error.code || "ERROR_INTERNO";
  const expectedError =
    statusCode < 500 || error.isOperational === true;

  if (expectedError) {
    console.warn(`[WARN] ${errorCode}: ${message}`);
  } else {
    console.error(`[ERROR] ${errorCode}: ${message}`);
    if (process.env.NODE_ENV !== "production" && error.stack) {
      console.error(error.stack);
    }
  }

  const responseBody = {
    ok: false,
    error: message,
    codigo: errorCode
  };
  if (error.geminiResponse !== undefined) {
    responseBody.gemini = error.geminiResponse;
  }
  if (Array.isArray(error.modelosIntentados)) {
    responseBody.modelosIntentados = error.modelosIntentados;
  }

  res.status(statusCode).json(responseBody);
});

async function start() {
  try {
    console.log("[BOOT] Iniciando mensajeria-service...");
    app.listen(PORT, () => {
      console.log(`[BOOT] Servicio activo en http://localhost:${PORT}`);
    });

    if (multiInstanceEnabled) {
      whatsappManager.init().catch((error) => {
        console.error(
          "[BOOT] Error inicializando WhatsApp multi-instancia:",
          error.message
        );
      });
    } else {
      whatsappService.init().catch((error) => {
        console.error("[BOOT] Error inicializando WhatsApp:", error.message);
      });
    }

    telegramService.init().catch((error) => {
      console.error("[BOOT] Error inicializando Telegram:", error.message);
    });
  } catch (error) {
    console.error("[BOOT] No se pudo iniciar el servicio");
    console.error(error);
    process.exit(1);
  }
}

start();
