function errorResponses(...statuses) {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description: {
          400: 'Bad request',
          401: 'Unauthorized',
          404: 'Not found',
          429: 'Session capacity reached',
          500: 'Internal server error',
        }[status],
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
    ]),
  );
}

const sessionIdParameter = {
  name: 'sessionId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Managed session id returned by POST /sessions.',
};

const targetIdParameter = {
  name: 'targetId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Chrome DevTools Protocol target id within the managed session.',
};

const newTargetUrlParameter = {
  name: 'url',
  in: 'query',
  required: false,
  schema: { type: 'string', format: 'uri-reference' },
  description: 'Initial URL for the new target. Defaults to the configured browser start URL.',
};

const bearerSecurity = [{ BearerAuth: [] }];

export function buildOpenApiDocument(config = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'chrome-novnc-cdp Managed CDP API',
      version: '1.0.0',
      description: [
        'Documents the public managed CDP/session API exposed on the service port.',
        'WebSocket payloads use the Chrome DevTools Protocol.',
        'Bearer auth is required only when CDP_AUTH_TOKEN is set.',
        'Query-token auth is intentionally not modeled because bearer auth is preferred.',
      ].join(' '),
    },
    servers: [{ url: config.publicBasePath || '/' }],
    tags: [
      { name: 'Discovery' },
      { name: 'Health' },
      { name: 'Sessions' },
      { name: 'Compatibility' },
    ],
    paths: {
      '/openapi.json': {
        get: {
          tags: ['Discovery'],
          summary: 'Get this OpenAPI document',
          security: [],
          responses: {
            200: {
              description: 'OpenAPI document for the managed API.',
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: true },
                },
              },
            },
            ...errorResponses(500),
          },
        },
      },
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Check whether the session manager is reachable',
          security: [],
          responses: {
            200: {
              description: 'Session manager health.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
            ...errorResponses(500),
          },
        },
      },
      '/readyz': {
        get: {
          tags: ['Health'],
          summary: 'Check current Chromium and session readiness',
          security: [],
          responses: {
            200: {
              description: 'Readiness state. This does not start Chromium.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReadyResponse' },
                },
              },
            },
            ...errorResponses(500),
          },
        },
      },
      '/sessions': {
        post: {
          tags: ['Sessions'],
          summary: 'Create a managed browser session',
          security: bearerSecurity,
          responses: {
            201: {
              description: 'Created managed session.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionDetail' },
                },
              },
            },
            ...errorResponses(401, 429, 500),
          },
        },
        get: {
          tags: ['Sessions'],
          summary: 'List managed sessions',
          security: bearerSecurity,
          responses: {
            200: {
              description: 'Managed session summaries.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/SessionSummary' },
                  },
                },
              },
            },
            ...errorResponses(401, 500),
          },
        },
      },
      '/sessions/{sessionId}': {
        get: {
          tags: ['Sessions'],
          summary: 'Get a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter],
          responses: {
            200: {
              description: 'Managed session detail.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionDetail' },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
        delete: {
          tags: ['Sessions'],
          summary: 'Delete a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter],
          responses: {
            200: {
              description: 'Session deleted.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean' } },
                    additionalProperties: false,
                  },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
      },
      '/sessions/{sessionId}/json/version': {
        get: {
          tags: ['Sessions'],
          summary: 'Get version metadata for a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter],
          responses: {
            200: {
              description: 'Chromium version metadata with managed WebSocket URL.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/VersionResponse' },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
      },
      '/sessions/{sessionId}/json/list': {
        get: {
          tags: ['Sessions'],
          summary: 'List targets in a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter],
          responses: {
            200: {
              description: 'Targets belonging to the managed session.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Target' },
                  },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
      },
      '/sessions/{sessionId}/json/new': {
        put: {
          tags: ['Sessions'],
          summary: 'Create a target in a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter, newTargetUrlParameter],
          responses: {
            200: {
              description: 'Created target.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Target' },
                },
              },
            },
            ...errorResponses(400, 401, 404, 500),
          },
        },
      },
      '/sessions/{sessionId}/json/close/{targetId}': {
        delete: {
          tags: ['Sessions'],
          summary: 'Close a target in a managed session',
          security: bearerSecurity,
          parameters: [sessionIdParameter, targetIdParameter],
          responses: {
            200: {
              description: 'Target closed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean' } },
                    additionalProperties: false,
                  },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
      },
      '/sessions/{sessionId}/cdp': {
        get: {
          tags: ['Sessions'],
          summary: 'Connect to the managed session CDP WebSocket',
          description: 'HTTP upgrade endpoint. After the 101 response, messages use the Chrome DevTools Protocol.',
          security: bearerSecurity,
          parameters: [sessionIdParameter],
          responses: {
            101: { description: 'WebSocket upgrade accepted.' },
            ...errorResponses(400, 401, 404, 500),
          },
        },
      },
      '/json/version': {
        get: {
          tags: ['Compatibility'],
          summary: 'Get compatibility version metadata',
          security: bearerSecurity,
          responses: {
            200: {
              description: 'Compatibility version metadata with managed WebSocket URL.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/VersionResponse' },
                },
              },
            },
            ...errorResponses(401, 500),
          },
        },
      },
      '/json/list': {
        get: {
          tags: ['Compatibility'],
          summary: 'List compatibility session targets',
          security: bearerSecurity,
          responses: {
            200: {
              description: 'Targets belonging to the compatibility session, or an empty list before it exists.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Target' },
                  },
                },
              },
            },
            ...errorResponses(401, 500),
          },
        },
      },
      '/json/new': {
        put: {
          tags: ['Compatibility'],
          summary: 'Create a target in the compatibility session',
          security: bearerSecurity,
          parameters: [newTargetUrlParameter],
          responses: {
            200: {
              description: 'Created target.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Target' },
                },
              },
            },
            ...errorResponses(400, 401, 429, 500),
          },
        },
      },
      '/json/close/{targetId}': {
        delete: {
          tags: ['Compatibility'],
          summary: 'Close a target in the compatibility session',
          security: bearerSecurity,
          parameters: [targetIdParameter],
          responses: {
            200: {
              description: 'Target closed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean' } },
                    additionalProperties: false,
                  },
                },
              },
            },
            ...errorResponses(401, 404, 500),
          },
        },
      },
      '/devtools/browser/compat': {
        get: {
          tags: ['Compatibility'],
          summary: 'Connect to the compatibility CDP WebSocket',
          description: 'HTTP upgrade endpoint. It lazily creates one managed compatibility session when enabled and capacity is available.',
          security: bearerSecurity,
          responses: {
            101: { description: 'WebSocket upgrade accepted.' },
            ...errorResponses(400, 401, 404, 429, 500),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Send Authorization: Bearer <token> when CDP_AUTH_TOKEN is set. Query-token auth is intentionally not modeled as the preferred auth method.',
        },
      },
      schemas: {
        HealthResponse: {
          type: 'object',
          required: ['ok', 'service', 'sessions'],
          properties: {
            ok: { type: 'boolean' },
            service: { type: 'string', const: 'managed-cdp' },
            sessions: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
        ReadyResponse: {
          type: 'object',
          required: ['ok', 'chrome', 'sessions'],
          properties: {
            ok: { type: 'boolean' },
            chrome: { type: 'boolean' },
            sessions: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
        SessionSummary: {
          type: 'object',
          required: [
            'id',
            'state',
            'mode',
            'createdAt',
            'lastActivityAt',
            'idleExpiresAt',
            'activeConnections',
            'ttlPolicy',
          ],
          properties: {
            id: { type: 'string' },
            state: { type: 'string' },
            mode: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            lastActivityAt: { type: 'string', format: 'date-time' },
            idleExpiresAt: { type: 'string', format: 'date-time' },
            activeConnections: { type: 'integer', minimum: 0 },
            ttlPolicy: { type: 'string' },
          },
          additionalProperties: false,
        },
        SessionDetail: {
          type: 'object',
          required: [
            'id',
            'state',
            'mode',
            'createdAt',
            'lastActivityAt',
            'idleExpiresAt',
            'activeConnections',
            'ttlPolicy',
            'links',
          ],
          properties: {
            id: { type: 'string' },
            state: { type: 'string' },
            mode: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            lastActivityAt: { type: 'string', format: 'date-time' },
            idleExpiresAt: { type: 'string', format: 'date-time' },
            activeConnections: { type: 'integer', minimum: 0 },
            ttlPolicy: { type: 'string' },
            links: { $ref: '#/components/schemas/SessionLinks' },
          },
          additionalProperties: false,
        },
        SessionLinks: {
          type: 'object',
          required: ['cdp', 'version', 'list'],
          properties: {
            cdp: { type: 'string' },
            version: { type: 'string' },
            list: { type: 'string' },
          },
          additionalProperties: false,
        },
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        VersionResponse: {
          type: 'object',
          properties: {
            Browser: { type: 'string' },
            'Protocol-Version': { type: 'string' },
            'User-Agent': { type: 'string' },
            'V8-Version': { type: 'string' },
            'WebKit-Version': { type: 'string' },
            webSocketDebuggerUrl: { type: 'string' },
          },
          additionalProperties: true,
        },
        Target: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            webSocketDebuggerUrl: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
  };
}
