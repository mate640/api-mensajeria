const express = require("express");
const path = require("path");

const { gmailService } = require("../services/gmailService");

const router = express.Router();

router.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "gmail-admin.html"));
});

router.get("/estado", (req, res) => {
  res.json({
    ok: true,
    ...gmailService.getStatus()
  });
});

router.get("/cuentas", (req, res, next) => {
  try {
    res.json({
      ok: true,
      cuentas: gmailService.listAccounts()
    });
  } catch (error) {
    next(error);
  }
});

router.get("/oauth/url", (req, res, next) => {
  try {
    const url = gmailService.buildAuthorizationUrl(
      req.query.identificacion,
      req.query.email
    );

    res.json({
      ok: true,
      identificacion: req.query.identificacion,
      url
    });
  } catch (error) {
    next(error);
  }
});

router.get("/oauth/iniciar", (req, res, next) => {
  try {
    const url = gmailService.buildAuthorizationUrl(
      req.query.identificacion,
      req.query.email,
      "/gmail/panel"
    );
    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

router.get("/oauth/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      const error = new Error(
        `Google no autorizo la cuenta: ${req.query.error_description || req.query.error}`
      );
      error.statusCode = 400;
      throw error;
    }

    const result = await gmailService.completeAuthorization({
      code: req.query.code,
      state: req.query.state
    });

    if (result.returnTo === "/gmail/panel") {
      const query = new URLSearchParams({
        alta: result.account.identificacion,
        email: result.account.email
      });
      return res.redirect(`/gmail/panel?${query}`);
    }

    res.json({
      ok: true,
      mensaje: "Cuenta Gmail vinculada",
      cuenta: result.account
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/cuentas/:identificacion", async (req, res, next) => {
  try {
    const result = await gmailService.removeAccount(req.params.identificacion);
    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/enviar", async (req, res, next) => {
  try {
    const result = await gmailService.sendEmail(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
