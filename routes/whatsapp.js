const path = require("path");
const express = require("express");
const whatsappService = require("../services/whatsappService");
const whatsappManager = require("../services/whatsappManager");

const router = express.Router();
const multiInstanceEnabled =
  String(process.env.WHATSAPP_MULTI_INSTANCE_ENABLED).toLowerCase() === "true";

function validatePayload(body) {
  const { destinos, mensaje, pausa, eliminarCopia } = body;

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

  if (
    eliminarCopia !== undefined &&
    typeof eliminarCopia !== "boolean"
  ) {
    const error = new Error("eliminarCopia debe ser true o false");
    error.statusCode = 400;
    throw error;
  }
}

function requireMultiInstanceMode(req, res, next) {
  if (!multiInstanceEnabled) {
    const error = new Error(
      "El modo multi-instancia de WhatsApp todavia no esta habilitado"
    );
    error.statusCode = 409;
    return next(error);
  }

  next();
}

function requireInstanceName(body) {
  if (typeof body.instancia !== "string" || !body.instancia.trim()) {
    const error = new Error("instancia es obligatoria");
    error.statusCode = 400;
    throw error;
  }

  return body.instancia;
}

function getPause(body) {
  return body.pausa === undefined ? 3500 : Number(body.pausa);
}

function getSendPayload(body) {
  return {
    destinos: body.destinos,
    mensaje: body.mensaje,
    pausa: getPause(body),
    eliminarCopia: body.eliminarCopia === true
  };
}

router.get("/modo", (req, res) => {
  res.json({
    ok: true,
    modo: multiInstanceEnabled ? "multi" : "legacy",
    multiInstanciaHabilitada: multiInstanceEnabled
  });
});

router.get("/estado", (req, res) => {
  if (multiInstanceEnabled) {
    if (req.query.instancia) {
      const instance = whatsappManager.requireInstance(req.query.instancia);
      return res.json({
        ok: true,
        instancia: instance.toJSON()
      });
    }

    return res.json({
      ok: true,
      modo: "multi",
      instancias: whatsappManager.listInstances()
    });
  }

  res.json({
    ok: true,
    estado: whatsappService.getStatus().estado
  });
});

router.get("/qr", (req, res) => {
  if (multiInstanceEnabled) {
    return res.status(410).json({
      ok: false,
      error:
        "El modo multi-instancia no usa QR. Vincula cada numero desde /whatsapp/panel"
    });
  }

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
  if (multiInstanceEnabled) {
    return res.redirect("/whatsapp/panel");
  }

  res.sendFile(path.join(__dirname, "..", "public", "wa-login.html"));
});

router.get("/grupos", async (req, res, next) => {
  try {
    if (multiInstanceEnabled) {
      if (!req.query.instancia) {
        const error = new Error("instancia es obligatoria");
        error.statusCode = 400;
        throw error;
      }

      const instance = whatsappManager.requireInstance(req.query.instancia);
      const grupos = await instance.getGroups();
      return res.json({
        ok: true,
        instancia: instance.record.id,
        grupos
      });
    }

    const grupos = await whatsappService.getGroups();
    res.json({ ok: true, grupos });
  } catch (error) {
    next(error);
  }
});

router.get("/reconectar", async (req, res, next) => {
  try {
    if (multiInstanceEnabled) {
      const error = new Error(
        "Indica la instancia desde el panel para volver a vincularla"
      );
      error.statusCode = 410;
      throw error;
    }

    await whatsappService.reset();
    res.redirect("/whatsapp/login");
  } catch (error) {
    next(error);
  }
});

router.post("/enviar-sync", async (req, res, next) => {
  try {
    validatePayload(req.body);

    if (multiInstanceEnabled) {
      const instanceName = requireInstanceName(req.body);
      const instance = whatsappManager.requireInstance(instanceName);
      const result = await instance.sendBatch(getSendPayload(req.body));

      return res.json(result);
    }

    const result = await whatsappService.sendBatch(getSendPayload(req.body));

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/enviar", async (req, res, next) => {
  try {
    validatePayload(req.body);

    if (multiInstanceEnabled) {
      const instanceName = requireInstanceName(req.body);
      const instance = whatsappManager.requireInstance(instanceName);
      instance.ensureConnected();

      const job = instance.enqueueBatch(getSendPayload(req.body));

      return res.status(202).json({
        ok: true,
        canal: "whatsapp",
        instancia: instance.record.id,
        procesando: true,
        jobId: job.jobId,
        estado: job.estado
      });
    }

    const job = whatsappService.enqueueBatch(getSendPayload(req.body));

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

router.get("/panel", (req, res) => {
  res.sendFile(
    path.join(__dirname, "..", "public", "wa-instances.html")
  );
});

router.get("/instancias", (req, res) => {
  res.json({
    ok: true,
    modo: multiInstanceEnabled ? "multi" : "legacy",
    habilitado: multiInstanceEnabled,
    instancias: multiInstanceEnabled ? whatsappManager.listInstances() : []
  });
});

router.get(
  "/modelos-ia",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      res.json({
        ok: true,
        ...(await whatsappManager.listAiModels())
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = await whatsappManager.createInstance({
        nombre: req.body.nombre,
        numero: req.body.numero
      });

      res.status(201).json({
        ok: true,
        instancia: instance.toJSON()
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      res.json({
        ok: true,
        instancia: instance.toJSON()
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias/:id/vincular",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const vinculacion = await instance.startPairing();
      res.json({
        ok: true,
        ...vinculacion
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/vinculacion",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);

      if (!instance.pairingCode) {
        return res.status(404).json({
          ok: false,
          error: "No hay un codigo de vinculacion activo",
          instancia: instance.record.id,
          estado: instance.status
        });
      }

      res.json({
        ok: true,
        instancia: instance.record.id,
        numero: instance.record.numero,
        codigo: instance.pairingCode,
        estado: instance.status
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias/:id/reconectar",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const vinculacion = await instance.startPairing();
      res.json({
        ok: true,
        ...vinculacion
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/grupos",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const grupos = await instance.getGroups();
      res.json({
        ok: true,
        instancia: instance.record.id,
        grupos
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/mensajes-hoy",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      res.json({
        ok: true,
        ...instance.getMessagesToday()
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/mensajes",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      res.json({
        ok: true,
        ...instance.getMessages({
          from: req.query.desde,
          to: req.query.hasta
        })
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias/:id/analizar-bandeja",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const analysis = await instance.analyzeInbox({
        from: req.body?.desde,
        to: req.body?.hasta,
        model: req.body?.modelo
      });
      res.json({
        ok: true,
        ...analysis
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/prompt-analista",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      res.json({ ok: true, ...instance.getInboxAnalystPrompt() });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  "/instancias/:id/prompt-analista",
  requireMultiInstanceMode,
  (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      res.json({
        ok: true,
        ...instance.saveInboxAnalystPrompt(req.body?.prompt)
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/instancias/:id/grupos/:groupId",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const grupo = await instance.getGroupDetails(req.params.groupId);
      res.json({
        ok: true,
        instancia: instance.record.id,
        grupo
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias/:id/enviar-sync",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      validatePayload(req.body);
      const instance = whatsappManager.requireInstance(req.params.id);
      const result = await instance.sendBatch(getSendPayload(req.body));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/instancias/:id/enviar",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      validatePayload(req.body);
      const instance = whatsappManager.requireInstance(req.params.id);
      instance.ensureConnected();
      const job = instance.enqueueBatch(getSendPayload(req.body));

      res.status(202).json({
        ok: true,
        canal: "whatsapp",
        instancia: instance.record.id,
        procesando: true,
        jobId: job.jobId,
        estado: job.estado
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/instancias/:id",
  requireMultiInstanceMode,
  async (req, res, next) => {
    try {
      const instance = whatsappManager.requireInstance(req.params.id);
      const id = instance.record.id;
      await whatsappManager.deleteInstance(id);
      res.json({
        ok: true,
        instancia: id,
        eliminada: true
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
