const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MODEL,
  GeminiService
} = require("../services/geminiService");

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  };
}

test("usa Gemini 3.6 Flash como modelo general predeterminado", () => {
  const service = new GeminiService({ apiKey: "clave-de-prueba" });

  assert.equal(DEFAULT_MODEL, "gemini-3.6-flash");
  assert.equal(service.getStatus().modelo, "gemini-3.6-flash");
});

test("envia instrucciones, contenido, datos y PDF a Gemini", async () => {
  let receivedRequest;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-test",
    fetchImpl: async (url, options) => {
      receivedRequest = {
        url,
        headers: options.headers,
        body: JSON.parse(options.body)
      };
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "Documento procesado" }]
            }
          }
        ],
        modelVersion: "gemini-test-001",
        usageMetadata: { totalTokenCount: 42 }
      });
    }
  });

  const response = await service.process({
    instrucciones: "Resume el documento",
    contenido: "2 reflectores\n5 cables",
    datos: { sistema: "presupuestacion" },
    archivos: [
      {
        mimetype: "application/pdf",
        buffer: Buffer.from("PDF de prueba")
      }
    ]
  });

  assert.match(receivedRequest.url, /gemini-test:generateContent$/);
  assert.equal(receivedRequest.headers["x-goog-api-key"], "clave-de-prueba");
  assert.match(
    receivedRequest.body.contents[0].parts[0].text,
    /Resume el documento/
  );
  assert.match(
    receivedRequest.body.contents[0].parts[1].text,
    /2 reflectores/
  );
  assert.match(
    receivedRequest.body.contents[0].parts[2].text,
    /presupuestacion/
  );
  assert.equal(
    receivedRequest.body.contents[0].parts[3].inlineData.mimeType,
    "application/pdf"
  );
  assert.equal(response.resultado, "Documento procesado");
  assert.equal(response.modelo, "gemini-test-001");
});

test("consulta el catalogo de File Search junto con el PDF", async () => {
  let receivedRequest;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-3.6-flash",
    fetchImpl: async (url, options) => {
      receivedRequest = JSON.parse(options.body);
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "TRI00012\tPLACA YESO\t95%"
                }
              ]
            }
          }
        ],
        modelVersion: "gemini-3.6-flash",
        usageMetadata: { totalTokenCount: 120 }
      });
    }
  });

  const response = await service.process({
    instrucciones: "Compara los articulos del PDF",
    archivos: [
      {
        mimetype: "application/pdf",
        buffer: Buffer.from("PDF de prueba")
      }
    ],
    catalogStoreName: "fileSearchStores/catalogo-prueba-123"
  });

  assert.deepEqual(receivedRequest.tools, [
    {
      fileSearch: {
        fileSearchStoreNames: [
          "fileSearchStores/catalogo-prueba-123"
        ]
      }
    }
  ]);
  assert.match(
    receivedRequest.contents[0].parts[0].text,
    /Consulta obligatoriamente ese catalogo/
  );
  assert.equal(response.catalogoUsado, true);
  assert.match(response.resultado, /TRI00012/);
});

test("consulta varios File Search Stores en una sola herramienta", async () => {
  let receivedRequest;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-3.5-flash-lite",
    fetchImpl: async (_url, options) => {
      receivedRequest = JSON.parse(options.body);
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "Informacion encontrada" }]
            }
          }
        ],
        modelVersion: "gemini-3.5-flash-lite"
      });
    }
  });

  const response = await service.process({
    instrucciones: "Busca en toda la biblioteca",
    fileSearchStoreNames: [
      "fileSearchStores/manuales",
      "fileSearchStores/contratos"
    ]
  });

  assert.deepEqual(receivedRequest.tools, [
    {
      fileSearch: {
        fileSearchStoreNames: [
          "fileSearchStores/manuales",
          "fileSearchStores/contratos"
        ]
      }
    }
  ]);
  assert.deepEqual(response.fileSearchStoresUsados, [
    "fileSearchStores/manuales",
    "fileSearchStores/contratos"
  ]);
});

test("inicia una conversacion y devuelve preguntas estructuradas", async () => {
  let receivedRequest;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-3.6-flash",
    fetchImpl: async (url, options) => {
      receivedRequest = { url, body: JSON.parse(options.body) };
      return jsonResponse({
        id: "interaction-primera",
        model: "gemini-3.6-flash",
        usage: {
          total_input_tokens: 120,
          total_output_tokens: 30,
          total_tokens: 150
        },
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  estado: "requiere_respuesta",
                  preguntas: ["¿El cable debe ser unipolar?"],
                  resultado: "",
                  calidad_respuestas: "no_aplica",
                  comentario_ia: "",
                  decisiones_tomadas: [],
                  advertencias: [],
                  requiere_revision_manual: false
                })
              }
            ]
          }
        ]
      });
    }
  });
  const conversationStore = {
    create: (input) => ({
      ...input,
      chatId: "11111111-1111-4111-8111-111111111111",
      expiraEn: "2026-08-02T00:00:00.000Z"
    })
  };

  const response = await service.processConversation({
    instrucciones: "Compara los articulos y pregunta si hay dudas",
    archivos: [
      {
        mimetype: "image/png",
        buffer: Buffer.from("imagen")
      }
    ],
    catalogStoreName: "fileSearchStores/articulos",
    conversationStore
  });

  assert.match(receivedRequest.url, /\/v1beta\/interactions$/);
  assert.equal(receivedRequest.body.store, true);
  assert.equal(receivedRequest.body.input[1].type, "image");
  assert.deepEqual(receivedRequest.body.tools, [
    {
      type: "file_search",
      file_search_store_names: ["fileSearchStores/articulos"]
    }
  ]);
  assert.equal(response.requiereRespuesta, true);
  assert.deepEqual(response.preguntas, ["¿El cable debe ser unipolar?"]);
  assert.equal(response.chatId, "11111111-1111-4111-8111-111111111111");
  assert.equal(response.uso.totalTokenCount, 150);
  assert.equal(response.uso.total_tokens, 150);
});

test("envia archivos TXT como contenido de texto en Interactions", async () => {
  let receivedRequest;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-3.6-flash",
    fetchImpl: async (_url, options) => {
      receivedRequest = JSON.parse(options.body);
      return jsonResponse({
        id: "interaction-texto",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  estado: "completado",
                  preguntas: [],
                  resultado: "Texto procesado",
                  calidad_respuestas: "no_aplica",
                  comentario_ia: "",
                  decisiones_tomadas: [],
                  advertencias: [],
                  requiere_revision_manual: false
                })
              }
            ]
          }
        ]
      });
    }
  });
  const conversationStore = {
    create: (input) => ({
      ...input,
      chatId: "44444444-4444-4444-8444-444444444444",
      expiraEn: "2026-08-02T00:00:00.000Z"
    })
  };

  await service.processConversation({
    instrucciones: "Analiza el archivo",
    archivos: [
      {
        originalname: "cotizacion.txt",
        mimetype: "text/plain",
        buffer: Buffer.from("10 unidades de cable")
      }
    ],
    conversationStore
  });

  assert.equal(receivedRequest.input[1].type, "text");
  assert.match(receivedRequest.input[1].text, /cotizacion\.txt/);
  assert.match(receivedRequest.input[1].text, /10 unidades de cable/);
  assert.equal(receivedRequest.input[1].mime_type, undefined);
});

test("continua una conversacion sin reenviar los archivos", async () => {
  let receivedRequest;
  let advanced;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    fetchImpl: async (_url, options) => {
      receivedRequest = JSON.parse(options.body);
      return jsonResponse({
        id: "interaction-segunda",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  estado: "completado",
                  preguntas: [],
                  resultado: "Comparacion final",
                  calidad_respuestas: "parciales",
                  comentario_ia:
                    "La seleccion considero la medida informada por el usuario.",
                  decisiones_tomadas: [
                    "Se compararon solamente cables unipolares de 2,5 mm."
                  ],
                  advertencias: [
                    "No se confirmo el color requerido."
                  ],
                  requiere_revision_manual: true
                })
              }
            ]
          }
        ]
      });
    }
  });
  const conversation = {
    chatId: "22222222-2222-4222-8222-222222222222",
    latestInteractionId: "interaction-primera",
    modelName: "gemini-3.6-flash",
    requestedModelName: "gemini-3.6-flash",
    catalogStoreName: "fileSearchStores/articulos",
    fileSearchStoreNames: [],
    formatoRespuesta: "texto"
  };
  const conversationStore = {
    get: () => conversation,
    advance: (...args) => {
      advanced = args;
      return {
        ...conversation,
        expiraEn: "2026-08-02T00:00:00.000Z"
      };
    }
  };

  const response = await service.processConversation({
    instrucciones: "Si, debe ser unipolar",
    chatId: conversation.chatId,
    conversationStore
  });

  assert.equal(
    receivedRequest.previous_interaction_id,
    "interaction-primera"
  );
  assert.equal(receivedRequest.input.length, 1);
  assert.deepEqual(advanced.slice(0, 3), [
    conversation.chatId,
    "interaction-primera",
    "interaction-segunda"
  ]);
  assert.equal(response.requiereRespuesta, false);
  assert.equal(response.resultado, "Comparacion final");
  assert.equal(response.calidadRespuestas, "parciales");
  assert.equal(response.requiereRevisionManual, true);
  assert.match(response.comentarioIa, /medida informada/);
  assert.equal(response.decisionesTomadas.length, 1);
});

test("conserva y aplica un esquema JSON durante toda la conversacion", async () => {
  const requests = [];
  const responses = [
    {
      id: "interaction-esquema-1",
      model: "gemini-3.6-flash",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                estado: "requiere_respuesta",
                preguntas: ["¿Que medida necesita?"],
                resultado: null,
                calidad_respuestas: "no_aplica",
                comentario_ia: "",
                decisiones_tomadas: [],
                advertencias: [],
                requiere_revision_manual: false
              })
            }
          ]
        }
      ]
    },
    {
      id: "interaction-esquema-2",
      model: "gemini-3.6-flash",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                estado: "completado",
                preguntas: [],
                resultado: {
                  articulos: [{ descripcion: "Cable 2,5 mm" }]
                },
                calidad_respuestas: "suficientes",
                comentario_ia: "Se uso la medida aclarada.",
                decisiones_tomadas: [],
                advertencias: [],
                requiere_revision_manual: false
              })
            }
          ]
        }
      ]
    }
  ];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    model: "gemini-3.6-flash",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse(responses.shift());
    }
  });
  const schema = {
    type: "object",
    properties: {
      articulos: {
        type: "array",
        items: {
          type: "object",
          properties: { descripcion: { type: "string" } },
          required: ["descripcion"],
          additionalProperties: false
        }
      }
    },
    required: ["articulos"],
    additionalProperties: false
  };
  let conversation;
  const conversationStore = {
    create: (input) => {
      conversation = {
        ...input,
        chatId: "55555555-5555-4555-8555-555555555555",
        expiraEn: "2026-08-03T00:00:00.000Z"
      };
      return conversation;
    },
    get: () => conversation,
    advance: (_chatId, _previousId, latestInteractionId, modelName) => {
      conversation = {
        ...conversation,
        latestInteractionId,
        modelName
      };
      return conversation;
    }
  };

  const first = await service.processConversation({
    instrucciones: "Compara los articulos",
    formatoRespuesta: "json",
    esquemaRespuesta: schema,
    conversationStore
  });
  const second = await service.processConversation({
    instrucciones: "La medida es 2,5 mm",
    chatId: first.chatId,
    conversationStore
  });

  assert.equal(first.requiereRespuesta, true);
  assert.deepEqual(conversation.esquemaRespuesta, schema);
  assert.deepEqual(
    requests[0].response_format.schema.properties.resultado.type,
    ["object", "null"]
  );
  assert.deepEqual(
    requests[1].response_format.schema.properties.resultado.properties,
    schema.properties
  );
  assert.equal(
    requests[1].previous_interaction_id,
    "interaction-esquema-1"
  );
  assert.deepEqual(second.resultado, {
    articulos: [{ descripcion: "Cable 2,5 mm" }]
  });
});

test("usa otro modelo File Search si el predeterminado esta saturado", async () => {
  const calledModels = [];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => [
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite"
      ]
    },
    fetchImpl: async (url) => {
      calledModels.push(url);
      if (url.includes("gemini-3.6-flash")) {
        return jsonResponse(
          {
            error: {
              message: "This model is currently experiencing high demand"
            }
          },
          503
        );
      }

      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "Catalogo consultado" }]
            }
          }
        ],
        modelVersion: "gemini-3.5-flash"
      });
    }
  });

  const response = await service.process({
    instrucciones: "Busca un articulo",
    catalogStoreName: "fileSearchStores/catalogo-prueba-123"
  });

  assert.equal(calledModels.length, 2);
  assert.match(calledModels[0], /gemini-3\.6-flash/);
  assert.match(calledModels[1], /gemini-3\.5-flash-lite/);
  assert.equal(response.modelo, "gemini-3.5-flash");
  assert.deepEqual(response.modelosIntentados, [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite"
  ]);
});

test("usa la prioridad central e ignora el modelo enviado por el cliente", async () => {
  const calledModels = [];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => [
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite"
      ]
    },
    fetchImpl: async (url) => {
      calledModels.push(url);
      if (url.includes("gemini-3.5-flash-lite")) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: "Catalogo consultado con fallback" }]
              }
            }
          ],
          modelVersion: "gemini-3.5-flash-lite"
        });
      }

      return jsonResponse({
        error: {
          message: "This model is currently experiencing high demand"
        }
      }, 503);
    }
  });

  const response = await service.process({
    instrucciones: "Busca un articulo",
    modelo: "gemini-modelo-enviado-por-cliente",
    catalogStoreName: "fileSearchStores/catalogo-prueba-123"
  });

  assert.equal(calledModels.length, 2);
  assert.match(calledModels[0], /gemini-3\.5-flash/);
  assert.match(calledModels[1], /gemini-3\.5-flash-lite/);
  assert.equal(response.modeloSolicitado, "gemini-3.5-flash");
  assert.equal(response.modelo, "gemini-3.5-flash-lite");
});

test("permite a un consumidor interno priorizar un modelo habilitado", async () => {
  const calledModels = [];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite"
      ]
    },
    fetchImpl: async (url) => {
      calledModels.push(url);
      if (url.includes("gemini-3.5-flash:generateContent")) {
        return jsonResponse({
          error: { message: "Resource exhausted: daily quota exceeded" }
        }, 429);
      }
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "Listo" }] } }]
      });
    }
  });

  const response = await service.process({
    instrucciones: "Analiza la bandeja",
    preferredModel: "gemini-3.5-flash"
  });

  assert.match(calledModels[0], /gemini-3\.5-flash:generateContent/);
  assert.match(calledModels[1], /gemini-3\.6-flash:generateContent/);
  assert.deepEqual(response.modelosIntentados, [
    "gemini-3.5-flash",
    "gemini-3.6-flash"
  ]);
});

test("rechaza la preferencia interna de un modelo no habilitado", async () => {
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => ["gemini-3.6-flash"]
    }
  });

  await assert.rejects(
    service.process({
      instrucciones: "Analiza la bandeja",
      preferredModel: "gemini-no-habilitado"
    }),
    (error) =>
      error.statusCode === 400 &&
      error.code === "GEMINI_MODELO_NO_HABILITADO"
  );
});

test("cambia de modelo por cuota diaria aun sin File Search", async () => {
  const calledModels = [];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => ["gemini-3.6-flash", "gemini-3.5-flash"]
    },
    fetchImpl: async (url) => {
      calledModels.push(url);
      if (url.includes("gemini-3.6-flash")) {
        return jsonResponse({
          error: {
            message: "Resource exhausted: quota exceeded for daily requests"
          }
        }, 429);
      }
      return jsonResponse({
        candidates: [{
          content: { parts: [{ text: "Procesado con fallback" }] }
        }],
        modelVersion: "gemini-3.5-flash"
      });
    }
  });

  const response = await service.process({
    instrucciones: "Procesa el pedido",
    modelo: "gemini-modelo-no-autorizado"
  });

  assert.equal(calledModels.length, 2);
  assert.match(calledModels[0], /gemini-3\.6-flash/);
  assert.match(calledModels[1], /gemini-3\.5-flash/);
  assert.equal(response.modeloSolicitado, "gemini-3.6-flash");
  assert.equal(response.modelo, "gemini-3.5-flash");
});

test("no cambia de modelo ante un error no recuperable", async () => {
  const calledModels = [];
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => ["gemini-3.6-flash", "gemini-3.5-flash"]
    },
    fetchImpl: async (url) => {
      calledModels.push(url);
      return jsonResponse({
        error: { message: "Invalid request payload" }
      }, 400);
    }
  });

  await assert.rejects(
    service.process({ instrucciones: "Solicitud invalida" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.modelosIntentados, ["gemini-3.6-flash"]);
      return true;
    }
  );
  assert.equal(calledModels.length, 1);
});

test("solicita y convierte una respuesta JSON estructurada", async () => {
  let receivedRequest;
  let receivedUrl;
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    modelConfigStore: {
      getModels: () => ["gemini-2.5-flash"]
    },
    fetchImpl: async (url, options) => {
      receivedUrl = url;
      receivedRequest = JSON.parse(options.body);
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text:
                    '{"articulos":[{"descripcion":"Cable","cantidad":10}]}'
                }
              ]
            }
          }
        ]
      });
    }
  });
  const schema = {
    type: "object",
    properties: {
      articulos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            descripcion: { type: "string" },
            cantidad: { type: "number" }
          },
          required: ["descripcion", "cantidad"]
        }
      }
    },
    required: ["articulos"]
  };

  const response = await service.process({
    instrucciones: "Extrae los articulos",
    formatoRespuesta: "json",
    esquemaRespuesta: schema,
    modelo: "gemini-2.5-flash"
  });

  assert.match(receivedUrl, /gemini-2\.5-flash:generateContent$/);
  assert.match(
    receivedRequest.contents[0].parts[0].text,
    /Extrae los articulos/
  );
  assert.equal(
    receivedRequest.generationConfig.responseMimeType,
    "application/json"
  );
  assert.deepEqual(
    receivedRequest.generationConfig.responseJsonSchema,
    schema
  );
  assert.equal(response.resultado.articulos[0].cantidad, 10);
});

test("lista solamente modelos Gemini compatibles con generateContent", async () => {
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    fetchImpl: async (url) => {
      assert.match(url, /\/v1beta\/models\?pageSize=1000$/);
      return jsonResponse({
        models: [
          {
            name: "models/gemini-2.5-flash",
            baseModelId: "gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ["generateContent"]
          },
          {
            name: "models/gemini-embedding-001",
            baseModelId: "gemini-embedding-001",
            displayName: "Gemini Embedding",
            supportedGenerationMethods: ["embedContent"]
          },
          {
            name: "models/gemini-2.5-flash-image",
            baseModelId: "gemini-2.5-flash-image",
            displayName: "Gemini 2.5 Flash Image",
            outputTokenLimit: 32768,
            supportedGenerationMethods: ["generateContent"]
          },
          {
            name: "models/gemini-3.1-flash-live",
            baseModelId: "gemini-3.1-flash-live",
            displayName: "Gemini 3.1 Flash Live",
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"]
          },
          {
            name: "models/gemini-omni-flash-preview",
            baseModelId: "gemini-omni-flash-preview",
            displayName: "Gemini Omni Flash Preview",
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"]
          }
        ]
      });
    }
  });

  const result = await service.listModels();

  assert.equal(result.modeloPredeterminado, "gemini-3.6-flash");
  assert.deepEqual(result.modelos, [
    {
      id: "gemini-2.5-flash",
      nombre: "Gemini 2.5 Flash",
      descripcion: "",
      tokensEntrada: 1048576,
      tokensSalida: 65536
    }
  ]);
});

test("no intenta llamar a Gemini cuando falta la clave", async () => {
  const service = new GeminiService({ apiKey: "" });

  await assert.rejects(
    service.process({ instrucciones: "Prueba" }),
    (error) =>
      error.statusCode === 503 &&
      error.code === "GEMINI_NO_CONFIGURADO"
  );
});

test("conserva el estado y la respuesta original de los errores de Gemini", async () => {
  const geminiResponse = {
    error: {
      code: 400,
      message: "API key not valid",
      status: "INVALID_ARGUMENT"
    }
  };
  const service = new GeminiService({
    apiKey: "clave-invalida",
    fetchImpl: async () =>
      jsonResponse(geminiResponse, 400)
  });

  await assert.rejects(
    service.process({ instrucciones: "Prueba" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "GEMINI_ERROR");
      assert.equal(error.isOperational, true);
      assert.equal(error.message, "API key not valid");
      assert.equal(error.geminiStatus, 400);
      assert.deepEqual(error.geminiResponse, geminiResponse);
      return true;
    }
  );
});

test("conserva el error original de Gemini en una conversacion", async () => {
  const message =
    "Model generated too many tool calls. Please retry the request.";
  const geminiResponse = {
    error: {
      code: 400,
      message,
      status: "INVALID_ARGUMENT"
    }
  };
  const service = new GeminiService({
    apiKey: "clave-de-prueba",
    fetchImpl: async () => jsonResponse(geminiResponse, 400)
  });

  await assert.rejects(
    service.processConversation({
      instrucciones: "Busca los articulos en el catalogo",
      catalogStoreName: "fileSearchStores/articulos",
      conversationStore: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "GEMINI_CHAT_ERROR");
      assert.equal(error.message, message);
      assert.equal(error.geminiStatus, 400);
      assert.deepEqual(error.geminiResponse, geminiResponse);
      return true;
    }
  );
});
