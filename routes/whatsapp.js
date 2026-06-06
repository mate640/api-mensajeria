const path = require("path");
const express = require("express");
const whatsappService = require("../services/whatsappService");

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

router.get("/estado", (req, res) => {
  res.json({
    ok: true,
    estado: whatsappService.getStatus().estado
  });
});

router.get("/qr", (req, res) => {
  const status = whatsappService.getStatus();
  const qr = whatsappService.getQrCode();

  if (status.estado === "conectado") {
    return res.json({
      ok: true,
      conectado: true
    });
  }

  if (!qr) {
    return res.json({
      ok: false,
      mensaje: "QR aun no disponible"
    });
  }

  return res.json({
    ok: true,
    qr
  });
});

router.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "wa-login.html"));
});

router.get("/grupos", async (req, res, next) => {
  try {
    const grupos = await whatsappService.getGroups();
    res.json({ ok: true, grupos });
  } catch (error) {
    next(error);
  }
});

router.get("/reconectar", async (req, res, next) => {
  try {
    await whatsappService.reset();
    res.redirect("/whatsapp/login");
  } catch (error) {
    next(error);
  }
});

router.post("/enviar-sync", async (req, res, next) => {
  try {
    validatePayload(req.body);

    const result = await whatsappService.sendBatch({
      destinos: req.body.destinos,
      mensaje: req.body.mensaje,
      pausa: Number(req.body.pausa) || 3500
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/enviar", async (req, res, next) => {
  try {
    validatePayload(req.body);

    const job = whatsappService.enqueueBatch({
      destinos: req.body.destinos,
      mensaje: req.body.mensaje,
      pausa: Number(req.body.pausa) || 3500
    });

    res.status(202).json({
      ok: true,
      canal: "whatsapp",
      procesando: true,
      jobId: job.jobId,
      estado: job.estado
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
