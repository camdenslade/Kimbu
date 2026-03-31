import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  keyGenerator?: (req: Request) => string; // Custom key generator
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  use(req: Request, res: Response, next: NextFunction) {
    next();
  }
}

export class RateLimitService {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async checkLimit(
    key: string,
    config: RateLimitConfig,
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
  }> {
    const current = await this.cacheManager.get<number>(key);
    const attempts = current ? current + 1 : 1;

    if (attempts > config.maxRequests) {
      const resetTime = Math.ceil(config.windowMs / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime,
      };
    }

    // Set or update the counter with TTL
    await this.cacheManager.set(key, attempts, Math.floor(config.windowMs));

    return {
      allowed: true,
      remaining: config.maxRequests - attempts,
      resetTime: Math.ceil(config.windowMs / 1000),
    };
  }

  createKeyGenerator(prefix: string) {
    return (req: Request) => {
      const identifier = req.user?.sub || req.ip || req.headers['x-forwarded-for'] || 'unknown';
      return `${prefix}:${identifier}`;
    };
  }
}

export const loginRateLimitConfig: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5,
};

export const otpRateLimitConfig: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 3,
};

export const refreshTokenRateLimitConfig: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10,
};

export const apiRateLimitConfig: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
};
