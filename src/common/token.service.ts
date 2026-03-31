import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SecurityService } from './security.service';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

/**
 * JWT & TOKEN SERVICE
 *
 * Manages:
 * - Access token generation/validation
 * - Refresh token generation/validation
 * - Token rotation
 * - JWT claims structure
 */

export interface JwtPayload {
  sub: string; // User ID
  app_id: string; // Tenant/App ID
  roles: string[]; // App-scoped roles
  device_id: string; // Device identifier (session tracking)
  iat: number; // Issued at
  exp: number; // Expiration
  jti: string; // JWT ID (unique, for revocation)
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number; // In seconds
}

@Injectable()
export class TokenService {
  // Token expiration times
  private readonly ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60; // 15 minutes
  private readonly REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

  constructor(
    private jwtService: JwtService,
    private securityService: SecurityService,
    private configService: ConfigService
  ) {}

  // ============================================
  // ACCESS TOKEN MANAGEMENT
  // ============================================

  /**
   * Generate new access token (short-lived JWT)
   *
   * Claims:
   * - sub: User ID
   * - app_id: Tenant context
   * - roles: User's roles in this app
   * - device_id: Session tracking
   * - jti: Token ID for revocation
   */
  generateAccessToken(
    userId: string,
    appId: string,
    roles: string[],
    deviceId: string
  ): string {
    const payload: JwtPayload = {
      sub: userId,
      app_id: appId,
      roles,
      device_id: deviceId,
      jti: uuidv4(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.ACCESS_TOKEN_EXPIRY_SECONDS,
    };

    return this.jwtService.sign(payload);
  }

  /**
   * Verify and decode access token
   * Throws error if invalid/expired
   */
  verifyAccessToken(token: string): JwtPayload {
    return this.jwtService.verify<JwtPayload>(token);
  }

  /**
   * Get access token expiry in seconds
   */
  getAccessTokenExpiry(): number {
    return this.ACCESS_TOKEN_EXPIRY_SECONDS;
  }

  // ============================================
  // REFRESH TOKEN MANAGEMENT
  // ============================================

  /**
   * Generate new refresh token
   * Returns raw token (to be hashed before storage)
   */
  generateRefreshToken(): string {
    return this.securityService.generateToken(64); // 512 bits
  }

  /**
   * Hash refresh token for database storage
   * Prevents compromise if database is breached
   */
  hashRefreshToken(token: string): string {
    return this.securityService.hashToken(token);
  }

  /**
   * Get refresh token expiry in seconds
   */
  getRefreshTokenExpiry(): number {
    return this.REFRESH_TOKEN_EXPIRY_SECONDS;
  }

  /**
   * Get refresh token expiry date
   */
  getRefreshTokenExpiryDate(): Date {
    const date = new Date();
    date.setSeconds(date.getSeconds() + this.REFRESH_TOKEN_EXPIRY_SECONDS);
    return date;
  }

  // ============================================
  // TOKEN ROTATION
  // ============================================

  /**
   * Rotate refresh token (OAuth2 best practice)
   *
   * Security model:
   * 1. Client stores refresh token (e.g., in secure HTTP-only cookie)
   * 2. Client sends refresh token to /auth/refresh
   * 3. Server verifies token against database hash
   * 4. Server issues NEW refresh token (returns to client)
   * 5. Server invalidates OLD refresh token
   * 6. Client must update stored token
   *
   * If old token is reused: Potential security breach (token theft)
   * - Can trigger re-authentication
   * - Can send security alert to user
   */
  rotateRefreshToken(
    oldTokenHash: string,
    newTokenHash: string,
    userId: string
  ): {
    new_token_hash: string;
    expires_at: Date;
  } {
    // In actual implementation:
    // 1. Mark oldTokenHash as revoked in database
    // 2. Store newTokenHash with expiry
    // 3. Log rotation event

    return {
      new_token_hash: newTokenHash,
      expires_at: this.getRefreshTokenExpiryDate(),
    };
  }

  // ============================================
  // TOKEN PAIR GENERATION
  // ============================================

  /**
   * Generate complete token pair (access + refresh)
   * Used during login or token refresh
   */
  generateTokenPair(
    userId: string,
    appId: string,
    roles: string[],
    deviceId: string
  ): {
    access_token: string;
    refresh_token: string;
    refresh_token_hash: string;
    expires_in: number;
  } {
    const accessToken = this.generateAccessToken(userId, appId, roles, deviceId);
    const refreshToken = this.generateRefreshToken();
    const refreshTokenHash = this.hashRefreshToken(refreshToken);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      refresh_token_hash: refreshTokenHash,
      expires_in: this.ACCESS_TOKEN_EXPIRY_SECONDS,
    };
  }

  // ============================================
  // VERIFICATION & VALIDATION
  // ============================================

  /**
   * Decode token without verification (see claims only)
   * Used for debugging/logging
   */
  decodeToken(token: string): JwtPayload {
    return this.jwtService.decode<JwtPayload>(token);
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(token: string): boolean {
    try {
      const payload = this.jwtService.decode<JwtPayload>(token);
      return payload.exp < Math.floor(Date.now() / 1000);
    } catch {
      return true;
    }
  }

  /**
   * Get remaining time until token expiry (seconds)
   */
  getTimeUntilExpiry(token: string): number {
    const payload = this.decodeToken(token);
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, payload.exp - now);
  }

  // ============================================
  // REVOCATION & BLACKLISTING
  // ============================================

  /**
   * Extract JWT ID (jti) from token
   * Used for revocation (can store in Redis blocklist)
   */
  getTokenId(token: string): string {
    const payload = this.decodeToken(token);
    return payload.jti;
  }

  /**
   * Build revocation key for Redis
   */
  buildRevocationKey(userId: string, jti: string): string {
    return `token:revoked:${userId}:${jti}`;
  }

  /**
   * Build session revocation key (logout all devices)
   */
  buildUserRevocationKey(userId: string): string {
    return `user:revoked:${userId}`;
  }
}
