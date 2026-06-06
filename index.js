const path = require("path");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const healthRoutes = require("./routes/health");
const whatsappRoutes = require("./routes/whatsapp");
const telegramRoutes = require("./routes/telegram");
const whatsappService = require("./services/whatsappService");
const telegramService = require("./services/telegramService");

const app = express();
const PORT = Number(process.env.PORT) || 3001;

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
        whatsapp: whatsappService.getStatus().estado,
        telegram: await telegramService.getStatus()
      },
      endpoints: {
        health: "/health",
        whatsapp: {
          estado: "/whatsapp/estado",
          qr: "/whatsapp/qr",
          login: "/whatsapp/login",
          enviarSync: "/whatsapp/enviar-sync",
          enviar: "/whatsapp/enviar",
          grupos: "/whatsapp/grupos"
        },
        telegram: {
          estado: "/telegram/estado",
          enviarSync: "/telegram/enviar-sync"
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

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada"
  });
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  const message = error.message || "Error interno del servidor";

  console.error("[ERROR]", message);
  if (process.env.NODE_ENV !== "production" && error.stack) {
    console.error(error.stack);
  }

  res.status(statusCode).json({
    ok: false,
    error: message
  });
});

async function start() {
  try {
    console.log("[BOOT] Iniciando mensajeria-service...");
    app.listen(PORT, () => {
      console.log(`[BOOT] Servicio activo en http://localhost:${PORT}`);
    });

    whatsappService.init().catch((error) => {
      console.error("[BOOT] Error inicializando WhatsApp:", error.message);
    });

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
