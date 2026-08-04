const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const {
  GeminiConversationStore
} = require("../services/geminiConversationStore");

test("persiste y avanza una conversacion de Gemini", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gemini-chat-")
  );
  const databaseFile = path.join(temporaryRoot, "conversations.sqlite");
  let store = new GeminiConversationStore({ databaseFile, ttlHours: 1 });
  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const created = store.create({
    latestInteractionId: "interaction-1",
    modelName: "gemini-3.6-flash",
    requestedModelName: "gemini-3.6-flash",
    catalogStoreName: "fileSearchStores/articulos",
    fileSearchStoreNames: ["fileSearchStores/manuales"],
    formatoRespuesta: "json",
    esquemaRespuesta: {
      type: "object",
      properties: { articulos: { type: "array", items: { type: "string" } } },
      required: ["articulos"]
    }
  });
  store.close();
  store = new GeminiConversationStore({ databaseFile, ttlHours: 1 });

  const persisted = store.get(created.chatId);
  assert.equal(persisted.latestInteractionId, "interaction-1");
  assert.equal(persisted.catalogStoreName, "fileSearchStores/articulos");
  assert.deepEqual(persisted.esquemaRespuesta.required, ["articulos"]);

  const advanced = store.advance(
    created.chatId,
    "interaction-1",
    "interaction-2",
    "gemini-3.6-flash"
  );
  assert.equal(advanced.latestInteractionId, "interaction-2");
});

test("rechaza un chatId invalido", () => {
  assert.throws(
    () => {
      const temporaryStore = new GeminiConversationStore({
        databaseFile: ":memory:"
      });
      try {
        temporaryStore.get("invalido");
      } finally {
        temporaryStore.close();
      }
    },
    (error) => error.code === "CHAT_ID_INVALIDO"
  );
});

test("migra conversaciones existentes para persistir el esquema", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gemini-chat-legacy-")
  );
  const databaseFile = path.join(temporaryRoot, "conversations.sqlite");
  const legacyDatabase = new Database(databaseFile);
  legacyDatabase.exec(`
    CREATE TABLE gemini_conversations (
      chat_id TEXT PRIMARY KEY,
      latest_interaction_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      requested_model_name TEXT NOT NULL,
      catalog_store_name TEXT,
      file_search_stores_json TEXT NOT NULL,
      response_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  legacyDatabase.close();

  const store = new GeminiConversationStore({ databaseFile });
  t.after(() => {
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const columnas = store.database
    .prepare("PRAGMA table_info(gemini_conversations)")
    .all()
    .map((columna) => columna.name);
  assert.ok(columnas.includes("response_schema_json"));
});
