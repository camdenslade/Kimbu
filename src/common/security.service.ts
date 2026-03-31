import { Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import * as crypto from 'crypto';

/**
 * SECURITY SERVICE
 *
 * Handles:
 * - Password hashing (Argon2)
 * - Token hashing
 * - OTP generation
 * - Encryption/decryption
 * - Token verification
 */

@Injectable()
export class SecurityService {
  // ============================================
  // PASSWORD HASHING (Argon2id)
  // ============================================

  /**
   * Hash password using Argon2id
   *
   * Parameters tuned for security without high CPU cost:
   * - time_cost: 3 iterations
   * - memory_cost: 65536 KB (64 MB)
   * - parallelism: 4 threads
   *
   * Security: Resistant to GPU/ASIC attacks, rainbow tables
   */
  async hashPassword(password: string): Promise<string> {
    return argon2Hash(password, {
      algorithm: Algorithm.Argon2id,
      timeCost: 3,
      memoryCost: 65536,
      parallelism: 4,
    });
  }

  /**
   * Verify password against hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      return await argon2Verify(hash, password);
    } catch (error) {
      return false;
    }
  }

  // ============================================
  // TOKEN HASHING
  // ============================================

  /**
   * Hash refresh token for storage
   * Prevents compromise if database is breached
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate a random token (for refresh tokens, password reset, etc.)
   */
  generateToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // ============================================
  // OTP GENERATION
  // ============================================

  /**
   * Generate 6-digit OTP
   * Used for SMS/Email verification
   */
  generateOtp(): string {
    const otp = Math.floor(Math.random() * 1000000);
    return otp.toString().padStart(6, '0');
  }

  /**
   * Generate time-based one-time password (TOTP)
   * For authenticator apps
   */
  generateTotp(secret: string, timeWindow: number = 0): string {
    const time = Math.floor(Date.now() / 30000) + timeWindow;
    const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'utf8'));
    hmac.update(Buffer.from(time.toString().padStart(16, '0'), 'utf8'));
    const digest = hmac.digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code =
      (digest[offset] & 0x7f) << 24 ||
      (digest[offset + 1] & 0xff) << 16 ||
      (digest[offset + 2] & 0xff) << 8 ||
      (digest[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
  }

  // ============================================
  // FINGERPRINTING
  // ============================================

  /**
   * Generate device fingerprint from request metadata
   * Used for session tracking and anomaly detection
   */
  generateFingerprint(
    userAgent: string,
    ipAddress: string,
    acceptLanguage?: string
  ): string {
    const data = `${userAgent}:${ipAddress}:${acceptLanguage || ''}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // ============================================
  // UUID GENERATION
  // ============================================

  /**
   * Generate UUID v4
   */
  generateUuid(): string {
    return crypto.randomUUID();
  }

  // ============================================
  // ENCRYPTION / DECRYPTION
  // ============================================

  /**
   * Encrypt sensitive data
   * Uses AES-256-GCM
   */
  encrypt(data: string, encryptionKey: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(encryptionKey, 'hex'),
      iv
    );

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encrypted: string, encryptionKey: string): string {
    const parts = encrypted.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(encryptionKey, 'hex'),
      iv
    );

    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  // ============================================
  // TIMING-SAFE COMPARISON
  // ============================================

  /**
   * Timing-safe string comparison
   * Prevents timing attacks on OTP/token verification
   */
  timingSafeEqual(a: string, b: string): boolean {
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}
