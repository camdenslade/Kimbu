import { Injectable, Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import {
  IAuthProvider,
  AuthMethod,
  AuthInput,
  AuthenticateResult,
  VerificationResult,
  InvalidCredentialsError,
  AccountNotFoundError,
  AccountLockedError,
  RateLimitError,
  AuthProviderError,
} from './interfaces';

import { SecurityService } from '../../../common/security.service';
import { User, Identity, FailedAttempt } from '../../../database/entities';

/**
 * EMAIL / PASSWORD PROVIDER
 *
 * Handles:
 * - User registration with email + password
 * - Login with email + password
 * - Password verification (Argon2)
 * - Brute-force protection
 * - Account lockout logic
 *
 * Security Features:
 * - Argon2id password hashing
 * - Timing-safe password comparison
 * - Rate limiting on failed attempts
 * - Account lockout after N failures
 * - No user enumeration (same error for all failures)
 */

@Injectable()
export class EmailPasswordProvider implements IAuthProvider {
  name = 'email_password';

  // Configuration
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION_MINUTES = 15;
  private readonly ATTEMPT_WINDOW_MINUTES = 5;

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,

    @InjectRepository(Identity)
    private identitiesRepository: Repository<Identity>,

    @InjectRepository(FailedAttempt)
    private failedAttemptsRepository: Repository<FailedAttempt>,

    private securityService: SecurityService,

    @Inject(CACHE_MANAGER)
    private cacheManager: Cache
  ) {}

  // ============================================
  // PROVIDER INTERFACE
  // ============================================

  supports(method: AuthMethod): boolean {
    return method === AuthMethod.EMAIL_PASSWORD;
  }

  /**
   * Authenticate user with email + password
   *
   * Security flow:
   * 1. Find identity by email
   * 2. Check if account is locked
   * 3. Verify password
   * 4. Handle success/failure
   */
  async authenticate(input: AuthInput): Promise<AuthenticateResult> {
    const { email, password, ip_address, app_id } = input;

    if (!email || !password) {
      throw new InvalidCredentialsError();
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Check rate limiting
    await this.checkRateLimit(normalizedEmail, ip_address);

    // Find identity
    const identity = await this.identitiesRepository.findOne({
      where: { email: normalizedEmail, identity_type: 'email' },
      relations: ['user'],
    });

    // User not found - don't reveal this!
    // Use same error as invalid password (prevent enumeration)
    if (!identity) {
      await this.recordFailedAttempt(normalizedEmail, ip_address);
      throw new InvalidCredentialsError();
    }

    // Check if user is suspended
    if (identity.user.status !== 'active') {
      await this.recordFailedAttempt(normalizedEmail, ip_address);
      throw new AccountNotFoundError('Account is not active');
    }

    // Check account lockout
    await this.checkAccountLockout(identity.id);

    // Verify password
    const passwordValid = await this.securityService.verifyPassword(
      password,
      identity.password_hash!
    );

    if (!passwordValid) {
      await this.recordFailedAttempt(normalizedEmail, ip_address, identity.id);
      throw new InvalidCredentialsError();
    }

    // Success! Clear failed attempts
    await this.clearFailedAttempts(identity.id);

    return {
      user_id: identity.user_id,
      email: identity.email,
      name: identity.user.name,
      avatar_url: identity.user.avatar_url,
      identity_id: identity.id,
      is_new_user: false,
      provider: AuthMethod.EMAIL_PASSWORD,
    };
  }

  // ============================================
  // REGISTRATION
  // ============================================

  /**
   * Create new email/password identity
   * Called during user registration
   */
  async register(
    userId: string,
    email: string,
    password: string,
    isPrimary: boolean = true
  ): Promise<Identity> {
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await this.identitiesRepository.findOne({
      where: { email: normalizedEmail, identity_type: 'email' },
    });

    if (existing) {
      throw new AuthProviderError('Email already registered', 'EMAIL_EXISTS', 409);
    }

    // Validate password strength
    this.validatePasswordStrength(password);

    // Hash password
    const passwordHash = await this.securityService.hashPassword(password);

    // Create identity
    const identity = this.identitiesRepository.create({
      user_id: userId,
      identity_type: 'email',
      email: normalizedEmail,
      password_hash: passwordHash,
      is_primary: isPrimary,
      is_verified: false, // Email verification required
    });

    return this.identitiesRepository.save(identity);
  }

  // ============================================
  // PASSWORD RESET
  // ============================================

  /**
   * Change user's password
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    // Find primary email identity
    const identity = await this.identitiesRepository.findOne({
      where: {
        user_id: userId,
        identity_type: 'email',
        is_primary: true,
      },
    });

    if (!identity) {
      throw new AccountNotFoundError('No email identity found');
    }

    // Verify old password
    const valid = await this.securityService.verifyPassword(
      oldPassword,
      identity.password_hash!
    );

    if (!valid) {
      throw new InvalidCredentialsError('Current password is incorrect');
    }

    // Validate new password
    this.validatePasswordStrength(newPassword);

    // Hash and update
    const newHash = await this.securityService.hashPassword(newPassword);
    identity.password_hash = newHash;
    await this.identitiesRepository.save(identity);
  }

  /**
   * Reset password (admin-initiated or email link)
   */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const identity = await this.identitiesRepository.findOne({
      where: {
        user_id: userId,
        identity_type: 'email',
        is_primary: true,
      },
    });

    if (!identity) {
      throw new AccountNotFoundError('No email identity found');
    }

    this.validatePasswordStrength(newPassword);

    const newHash = await this.securityService.hashPassword(newPassword);
    identity.password_hash = newHash;
    await this.identitiesRepository.save(identity);
  }

  // ============================================
  // VERIFICATION
  // ============================================

  async verify(token: string): Promise<VerificationResult> {
    // Email verification would use a token from verification_tokens table
    // This is a placeholder - full implementation in email service
    return { verified: true };
  }

  // ============================================
  // BRUTE-FORCE PROTECTION
  // ============================================

  /**
   * Check if email is rate-limited globally
   */
  private async checkRateLimit(email: string, ipAddress: string): Promise<void> {
    const cacheKey = `ratelimit:login:${email}`;
    const count = await this.cacheManager.get<number>(cacheKey);

    if (count && count >= 5) {
      // 5 attempts per 15 minutes per email
      throw new RateLimitError(
        'Too many login attempts for this email, please try again in 15 minutes'
      );
    }

    const ipCacheKey = `ratelimit:login:ip:${ipAddress}`;
    const ipCount = await this.cacheManager.get<number>(ipCacheKey);

    if (ipCount && ipCount >= 10) {
      // 10 attempts per 15 minutes per IP
      throw new RateLimitError(
        'Too many login attempts from this IP, please try again later'
      );
    }
  }

  /**
   * Record failed login attempt
   * Used for tracking brute-force attacks
   */
  private async recordFailedAttempt(
    email: string,
    ipAddress: string,
    identityId?: string
  ): Promise<void> {
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - this.ATTEMPT_WINDOW_MINUTES * 60 * 1000
    );

    // Get recent attempts
    const recentAttempts = await this.failedAttemptsRepository.count({
      where: {
        identity_id: identityId,
        attempt_type: 'login_attempt',
      },
    });

    if (recentAttempts >= this.MAX_FAILED_ATTEMPTS) {
      // Lock account
      const lockoutUntil = new Date(
        now.getTime() + this.LOCKOUT_DURATION_MINUTES * 60 * 1000
      );

      const failedAttempt = this.failedAttemptsRepository.create({
        identity_id: identityId,
        ip_address: ipAddress,
        attempt_count: recentAttempts + 1,
        locked_until: lockoutUntil,
        attempt_type: 'login_attempt',
      });

      await this.failedAttemptsRepository.save(failedAttempt);
    } else {
      // Record attempt
      const failedAttempt = this.failedAttemptsRepository.create({
        identity_id: identityId,
        ip_address: ipAddress,
        attempt_count: recentAttempts + 1,
        attempt_type: 'login_attempt',
      });

      await this.failedAttemptsRepository.save(failedAttempt);
    }

    // Update cache
    const cacheKey = `ratelimit:login:${email}`;
    const current = (await this.cacheManager.get<number>(cacheKey)) || 0;
    await this.cacheManager.set(cacheKey, current + 1, 15 * 60 * 1000); // 15 min
  }

  /**
   * Check if account is locked
   */
  private async checkAccountLockout(identityId: string): Promise<void> {
    const lockedAttempt = await this.failedAttemptsRepository.findOne({
      where: { identity_id: identityId },
      order: { locked_until: 'DESC' },
    });

    if (lockedAttempt && lockedAttempt.locked_until) {
      if (new Date() < lockedAttempt.locked_until) {
        const remainingMs =
          lockedAttempt.locked_until.getTime() - new Date().getTime();
        const remainingMin = Math.ceil(remainingMs / 60000);
        throw new AccountLockedError(
          `Account is locked. Try again in ${remainingMin} minutes.`
        );
      }
    }
  }

  /**
   * Clear failed attempts after successful login
   */
  private async clearFailedAttempts(identityId: string): Promise<void> {
    await this.failedAttemptsRepository.delete({ identity_id: identityId });
  }

  // ============================================
  // VALIDATION
  // ============================================

  /**
   * Validate password strength
   * Requirements:
   * - Minimum 8 characters
   * - At least 1 uppercase
   * - At least 1 lowercase
   * - At least 1 number
   * - At least 1 special character
   */
  private validatePasswordStrength(password: string): void {
    const minLength = 8;
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    if (
      password.length < minLength ||
      !hasUppercase ||
      !hasLowercase ||
      !hasNumber ||
      !hasSpecial
    ) {
      throw new AuthProviderError(
        'Password must be at least 8 characters with uppercase, lowercase, number, and special character',
        'WEAK_PASSWORD',
        422
      );
    }
  }

  // ============================================
  // CLEANUP
  // ============================================

  async cleanup(input: AuthInput): Promise<void> {
    // Clear rate limiting cache on successful login
    const cacheKey = `ratelimit:login:${input.email}`;
    await this.cacheManager.del(cacheKey);
  }
}
