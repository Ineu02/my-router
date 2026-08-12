/**
 * Public entry point for the API package.
 *
 * Tests and the CLI import from here rather than reaching into individual
 * modules, so the internal file layout stays free to change.
 */

export { buildServer, issueRouterKey, start, type BuildOptions, type BuiltServer } from './server.js';
export { RouterEngine, type RouteResult, type StreamRouteResult, type RouteRequestInput } from './engine.js';
export { registerPublicRoutes, type RouteDeps } from './routes.js';
export { registerAdminRoutes } from './admin.js';
export {
  MemoryRateLimitStore,
  authenticateRequest,
  checkRateLimit,
  clientIp,
  rateLimitIdentity,
  sendRouterError,
  type AuthResult,
  type RateLimitStore,
} from './auth.js';
export { startMockUpstream, type MockServerHandle } from './mock/server.js';
