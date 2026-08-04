const express = require("express");
const path = require("path");
const telegramService = require("../services/telegramService");

const router = express.Router();

function validatePayload(body) {
  const { destinos, mensaje, pausa } = body;

  if (!Array.isArray(destinos) || destinos.length === 0) {
    const error = new Error("destinos debe ser un array no vacio");
    error.statusCode = 400;
    throw error;
  }

  if (typeof mensaje !== "string" || !mensaje.trim()) {
    const error = new Error("mensaje debe ser un string no vacio");
    error.statusCode = 400;
    throw error;
  }

  if (pausa !== undefined && (!Number.isFinite(Number(pausa)) || Number(pausa) < 0)) {
    const error = new Error("pausa debe ser un numero mayor o igual a 0");
    error.statusCode = 400;
    throw error;
  }
}

router.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "telegram-admin.html"));
});

router.get("/estado", async (req, res, next) => {
  try {
    const status = await telegramService.getStatus();
    res.json({
      ok: true,
      ...status
    });
  } catch (error) {
    next(error);
  }
});


router.post("/enviar-sync", async (req, res, next) => {
  try {
    validatePayload(req.body);

    const result = await telegramService.sendBatch({
      destinos: req.body.destinos,
      mensaje: req.body.mensaje,
      pausa: Number(req.body.pausa) || 1000
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
