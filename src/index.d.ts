import type { IncomingMessage, ServerResponse } from 'node:http';

type Request = IncomingMessage & Record<string, any>;
type Response = ServerResponse & Record<string, any>;
type Next = (err?: unknown) => void;

export type Middleware = (req: Request, res: Response, next: Next) => void;

export interface DuplicateHandlerOptions {
  /** Return true to process a request normally (e.g. authenticated requests). */
  skip?: (req: Request) => boolean;
  /** Requests with the same key are duplicates. Default: method and URL. */
  key?: (req: Request) => string;
  /** Seconds after which a pending request is forgotten. Default: 30. */
  timeout?: number | string;
}

export function duplicateHandler(options?: DuplicateHandlerOptions): Middleware;

export interface ServiceLimiterOptions {
  /** Served from level 0. */
  essentialIdentities?: string[];
  /** Served only at level 100. */
  nonEssentialIdentities?: string[];
  /** Default: 0. */
  initialLevel?: number;
  /** Default: `req.identity`, else `req.hyperwatch.getIdentity()`. */
  getIdentity?: (
    req: Request
  ) => string | undefined | Promise<string | undefined>;
  /** Default: a 503 with `message`. */
  onLimited?: (req: Request, res: Response) => void;
  /** Body of the default 503. */
  message?: string;
}

export interface ServiceLimiter {
  (req: Request, res: Response, next: Next): Promise<void>;
  increaseServiceLevel(newLevel: number): void;
  getServiceLevel(): number;
}

export function serviceLimiter(options?: ServiceLimiterOptions): ServiceLimiter;
