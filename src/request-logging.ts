import type { FastifyInstance } from "fastify";

/**
 * Logs every HTTP request when the response is finished (method, path + query, status, duration).
 */
export function registerRequestLogging(app: FastifyInstance) {
  app.addHook("onResponse", (request, reply, done) => {
    const ms = Math.round(reply.elapsedTime ?? 0);
    request.log.info(
      `[endpoint] ${request.method} ${request.url} ${reply.statusCode} ${ms}ms`
    );
    done();
  });
}
