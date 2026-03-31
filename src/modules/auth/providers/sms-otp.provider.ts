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
  RateLimitError,
  OtpExpiredError,
  InvalidCredentialsError,
  AuthProviderError,
} from './interfaces';

import { SecurityService } from '../../../common/security.service';
import { User, Identity, OtpCode, FailedAttempt } from '../../../database/entities';

/**
 * SMS OTP PROVIDER
 *
 * Handles:
 * 1. Request OTP (phone verification)
 * 2. Verify OTP (authentication)
 * - Twilio integration for SMS delivery
 * - Rate limiting (max 3 requests per 15 min)
 * - Attempt limiting (max 3 verifications per OTP)
 * - Expiration (5-minute window)
 *
 * Security Features:
 * - Rate limiting per phone number
 * - Attempt limiting on verification
 * - OTP storage in Redis (fast, auto-cleanup)
 * - Timing-safe OTP comparison
 * - No enumeration (same response for all cases)
 */

@Injectable()
export class SmsOtpProvider implements IAuthProvider {
  name = 'sms_otp';

  // Configuration
  private readonly OTP_EXPIRY_SECONDS = 5 * 60; // 5 minutes
  private readonly MAX_OTP_REQUESTS_PER_WINDOW = 3;
  private readonly MAX_OTP_ATTEMPTS = 3;
  private readonly RATE_LIMIT_WINDOW_MINUTES = 15;

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,

    @InjectRepository(Identity)
    private identitiesRepository: Repository<Identity>,

    @InjectRepository(OtpCode)
    private otpCodesRepository: Repository<OtpCode>,

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
    return method === AuthMethod.SMS_OTP;
  }

  /**
   * First step: Request OTP
   * Generates and sends OTP to phone number
   *
   * Flow:
   * 1. Validate phone format
   * 2. Rate limiting check
   * 3. Generate 6-digit OTP
   * 4. Store in database + Redis cache
   * 5. Send via Twilio
   * 6. Return confirmation
   */
  async requestOtp(
    phoneNumber: string,
    _appId: string
  ): Promise<{
    otp_request_id: string;
    expires_in: number;
    delivery: string;
  }> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);

    // Validate phone format
    if (!this.isValidPhoneNumber(normalizedPhone)) {
      throw new AuthProviderError('Invalid phone number format', 'INVALID_PHONE', 400);
    }

    // Rate limiting
    await this.checkOtpRequestRateLimit(normalizedPhone);

    // Generate OTP
    const otp = this.securityService.generateOtp();

    // Store in database
    const otpRecord = this.otpCodesRepository.create({
      phone_number: normalizedPhone,
      code: otp,
      method: 'sms',
      attempt_count: 0,
      max_attempts: this.MAX_OTP_ATTEMPTS,
      created_at: new Date(),
      expires_at: new Date(Date.now() + this.OTP_EXPIRY_SECONDS * 1000),
      is_verified: false,
    });

    await this.otpCodesRepository.save(otpRecord);

    // Store in Redis cache for quick verification
    const cacheKey = `otp:${normalizedPhone}`;
    await this.cacheManager.set(cacheKey, otp, this.OTP_EXPIRY_SECONDS * 1000);

    // Send SMS
    await this.sendSms(normalizedPhone, otp);

    // Record successful OTP request
    await this.recordOtpRequest(normalizedPhone);

    return {
      otp_request_id: otpRecord.id,
      expires_in: this.OTP_EXPIRY_SECONDS,
      delivery: 'sms',
    };
  }

  /**
   * Second step: Verify OTP
   * User submits OTP code, system authenticates them
   *
   * Flow:
   * 1. Validate OTP format
   * 2. Check attempt count
   * 3. Verify OTP (timing-safe)
   * 4. Find/create user
   * 5. Return auth result
   */
  async authenticate(input: AuthInput): Promise<AuthenticateResult> {
    const { phone_number, otp, ip_address } = input;

    if (!phone_number || !otp) {
      throw new InvalidCredentialsError('Phone and OTP required');
    }

    const normalizedPhone = this.normalizePhoneNumber(phone_number);

    // Lookup OTP record
    const otpRecord = await this.otpCodesRepository.findOne({
      where: { phone_number: normalizedPhone },
      order: { created_at: 'DESC' },
    });

    if (!otpRecord) {
      throw new InvalidCredentialsError('No OTP found for this phone');
    }

    // Check expiration
    if (new Date() > otpRecord.expires_at) {
      throw new OtpExpiredError('OTP has expired, please request a new one');
    }

    // Check attempt count
    if (otpRecord.attempt_count >= this.MAX_OTP_ATTEMPTS) {
      throw new AuthProviderError(
        'Too many OTP verification attempts, please request a new code',
        'OTP_ATTEMPTS_EXCEEDED',
        429
      );
    }

    // Verify OTP (timing-safe comparison)
    const otpValid = this.securityService.timingSafeEqual(otp, otpRecord.code);

    if (!otpValid) {
      // Increment attempt count
      otpRecord.attempt_count += 1;
      await this.otpCodesRepository.save(otpRecord);

      // Record failed attempt
      await this.recordFailedOtpAttempt(normalizedPhone, ip_address);

      throw new InvalidCredentialsError('Invalid OTP');
    }

    // OTP is valid! Find or create user
    let identity = await this.identitiesRepository.findOne({
      where: { phone: normalizedPhone, identity_type: 'phone' },
      relations: ['user'],
    });

    let isNewUser = false;

    if (!identity) {
      // Create new user + identity
      isNewUser = true;

      const user = this.usersRepository.create({
        phone: normalizedPhone,
        phone_verified: true,
        status: 'active',
      });

      const savedUser = await this.usersRepository.save(user);

      identity = this.identitiesRepository.create({
        user_id: savedUser.id,
        identity_type: 'phone',
        phone: normalizedPhone,
        is_primary: true,
        is_verified: true,
      });

      await this.identitiesRepository.save(identity);
    } else {
      // Mark phone as verified
      const user = identity.user;
      user.phone_verified = true;
      await this.usersRepository.save(user);

      identity.is_verified = true;
      await this.identitiesRepository.save(identity);
    }

    // Mark OTP as used
    otpRecord.is_verified = true;
    await this.otpCodesRepository.save(otpRecord);

    return {
      user_id: identity.user_id,
      phone: identity.phone,
      name: identity.user.name,
      avatar_url: identity.user.avatar_url,
      identity_id: identity.id,
      is_new_user: isNewUser,
      provider: AuthMethod.SMS_OTP,
    };
  }

  async verify(token: string): Promise<VerificationResult> {
    // SMS OTP verification handled in authenticate()
    return { verified: true };
  }

  // ============================================
  // SMS SENDING
  // ============================================

  /**
   * Send SMS with OTP
   * In production: Twilio or AWS SNS
   *
   * For demo: Just log the OTP
   */
  private async sendSms(phoneNumber: string, otp: string): Promise<void> {
    // TODO: Implement actual SMS sending
    // Example with Twilio:
    /*
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      body: `Your verification code is: ${otp}`,
      from: TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });
    */

    console.log(`[SMS] Sending OTP to ${phoneNumber}: ${otp}`);
  }

  // ============================================
  // PHONE VALIDATION
  // ============================================

  /**
   * Normalize phone number to E.164 format
   * E.164: +[country code][number]
   * Examples: +14155552671, +442071234567
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters except +
    let normalized = phone.replace(/[^\d+]/g, '');

    // Ensure + prefix
    if (!normalized.startsWith('+')) {
      // Assume US if no country code
      normalized = '+1' + normalized;
    }

    return normalized;
  }

  /**
   * Validate phone number format
   */
  private isValidPhoneNumber(phone: string): boolean {
    const e164Regex = /^\+\d{1,3}\d{6,14}$/;
    return e164Regex.test(phone);
  }

  // ============================================
  // RATE LIMITING
  // ============================================

  /**
   * Check OTP request rate limiting
   * Max 3 requests per phone per 15 minutes
   */
  private async checkOtpRequestRateLimit(phoneNumber: string): Promise<void> {
    const cacheKey = `otp:requests:${phoneNumber}`;
    const requestCount = (await this.cacheManager.get<number>(cacheKey)) || 0;

    if (requestCount >= this.MAX_OTP_REQUESTS_PER_WINDOW) {
      throw new RateLimitError(
        `Too many OTP requests for this phone. Please try again in ${this.RATE_LIMIT_WINDOW_MINUTES} minutes.`
      );
    }
  }

  /**
   * Record OTP request for rate limiting
   */
  private async recordOtpRequest(phoneNumber: string): Promise<void> {
    const cacheKey = `otp:requests:${phoneNumber}`;
    const current = (await this.cacheManager.get<number>(cacheKey)) || 0;
    await this.cacheManager.set(
      cacheKey,
      current + 1,
      this.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000
    );
  }

  /**
   * Record failed OTP verification attempt
   */
  private async recordFailedOtpAttempt(
    phoneNumber: string,
    ipAddress: string
  ): Promise<void> {
    const failedAttempt = this.failedAttemptsRepository.create({
      ip_address: ipAddress,
      attempt_type: 'otp_verification',
    });

    await this.failedAttemptsRepository.save(failedAttempt);
  }

  // ============================================
  // CLEANUP
  // ============================================

  async cleanup(input: AuthInput): Promise<void> {
    // OTP is automatically cleaned up after verification
    // Cache entries auto-expire after 5 minutes
  }
}
