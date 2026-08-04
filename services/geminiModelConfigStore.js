const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite"
];
const MAX_CONFIGURED_MODELS = 20;

function configError(message, statusCode = 400, code = "MODELOS_CONFIG_INVALIDOS") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function normalizeConfiguredModel(value) {
  const model = String(value || "")
    .trim()
    .replace(/^models\//, "");
  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw configError("La lista contiene un modelo no valido");
  }
  return model;
}

function normalizeConfiguredModels(values) {
  if (!Array.isArray(values)) {
    throw configError("modelos debe ser un array ordenado");
  }
  if (!values.length) {
    throw configError("Configura al menos un modelo de Gemini");
  }
  if (values.length > MAX_CONFIGURED_MODELS) {
    throw configError(`Solo se pueden configurar hasta ${MAX_CONFIGURED_MODELS} modelos`);
  }
  return [...new Set(values.map(normalizeConfiguredModel))];
}

class GeminiModelConfigStore {
  constructor(options = {}) {
    this.file = options.file || path.join(
      __dirname,
      "..",
      "data",
      "gemini-models.json"
    );
    this.defaults = normalizeConfiguredModels(
      options.defaults || DEFAULT_GEMINI_MODELS
    );
    this.config = this.readConfig();
  }

  readConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        modelos: normalizeConfiguredModels(parsed.modelos),
        actualizadoEn: typeof parsed.actualizadoEn === "string"
          ? parsed.actualizadoEn
          : null
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(
          "[IA] No se pudo leer la configuracion de modelos; se usan los valores iniciales:",
          error.message
        );
      }
      return {
        modelos: [...this.defaults],
        actualizadoEn: null
      };
    }
  }

  getModels() {
    return [...this.config.modelos];
  }

  getStatus() {
    return {
      modelosConfigurados: this.getModels(),
      modeloPrincipal: this.config.modelos[0] || null,
      actualizadoEn: this.config.actualizadoEn
    };
  }

  async saveModels(values) {
    const modelos = normalizeConfiguredModels(values);
    const config = {
      modelos,
      actualizadoEn: new Date().toISOString()
    };
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const temporaryFile = path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    try {
      await fs.promises.writeFile(
        temporaryFile,
        `${JSON.stringify(config, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      await fs.promises.rename(temporaryFile, this.file);
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true }).catch(() => {});
      throw error;
    }
    this.config = config;
    return this.getStatus();
  }
}

const geminiModelConfigStore = new GeminiModelConfigStore();

module.exports = {
  DEFAULT_GEMINI_MODELS,
  GeminiModelConfigStore,
  MAX_CONFIGURED_MODELS,
  geminiModelConfigStore,
  normalizeConfiguredModel,
  normalizeConfiguredModels
};
